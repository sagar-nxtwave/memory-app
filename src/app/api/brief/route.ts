import { NextRequest, NextResponse } from 'next/server'
import { and, eq, desc } from 'drizzle-orm'

export const maxDuration = 300
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { documents, messages } from '@/lib/db/schema'
import { chatStream } from '@/lib/ai/provider'
import { briefMePrompt, styleInstruction } from '@/lib/ai/prompts'
import { checkSpaceAccess } from '@/lib/api/checkSpaceAccess'
import { soql } from '@/salesforce/client'
import { getSalesforceConfig } from '@/salesforce/config'

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { spaceId, responseStyle, spaceName, provider } = await req.json()
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
          const crmEnabled = getSalesforceConfig().enabled
          if (crmEnabled) {
            try {
              const [salesResult, projectResult] = await Promise.all([
                soql(
                  `SELECT COUNT(Id) totalDeals, SUM(Net_Amount__c) totalRevenue ` +
                  `FROM Opportunity ` +
                  `WHERE IsClosed = true AND IsWon = true ` +
                  `AND Order_Date__c = THIS_YEAR ` +
                  `AND Sold_By_Nshama__c = 'NEW SALE' ` +
                  `AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') ` +
                  `AND (NOT Name LIKE '%PK%') AND Amount != 1`
                ),
                soql(
                  `SELECT Building_Community__c, COUNT(Id) deals, SUM(Net_Amount__c) revenue ` +
                  `FROM Opportunity ` +
                  `WHERE IsClosed = true AND IsWon = true ` +
                  `AND Order_Date__c = THIS_YEAR ` +
                  `AND Sold_By_Nshama__c = 'NEW SALE' ` +
                  `AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') ` +
                  `AND (NOT Name LIKE '%PK%') AND Amount != 1 ` +
                  `GROUP BY Building_Community__c ` +
                  `ORDER BY SUM(Net_Amount__c) DESC LIMIT 5`
                ),
              ])

              const totalDeals = (salesResult.records[0] as Record<string, unknown>)?.totalDeals ?? 0
              const totalRevenue = (salesResult.records[0] as Record<string, unknown>)?.totalRevenue ?? 0
              let crmContext = `SALESFORCE CRM DATA (this year, live):\n`
              crmContext += `Total closed-won deals: ${totalDeals}\n`
              crmContext += `Total revenue: AED ${totalRevenue}\n`
              if (projectResult.records.length > 0) {
                crmContext += `\nTop projects by revenue:\n`
                for (const p of projectResult.records) {
                  crmContext += `- ${p.Building_Community__c}: ${p.deals} deals, AED ${p.revenue}\n`
                }
              }

              for await (const chunk of chatStream(`${briefMePrompt(space?.name ?? 'this project')}\n${styleInstruction(responseStyle)}`, crmContext, [], provider)) {
                fullContent += chunk
                send({ type: 'delta', content: chunk })
              }
            } catch (crmErr) {
              console.error('[brief] CRM fallback failed:', crmErr)
              fullContent = 'No documents have been uploaded yet. Upload documents or ask about your CRM data in chat to get started.'
            }
          } else {
            fullContent = 'No documents have been uploaded yet. Upload documents or ask about your CRM data in chat to get started.'
          }
          send({ type: 'delta', content: fullContent })
        } else {
          const docsContext = readyDocs
            .map(
              (d) =>
                `Document: ${d.name}\nSummary: ${d.summary ?? 'N/A'}\nKey Numbers: ${(d.keyNumbers ?? []).join(', ') || 'None'}\nRisks: ${(d.risks ?? []).join('; ') || 'None'}\nDecisions: ${(d.decisions ?? []).join('; ') || 'None'}`
            )
            .join('\n\n---\n\n')

          for await (const chunk of chatStream(`${briefMePrompt(space?.name ?? 'this project')}\n${styleInstruction(responseStyle)}`, docsContext, [], provider)) {
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
