import { NextRequest, NextResponse } from 'next/server'
import { and, eq, gt, desc } from 'drizzle-orm'

export const maxDuration = 60
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { documents, spaceVisits, messages } from '@/lib/db/schema'
import { chatStream } from '@/lib/ai/provider'
import { catchMeUpPrompt, styleInstruction } from '@/lib/ai/prompts'
import { formatDateTime } from '@/lib/utils/date'
import { checkSpaceAccess } from '@/lib/api/checkSpaceAccess'

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { spaceId, responseStyle, spaceName } = await req.json()
  if (!spaceId) return NextResponse.json({ error: 'spaceId required' }, { status: 400 })

  const allowed = await checkSpaceAccess(spaceId, session.user.id)
  if (!allowed) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })

  const space = { name: spaceName as string | undefined }

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
    ? formatDateTime(lastVisit, { long: true })
    : 'the beginning'

  const userContent = 'What changed since my last visit?'
  const userId = session.user.id

  const [userMsg] = await db
    .insert(messages)
    .values({ spaceId, userId, role: 'user', content: userContent })
    .returning()

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))

      try {
        send({ type: 'start', userMessageId: userMsg.id })

        let fullContent = ''

        if (newDocs.length === 0) {
          fullContent = `Nothing new since ${sinceLabel}. You're up to date.`
          send({ type: 'delta', content: fullContent })
        } else {
          const context = newDocs
            .map(
              (d) =>
                `Document uploaded: ${d.name} (${formatDateTime(d.createdAt)})\nSummary: ${d.summary ?? 'N/A'}\nKey Numbers: ${(d.keyNumbers ?? []).join(', ') || 'None'}\nDecisions: ${(d.decisions ?? []).join('; ') || 'None'}\nRisks: ${(d.risks ?? []).join('; ') || 'None'}`
            )
            .join('\n\n---\n\n')

          for await (const chunk of chatStream(`${catchMeUpPrompt(space?.name ?? 'this project', sinceLabel)}\n${styleInstruction(responseStyle)}`, context)) {
            fullContent += chunk
            send({ type: 'delta', content: chunk })
          }
        }

        const [assistantMsg] = await db
          .insert(messages)
          .values({ spaceId, userId, role: 'assistant', content: fullContent || 'No response generated.' })
          .returning()

        send({ type: 'done', assistantMessageId: assistantMsg.id, userMessageId: userMsg.id })
      } catch (err) {
        console.error('[catch-up] Stream error:', err)
        try {
          const [assistantMsg] = await db
            .insert(messages)
            .values({ spaceId, userId, role: 'assistant', content: 'Failed to generate summary. Please try again.' })
            .returning()
          send({ type: 'error', message: 'Failed to generate summary. Please try again.', assistantMessageId: assistantMsg.id })
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
