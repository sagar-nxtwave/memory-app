import { NextRequest, NextResponse } from 'next/server'
import { and, eq, gt, desc } from 'drizzle-orm'

export const maxDuration = 60
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { documents, spaceMembers, spaces, spaceVisits, messages } from '@/lib/db/schema'
import { chat } from '@/lib/ai/provider'
import { catchMeUpPrompt } from '@/lib/ai/prompts'

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

  // Second-most-recent visit = the session before this one
  const visits = await db
    .select({ visitedAt: spaceVisits.visitedAt })
    .from(spaceVisits)
    .where(and(eq(spaceVisits.spaceId, spaceId), eq(spaceVisits.userId, session.user.id)))
    .orderBy(desc(spaceVisits.visitedAt))
    .limit(2)

  const lastVisit = visits[1]?.visitedAt ?? null

  const newDocs = lastVisit
    ? await db
        .select({
          name: documents.name,
          summary: documents.summary,
          keyNumbers: documents.keyNumbers,
          risks: documents.risks,
          decisions: documents.decisions,
          createdAt: documents.createdAt,
        })
        .from(documents)
        .where(and(eq(documents.spaceId, spaceId), eq(documents.status, 'ready'), gt(documents.createdAt, lastVisit)))
        .orderBy(desc(documents.createdAt))
    : []

  const sinceLabel = lastVisit
    ? new Date(lastVisit).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : 'the beginning'

  const userContent = 'What changed since my last visit?'
  const assistantContent = newDocs.length === 0
    ? `Nothing new since ${sinceLabel}. You're up to date.`
    : await (async () => {
        const context = newDocs
          .map(
            (d) =>
              `Document uploaded: ${d.name} (${new Date(d.createdAt).toLocaleDateString()})\nSummary: ${d.summary ?? 'N/A'}\nKey Numbers: ${(d.keyNumbers ?? []).join(', ') || 'None'}\nDecisions: ${(d.decisions ?? []).join('; ') || 'None'}\nRisks: ${(d.risks ?? []).join('; ') || 'None'}`
          )
          .join('\n\n---\n\n')
        return chat(catchMeUpPrompt(space?.name ?? 'this project', sinceLabel), context)
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
