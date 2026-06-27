import { NextRequest, NextResponse } from 'next/server'
import { and, eq, desc } from 'drizzle-orm'

export const maxDuration = 60
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { documents, messages } from '@/lib/db/schema'
import { chatStream } from '@/lib/ai/provider'
import { briefMePrompt, styleInstruction } from '@/lib/ai/prompts'
import { checkSpaceAccess } from '@/lib/api/checkSpaceAccess'

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { spaceId, responseStyle, spaceName } = await req.json()
  if (!spaceId) return NextResponse.json({ error: 'spaceId required' }, { status: 400 })

  const allowed = await checkSpaceAccess(spaceId, session.user.id)
  if (!allowed) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })

  const space = { name: spaceName as string | undefined }

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

        if (readyDocs.length === 0) {
          fullContent = 'No documents have been processed yet. Upload documents to generate a briefing.'
          send({ type: 'delta', content: fullContent })
        } else {
          const docsContext = readyDocs
            .map(
              (d) =>
                `Document: ${d.name}\nSummary: ${d.summary ?? 'N/A'}\nKey Numbers: ${(d.keyNumbers ?? []).join(', ') || 'None'}\nRisks: ${(d.risks ?? []).join('; ') || 'None'}\nDecisions: ${(d.decisions ?? []).join('; ') || 'None'}`
            )
            .join('\n\n---\n\n')

          for await (const chunk of chatStream(`${briefMePrompt(space?.name ?? 'this project')}\n${styleInstruction(responseStyle)}`, docsContext)) {
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
        console.error('[brief] Stream error:', err)
        try {
          const [assistantMsg] = await db
            .insert(messages)
            .values({ spaceId, userId, role: 'assistant', content: 'Failed to generate briefing. Please try again.' })
            .returning()
          send({ type: 'error', message: 'Failed to generate briefing. Please try again.', assistantMessageId: assistantMsg.id })
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
