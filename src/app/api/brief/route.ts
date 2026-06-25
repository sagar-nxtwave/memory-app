import { NextRequest, NextResponse } from 'next/server'
import { and, eq, desc } from 'drizzle-orm'

export const maxDuration = 60
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { documents, spaceMembers, spaces, messages } from '@/lib/db/schema'
import { chat } from '@/lib/ai/provider'
import { briefMePrompt } from '@/lib/ai/prompts'

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const spaceId = req.nextUrl.searchParams.get('spaceId')
  if (!spaceId) return NextResponse.json({ error: 'spaceId required' }, { status: 400 })

  const [member] = await db
    .select()
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, session.user.id)))
    .limit(1)

  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })

  const [space] = await db.select({ name: spaces.name }).from(spaces).where(eq(spaces.id, spaceId)).limit(1)

  const readyDocs = await db
    .select({
      name: documents.name,
      summary: documents.summary,
      keyNumbers: documents.keyNumbers,
      risks: documents.risks,
      decisions: documents.decisions,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(and(eq(documents.spaceId, spaceId), eq(documents.status, 'ready')))
    .orderBy(desc(documents.createdAt))
    .limit(10)

  const userContent = 'Brief me on this project.'
  const assistantContent = readyDocs.length === 0
    ? 'No documents have been processed yet. Upload documents to generate a briefing.'
    : await (async () => {
        const docsContext = readyDocs
          .map(
            (d) =>
              `Document: ${d.name}\nSummary: ${d.summary ?? 'N/A'}\nKey Numbers: ${(d.keyNumbers ?? []).join(', ') || 'None'}\nRisks: ${(d.risks ?? []).join('; ') || 'None'}\nDecisions: ${(d.decisions ?? []).join('; ') || 'None'}`
          )
          .join('\n\n---\n\n')
        return chat(briefMePrompt(space?.name ?? 'this project'), docsContext)
      })()

  // Persist both messages so they survive a page refresh
  const [userMsg] = await db
    .insert(messages)
    .values({ spaceId, userId: session.user.id, role: 'user', content: userContent })
    .returning()

  const [assistantMsg] = await db
    .insert(messages)
    .values({ spaceId, userId: session.user.id, role: 'assistant', content: assistantContent })
    .returning()

  return NextResponse.json({ userMessage: userMsg, assistantMessage: assistantMsg })
}
