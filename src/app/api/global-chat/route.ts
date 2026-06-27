import { NextRequest, NextResponse } from 'next/server'
import { eq, desc } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { spaceMembers, spaces, globalMessages } from '@/lib/db/schema'
import { generateEmbedding, chatStream } from '@/lib/ai/provider'
import { globalChatPrompt, styleInstruction } from '@/lib/ai/prompts'
import { sanitizeForPrompt, truncateToTokenLimit } from '@/lib/utils/sanitize'

export const maxDuration = 60

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const history = await db
    .select({ id: globalMessages.id, role: globalMessages.role, content: globalMessages.content, createdAt: globalMessages.createdAt })
    .from(globalMessages)
    .where(eq(globalMessages.userId, session.user.id))
    .orderBy(globalMessages.createdAt)
    .limit(50)

  return NextResponse.json(history)
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { content, spaceIds: requestedIds, responseStyle } = await req.json()
  if (!content?.trim()) return NextResponse.json({ error: 'content required' }, { status: 400 })

  // Always fetch from DB — never trust client-supplied IDs without verification
  const userSpaces = await db
    .select({ spaceId: spaceMembers.spaceId, name: spaces.name })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaceMembers.spaceId, spaces.id))
    .where(eq(spaceMembers.userId, session.user.id))

  // Filter to requested spaces — only those the user actually owns
  const filteredSpaces =
    Array.isArray(requestedIds) && requestedIds.length > 0
      ? userSpaces.filter((s) => requestedIds.includes(s.spaceId))
      : userSpaces

  // Save user message immediately so it appears even if streaming fails
  const userId = session.user.id
  const [userMsg] = await db
    .insert(globalMessages)
    .values({ userId, role: 'user', content: content.trim() })
    .returning()

  const encoder = new TextEncoder()

  if (filteredSpaces.length === 0) {
    const msg = userSpaces.length === 0
      ? 'You have no project spaces yet. Create a space and upload documents to get started.'
      : 'No projects selected. Please select at least one project.'
    const [assistantMsg] = await db.insert(globalMessages).values({ userId, role: 'assistant', content: msg }).returning()
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'start', userMessageId: userMsg.id })}\n\n`))
        c.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', content: msg })}\n\n`))
        c.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', assistantMessageId: assistantMsg.id })}\n\n`))
        c.close()
      },
    })
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
  }

  const spaceIds = filteredSpaces.map((s) => s.spaceId)
  const spaceNames = filteredSpaces.map((s) => s.name).join(', ')

  let queryEmbedding: number[] = []
  try {
    queryEmbedding = await generateEmbedding(content)
  } catch {}

  let contextText = ''
  if (queryEmbedding.length > 0) {
    const embeddingStr = `[${queryEmbedding.join(',')}]`
    const spaceIdsSQL = sql.join(spaceIds.map((id) => sql`${id}::uuid`), sql`, `)
    const chunks = await db.execute(sql`
      SELECT dc.content, d.name as document_name, s.name as space_name
      FROM document_chunks dc
      INNER JOIN documents d ON d.id = dc.document_id
      INNER JOIN spaces s ON s.id = d.space_id
      WHERE d.space_id IN (${spaceIdsSQL})
        AND d.status = 'ready'
        AND dc.embedding IS NOT NULL
      ORDER BY dc.embedding <=> ${embeddingStr}::vector
      LIMIT 10
    `)
    contextText = (chunks as unknown as { content: string; document_name: string; space_name: string }[])
      .map((c) => `[${c.space_name} › ${c.document_name}]\n${c.content}`)
      .join('\n\n---\n\n')
  }

  // Read recent conversation history from DB (server-side — not trusting client)
  const recentHistory = await db
    .select({ role: globalMessages.role, content: globalMessages.content })
    .from(globalMessages)
    .where(eq(globalMessages.userId, userId))
    .orderBy(desc(globalMessages.createdAt))
    .limit(10)

  const conversationHistory = recentHistory
    .reverse()
    .slice(0, -1) // exclude the user message just saved
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

  const systemPrompt = `${globalChatPrompt()}
${styleInstruction(responseStyle)}

Searching across: ${spaceNames}

${contextText ? `Context from documents:\n\n${truncateToTokenLimit(contextText)}` : 'No documents found in the selected projects.'}`

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))

      try {
        send({ type: 'start', userMessageId: userMsg.id })

        let fullContent = ''
        for await (const chunk of chatStream(systemPrompt, sanitizeForPrompt(content), conversationHistory)) {
          fullContent += chunk
          send({ type: 'delta', content: chunk })
        }

        const [assistantMsg] = await db
          .insert(globalMessages)
          .values({ userId, role: 'assistant', content: fullContent || 'No response generated.' })
          .returning()

        send({ type: 'done', assistantMessageId: assistantMsg.id, userMessageId: userMsg.id })
      } catch (err) {
        console.error('[global-chat] Error:', err)
        try {
          const [assistantMsg] = await db
            .insert(globalMessages)
            .values({ userId, role: 'assistant', content: 'Something went wrong. Please try again.' })
            .returning()
          send({ type: 'error', message: 'Something went wrong. Please try again.', assistantMessageId: assistantMsg.id })
        } catch {}
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}
