import { NextRequest, NextResponse } from 'next/server'
import { and, eq, desc } from 'drizzle-orm'

export const maxDuration = 60
import { sql } from 'drizzle-orm'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { messages, spaceMembers, documentChunks, documents } from '@/lib/db/schema'
import { generateEmbedding, chat } from '@/lib/ai/provider'
import { chatPrompt } from '@/lib/ai/prompts'
import { sanitizeForPrompt, truncateToTokenLimit } from '@/lib/utils/sanitize'

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const spaceId = req.nextUrl.searchParams.get('spaceId')
  if (!spaceId) return NextResponse.json({ error: 'spaceId required' }, { status: 400 })

  const history = await db
    .select({ id: messages.id, role: messages.role, content: messages.content, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.spaceId, spaceId))
    .orderBy(messages.createdAt)
    .limit(50)

  return NextResponse.json(history)
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { spaceId, content, spaceName } = await req.json()

  if (!spaceId || !content?.trim()) {
    return NextResponse.json({ error: 'spaceId and content are required' }, { status: 400 })
  }

  const [member] = await db
    .select()
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, session.user.id)))
    .limit(1)

  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })

  // Save user message
  const [userMsg] = await db
    .insert(messages)
    .values({ spaceId, userId: session.user.id, role: 'user', content: content.trim() })
    .returning()

  // RAG: embed query → find similar chunks (fall back gracefully if embedding fails)
  let queryEmbedding: number[] = []
  try {
    queryEmbedding = await generateEmbedding(content)
  } catch (err) {
    console.error('[chat] Embedding failed, proceeding without RAG:', err)
  }

  const embeddingStr = `[${queryEmbedding.join(',')}]`

  const relevantChunks = queryEmbedding.length === 0 ? [] : await db.execute(sql`
    SELECT dc.content, d.name as document_name
    FROM document_chunks dc
    INNER JOIN documents d ON d.id = dc.document_id
    WHERE d.space_id = ${spaceId}
      AND d.status = 'ready'
      AND dc.embedding IS NOT NULL
    ORDER BY dc.embedding <=> ${embeddingStr}::vector
    LIMIT 6
  `)

  // Build context from chunks
  const context = (relevantChunks as unknown as { content: string; document_name: string }[])
    .map((c) => `[From: ${c.document_name}]\n${c.content}`)
    .join('\n\n---\n\n')

  // Get recent conversation history (both user + assistant turns)
  const recentHistory = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(and(eq(messages.spaceId, spaceId)))
    .orderBy(desc(messages.createdAt))
    .limit(10)

  const systemPrompt = `${chatPrompt(spaceName ?? 'this project')}

${context ? `Context from project documents:\n\n${truncateToTokenLimit(context)}` : 'No documents have been uploaded to this space yet.'}`

  // Reverse to chronological order, exclude the user message just saved (last item after reverse)
  const history = recentHistory
    .reverse()
    .slice(0, -1)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

  let responseText: string
  try {
    responseText = await chat(systemPrompt, sanitizeForPrompt(content), history)
  } catch (err) {
    console.error('[chat] AI call failed:', err)
    // Save a fallback assistant message so the user message isn't orphaned
    const [assistantMsg] = await db
      .insert(messages)
      .values({ spaceId, userId: session.user.id, role: 'assistant', content: 'I encountered an error processing your request. Please try again.' })
      .returning()
    return NextResponse.json({ userMessage: userMsg, assistantMessage: assistantMsg })
  }

  // Save assistant message
  const [assistantMsg] = await db
    .insert(messages)
    .values({ spaceId, userId: session.user.id, role: 'assistant', content: responseText })
    .returning()

  return NextResponse.json({ userMessage: userMsg, assistantMessage: assistantMsg })
}
