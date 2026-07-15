import { NextRequest, NextResponse } from 'next/server'
import { and, eq, desc } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { spaceMembers, spaces, globalMessages, documents } from '@/lib/db/schema'
import { generateEmbedding, chatStream, rerankWithScores } from '@/lib/ai/provider'
import { globalChatPrompt, styleInstruction } from '@/lib/ai/prompts'
import { sanitizeForPrompt, truncateToTokenLimit } from '@/lib/utils/sanitize'
import { formatDateTime } from '@/lib/utils/date'
import { parseQueryFilters, isFinancialQuery, wantsVisual, isChitChat } from '@/lib/utils/queryFilters'
import { answerTabularQuery } from '@/lib/ai/tableQuery'
import { retrieveAndMerge, type RetrievalItem, type Citation } from '@/web-search'
import { answerSalesforceQuery } from '@/salesforce'
import { formatSalesforceData } from '@/salesforce/format-results'
import { validateAnswerAgainstData, validateListCompleteness } from '@/salesforce/answer-validator'
import { classifyIntent, type Intent } from '@/lib/ai/intentRouter'
import { webContextNote } from '@/lib/ai/prompts'
import { dateContext } from '@/salesforce/today'
import { features } from '@/lib/feature-flags'
import { generateFollowUpSuggestions } from '@/salesforce/follow-up-suggestions'

export const maxDuration = 60

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const history = await db
    .select({
      id: globalMessages.id,
      role: globalMessages.role,
      content: globalMessages.content,
      createdAt: globalMessages.createdAt,
      citations: globalMessages.citations,
      documentImages: globalMessages.documentImages,
      thinkingSteps: globalMessages.thinkingSteps,
      thinkingStepActions: globalMessages.thinkingStepActions,
      thinkingStepResults: globalMessages.thinkingStepResults,
    })
    .from(globalMessages)
    .where(eq(globalMessages.userId, session.user.id))
    .orderBy(globalMessages.createdAt)

  return NextResponse.json(history)
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { content, spaceIds: requestedIds, responseStyle, provider, mentionedDocIds } = await req.json()
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

  const hasMentionedDocs = Array.isArray(mentionedDocIds) && mentionedDocIds.length > 0

  // Skip retrieval entirely for greetings/small talk — otherwise a generic reply still
  // cites whatever chunk happened to clear the similarity threshold.
  const skipRetrieval = isChitChat(content) && !hasMentionedDocs

  // Fetched early so follow-ups like "yes break down" / "which building?" can be resolved
  // against recent turns before reaching the Salesforce planner — see chat/route.ts for the
  // full rationale (a follow-up reaching the planner in isolation wrongly concludes the
  // requested data doesn't exist).
  const priorTurns = await db
    .select({ role: globalMessages.role, content: globalMessages.content })
    .from(globalMessages)
    .where(and(eq(globalMessages.userId, userId), sql`${globalMessages.id} != ${userMsg.id}`))
    .orderBy(desc(globalMessages.createdAt))
    .limit(6)
  const sfHistory: { role: 'user' | 'assistant'; content: string }[] = priorTurns.reverse().map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

  // Semantic intent routing (CRM / documents / web) — runs concurrently with embedding.
  let queryEmbedding: number[] = []
  let intent: Intent = { salesforce: false, documents: true, web: false }
  if (!skipRetrieval) {
    const [emb, routed] = await Promise.all([
      generateEmbedding(content).catch(() => [] as number[]),
      classifyIntent(content),
    ])
    queryEmbedding = emb
    intent = routed
  }
  const financialBoost = isFinancialQuery(content)
    ? sql` + CASE WHEN dc.contains_numbers = true OR dc.chunk_type IN ('table', 'financial') THEN 0.15 ELSE 0 END`
    : sql``

  const filters = parseQueryFilters(content)
  const fileTypeFilter = filters.fileTypes.length > 0
    ? sql` AND d.file_type::text = ANY(${filters.fileTypes}::text[])`
    : sql``
  const afterFilter = filters.afterDate
    ? sql` AND d.created_at >= ${filters.afterDate.toISOString()}`
    : sql``
  const beforeFilter = filters.beforeDate
    ? sql` AND d.created_at <= ${filters.beforeDate.toISOString()}`
    : sql``

  let contextText = ''
  let citations: Citation[] = []
  let internalItems: RetrievalItem[] = []
  let documentImages: { url: string; alt: string; documentName: string; spaceName?: string }[] = []
  const showImages = wantsVisual(content)
  if (queryEmbedding.length > 0) {
    const embeddingStr = `[${queryEmbedding.join(',')}]`
    const spaceIdsSQL = sql.join(spaceIds.map((id) => sql`${id}::uuid`), sql`, `)
    const chunks = hasMentionedDocs
      ? await db.execute(sql`
          SELECT dc.content, dc.document_id, d.name as document_name, s.name as space_name,
                 (0.6 * (1 - (dc.embedding <=> ${embeddingStr}::vector)) +
                  0.4 * ts_rank(to_tsvector('simple', dc.content), websearch_to_tsquery('simple', ${content}))
                  ${financialBoost}) AS hybrid_score
          FROM document_chunks dc
          INNER JOIN documents d ON d.id = dc.document_id
          INNER JOIN spaces s ON s.id = d.space_id
          WHERE d.space_id IN (${spaceIdsSQL})
            AND d.id = ANY(${mentionedDocIds}::uuid[])
            AND d.status = 'ready'
            AND dc.embedding IS NOT NULL
            AND (
              1 - (dc.embedding <=> ${embeddingStr}::vector) >= 0.30
              OR to_tsvector('simple', dc.content) @@ websearch_to_tsquery('simple', ${content})
            )
            ${fileTypeFilter}${afterFilter}${beforeFilter}
          ORDER BY hybrid_score DESC
          LIMIT 12
        `)
      : await db.execute(sql`
          SELECT dc.content, dc.document_id, d.name as document_name, s.name as space_name,
                 (0.6 * (1 - (dc.embedding <=> ${embeddingStr}::vector)) +
                  0.4 * ts_rank(to_tsvector('simple', dc.content), websearch_to_tsquery('simple', ${content}))
                  ${financialBoost}) AS hybrid_score
          FROM document_chunks dc
          INNER JOIN documents d ON d.id = dc.document_id
          INNER JOIN spaces s ON s.id = d.space_id
          WHERE d.space_id IN (${spaceIdsSQL})
            AND d.status = 'ready'
            AND dc.embedding IS NOT NULL
            AND (
              1 - (dc.embedding <=> ${embeddingStr}::vector) >= 0.40
              OR to_tsvector('simple', dc.content) @@ websearch_to_tsquery('simple', ${content})
            )
            ${fileTypeFilter}${afterFilter}${beforeFilter}
          ORDER BY hybrid_score DESC
          LIMIT 12
        `)
    let rawChunks = chunks as unknown as { content: string; document_id: string; document_name: string; space_name: string }[]

    // Guardrail: a hard 0.40 similarity cutoff returns ZERO rows for plenty of legitimately
    // relevant questions phrased differently from the document text — better to give the
    // reranker weaker candidates to judge than return an empty context (reads as an
    // unhelpful "not in documents" / empty response to the user).
    if (!hasMentionedDocs && rawChunks.length === 0) {
      const fallback = await db.execute(sql`
        SELECT dc.content, dc.document_id, d.name as document_name, s.name as space_name,
               (1 - (dc.embedding <=> ${embeddingStr}::vector)) AS hybrid_score
        FROM document_chunks dc
        INNER JOIN documents d ON d.id = dc.document_id
        INNER JOIN spaces s ON s.id = d.space_id
        WHERE d.space_id IN (${spaceIdsSQL})
          AND d.status = 'ready'
          AND dc.embedding IS NOT NULL
          AND 1 - (dc.embedding <=> ${embeddingStr}::vector) >= 0.20
          ${fileTypeFilter}${afterFilter}${beforeFilter}
        ORDER BY hybrid_score DESC
        LIMIT 8
      `)
      rawChunks = fallback as unknown as typeof rawChunks
      if (rawChunks.length === 0) {
        console.log(`[global-chat] No retrieval matches even at 0.20 threshold — query="${content.slice(0, 200)}"`)
      }
    }

    // Only look up images when the user explicitly asked to see something visual —
    // otherwise every cross-space answer would surface an unrelated image strip.
    if (showImages) {
      // Primary path: rank dedicated image chunks by how well their caption matches the query.
      const imgRows = await db.execute(sql`
        SELECT dc.image_url, dc.image_title, dc.content, d.name as document_name, s.name as space_name,
               (1 - (dc.embedding <=> ${embeddingStr}::vector)) AS similarity
        FROM document_chunks dc
        INNER JOIN documents d ON d.id = dc.document_id
        INNER JOIN spaces s ON s.id = d.space_id
        WHERE d.space_id IN (${spaceIdsSQL})
          AND d.status = 'ready'
          AND dc.chunk_type = 'image'
          AND dc.image_url IS NOT NULL
          AND dc.embedding IS NOT NULL
        ORDER BY dc.embedding <=> ${embeddingStr}::vector
        LIMIT 6
      `)
      const rows = imgRows as unknown as { image_url: string; image_title: string | null; content: string; document_name: string; space_name: string; similarity: number }[]
      // Only surface genuinely close matches — cap at 3, within a small margin of the best match.
      const topScore = rows[0]?.similarity ?? 0
      const passing = rows.filter((r) => r.similarity >= 0.3 && r.similarity >= topScore - 0.05).slice(0, 3)
      const chosen = passing.length > 0 ? passing : rows.slice(0, 1)
      for (const r of chosen) {
        if (!documentImages.find((i) => i.url === r.image_url)) {
          documentImages.push({ alt: r.image_title || r.content.slice(0, 80) || 'image', url: r.image_url, documentName: r.document_name, spaceName: r.space_name })
        }
      }

      // Legacy fallback: pre-migration documents keep figures as markdown inside prose chunks.
      if (documentImages.length === 0) {
        const legacyRows = await db.execute(sql`
          SELECT dc.content, dc.document_id, d.name as document_name, s.name as space_name
          FROM document_chunks dc
          INNER JOIN documents d ON d.id = dc.document_id
          INNER JOIN spaces s ON s.id = d.space_id
          WHERE d.space_id IN (${spaceIdsSQL})
            AND d.status = 'ready'
            AND dc.chunk_type <> 'image'
            AND dc.content LIKE '%![%'
          LIMIT 50
        `)
        const legacy = legacyRows as unknown as { content: string; document_id: string; document_name: string; space_name: string }[]
        const IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g
        for (const chunk of legacy) {
          let m: RegExpExecArray | null
          IMAGE_RE.lastIndex = 0
          while ((m = IMAGE_RE.exec(chunk.content)) !== null) {
            let url = m[2]
            if (!url.startsWith('/')) url = `/api/documents/${chunk.document_id}/images/${encodeURIComponent(url)}`
            if (!documentImages.find((i) => i.url === url)) {
              documentImages.push({ alt: m[1] || url.split('/').pop() || 'image', url, documentName: chunk.document_name, spaceName: chunk.space_name })
            }
          }
        }
      }
    }

    // Threshold internal citations by rerank relevance (same rule as per-space chat) so a
    // loosely keyword-matched chunk isn't cited when the real answer came from Salesforce/
    // tabular data. Explicit @-mentions always pass through.
    const INTERNAL_RELEVANCE_MIN = 0.2
    const rerankedScored = await rerankWithScores(content, rawChunks, 8)
    const reranked = hasMentionedDocs
      ? rerankedScored.map((r) => r.item)
      : rerankedScored.filter((r) => r.score >= INTERNAL_RELEVANCE_MIN).map((r) => r.item)
    citations = reranked
      .map((c) => ({ documentId: c.document_id, documentName: c.document_name, spaceName: c.space_name }))
      .filter((v, i, a) => a.findIndex((x) => x.documentName === v.documentName && x.spaceName === v.spaceName) === i)

    contextText = reranked
      .map((c) => `[${c.space_name} › ${c.document_name}]\n${c.content.replace(/!\[[^\]]*\]\([^)]*\)/g, '')}`)
      .join('\n\n---\n\n')

    internalItems = reranked.map((c) => ({
      id: '', sourceType: 'internal', content: c.content,
      title: c.document_name, documentId: c.document_id, documentName: c.document_name, spaceName: c.space_name,
    }))
  }

  // Web search augmentation (Ask All Spaces) — same non-breaking pattern as per-space chat:
  // classifier gates it, results merge with internal RAG into one labeled+cited context,
  // and it fails soft to the internal-only path when web isn't needed or returns nothing.
  // Web runs ONLY when the semantic router says so — never as a default fallback.
  let webUsed = false
  if (!skipRetrieval && intent.web) {
    const merged = await retrieveAndMerge({ query: content, internal: internalItems, topN: 8 })
    if (merged.webUsed) {
      const hasInternalItems = merged.context.includes('[INT-')
      if (hasInternalItems) {
        contextText = merged.context
        citations = merged.citations
        webUsed = true
      }
    }
  }

  // Structured-data path: count / list-all / average / filter questions over spreadsheet
  // rows can't be answered by top-K vector retrieval. Query the stored tables directly.
  const tabularResult = skipRetrieval ? null : await answerTabularQuery(content, spaceIds)
  if (tabularResult) {
    for (const tc of tabularResult.citations) {
      if (!citations.some((c) => c.documentId === tc.documentId)) {
        citations.unshift({ documentId: tc.documentId, documentName: tc.documentName })
      }
    }
  }

  // Live Salesforce CRM path (Ask All Spaces) — same guarded-SOQL connector as per-space chat.
  // mcpStepsLog captures each MCP tool call/SOQL query (when MCP mode is on) so they can be
  // surfaced in the "thinking process" UI — see emission near the stream start below.
  const mcpStepsLog: { action: string; detail: string; result?: string }[] = []
  const onMcpStep = (step: { action: string; detail: string; result?: string }) => mcpStepsLog.push(step)
  let salesforceResult = intent.salesforce ? await answerSalesforceQuery(content, sfHistory, onMcpStep) : null
  // Note: thinking steps for Salesforce are emitted inside the stream start block above
  if (salesforceResult) {
    const sfCitation = salesforceResult.citation
    if (!citations.some((c) => c.documentName === sfCitation.documentName)) citations.unshift(sfCitation)
  }

  // Safety net: the semantic router is a single LLM call and can miss oddly-phrased CRM
  // questions, or a bare project/community/customer name with no verb. If EVERY source came
  // back empty, try Salesforce once as a last resort before giving up — high-level executive
  // questions must not silently fail on one bad classification. Deliberately not gated behind
  // a keyword regex — a regex can never recognize an arbitrary project/customer name.
  if (!intent.salesforce && !tabularResult && !webUsed && contextText.trim().length === 0) {
    const fallback = await answerSalesforceQuery(content, sfHistory, onMcpStep)
    if (fallback) {
      salesforceResult = fallback
      if (!citations.some((c) => c.documentName === fallback.citation.documentName)) {
        citations.unshift(fallback.citation)
      }
    }
  }

  // Build document manifest per space for the LLM to know what documents exist
  const spaceIdsForDocs = sql.join(spaceIds.map((id) => sql`${id}::uuid`), sql`, `)
  const allDocs = await db.execute(sql`
    SELECT d.name, d.file_type, d.created_at, s.name as space_name
    FROM documents d
    INNER JOIN spaces s ON s.id = d.space_id
    WHERE d.space_id IN (${spaceIdsForDocs}) AND d.status = 'ready'
    ORDER BY d.created_at DESC
  `)
  const docsRows = allDocs as unknown as { name: string; file_type: string; created_at: string; space_name: string }[]

  let docManifest = ''
  if (docsRows.length > 0) {
    const grouped = docsRows.reduce<Record<string, typeof docsRows>>((acc, d) => {
      acc[d.space_name] = acc[d.space_name] ?? []
      acc[d.space_name].push(d)
      return acc
    }, {})
    docManifest = Object.entries(grouped)
      .map(([space, docs]) =>
        `${space} (${docs.length} document${docs.length !== 1 ? 's' : ''}):\n${docs.map((d, i) => `  ${i + 1}. ${d.name} (${d.file_type ?? 'unknown'}, uploaded ${formatDateTime(d.created_at)})`).join('\n')}`
      )
      .join('\n\n')
  } else {
    docManifest = 'No documents found in the selected projects.'
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

  const imageNote = documentImages.length > 0
    ? `\nIMPORTANT: The following ${documentImages.length} image(s) are already displayed to the user below your response, in this exact order:\n${documentImages.map((img, i) => `${i + 1}. ${img.alt}${img.spaceName ? ` (${img.spaceName})` : ''}`).join('\n')}\nWhen answering, identify which numbered image(s) answer the question and describe them directly by their content (e.g. "Image 2 below shows..."). Never tell the user to scroll, search, or look through the images themselves — you already know which one(s) are relevant. Never say images are missing, corrupted, or inaccessible.`
    : ''

  const systemPrompt = `${globalChatPrompt()}
${styleInstruction(responseStyle)}${imageNote}${webUsed ? webContextNote() : ''}

IMPORTANT: ${dateContext()} When users ask about "this year", "this month", "this quarter" etc., use the ACTUAL current date above — never assume a different year.

Searching across: ${spaceNames}

Documents available across projects:
${docManifest}

CRITICAL INSTRUCTIONS FOR SALESFORCE CRM DATA:
- The formatted data below is already clean — present it to the user as-is
- For tables: render the markdown table directly, then add a 1-2 sentence summary
- For text lists: present the key facts clearly with labels
- NEVER rephrase data into vague language — use the exact values provided
- If data is empty, say "No records found" — don't say "0 records"

${salesforceResult ? (() => {
  const formattedData = formatSalesforceData(salesforceResult)
  return `\nSalesforce CRM Data:\n\n${salesforceResult.context}\n${formattedData ? `\nFormatted Data (present this to the user):\n${formattedData}\n` : ''}\n`
})() : ''}
${tabularResult ? `\n${tabularResult.context}\n` : ''}
${contextText ? `${webUsed ? 'Context (each item is labeled [INT-n] internal document or [WEB-n] web source):' : 'Relevant content from documents:'}\n\n${truncateToTokenLimit(contextText)}` : (tabularResult || salesforceResult) ? '' : 'No relevant document content found for this query.'}`

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))

      try {
        send({ type: 'start', userMessageId: userMsg.id })

        // ── Thinking process steps (emitted as thinking events) ──
        const steps: string[] = []
        const stepActions: string[] = []
        const stepResults: string[] = []
        const collectStep = (step: string, action?: string, result?: string) => {
          steps.push(step)
          stepActions.push(action ?? '')
          stepResults.push(result ?? '')
        }
        const emitStep = (step: string) => { collectStep(step); send({ type: 'thinking', step, index: steps.length }) }

        if (skipRetrieval) {
          emitStep('Processing your message...')
        } else {
          emitStep('Understanding your question...')
          if (intent.salesforce) emitStep('Querying live Salesforce CRM data...')
          if (intent.documents) emitStep('Searching documents for relevant content...')
          if (intent.web) emitStep('Searching the web for supplementary information...')
        }

        // Surface each MCP tool call/SOQL query as its own thinking step — makes the
        // Salesforce MCP reasoning auditable instead of a black box (client-requested).
        for (const s of mcpStepsLog) {
          send({ type: 'thinking', action: s.action, step: s.detail, index: steps.length + 1 })
          collectStep(s.detail, s.action, s.result)
          if (s.result) {
            collectStep(s.result, 'result')
            send({ type: 'thinking', action: 'result', step: s.result, index: steps.length })
          }
        }

        let fullContent = ''
        for await (const chunk of chatStream(systemPrompt, sanitizeForPrompt(content), conversationHistory, provider)) {
          fullContent += chunk
          send({ type: 'delta', content: chunk })
        }

        if (salesforceResult) {
          const validation = validateAnswerAgainstData(fullContent, salesforceResult.context)
          const listCheck = validateListCompleteness(fullContent, salesforceResult.context)
          if (!validation.valid || !listCheck.valid) {
            const allIssues = [...validation.issues, ...(listCheck.issue ? [listCheck.issue] : [])]
            console.warn('[answer-validator] POTENTIAL HALLUCINATION DETECTED', {
              question: content.slice(0, 200),
              issues: allIssues,
              hallucinatedTerms: validation.hallucinatedTerms,
              hallucinatedNumbers: validation.hallucinatedNumbers,
            })
            send({ type: 'thinking', action: 'detectHallucination', step: 'Potential hallucination detected', result: allIssues.join(' | ') })
          } else {
            send({ type: 'thinking', action: 'detectHallucination', step: 'Hallucination check passed', result: 'No issues found' })
          }
        }

        const [assistantMsg] = await db
          .insert(globalMessages)
          .values({
            userId,
            role: 'assistant',
            content: fullContent || 'No response generated.',
            citations: citations.length > 0 ? citations : null,
            documentImages: documentImages.length > 0 ? documentImages : null,
            thinkingSteps: steps.length > 0 ? steps : null,
            thinkingStepActions: stepActions.length > 0 ? stepActions : null,
            thinkingStepResults: stepResults.length > 0 ? stepResults : null,
          })
          .returning()

        let suggestions: string[] = []
        if (features.followUpSuggestions && salesforceResult && fullContent.length > 50) {
          try {
            suggestions = await generateFollowUpSuggestions(content, fullContent)
          } catch (sErr) {
            console.warn('[global-chat] Follow-up suggestions failed (non-blocking):', sErr)
          }
        }

        send({ type: 'done', assistantMessageId: assistantMsg.id, userMessageId: userMsg.id, citations, documentImages, suggestions })
      } catch (err) {
        console.error('[global-chat] Error:', err)
        try {
          const [assistantMsg] = await db
            .insert(globalMessages)
            .values({ userId, role: 'assistant', content: 'Something went wrong. Please try again.' })
            .returning()
          send({ type: 'error', message: 'Something went wrong. Please try again.', assistantMessageId: assistantMsg.id })
        } catch (dbErr) {
          console.error('[global-chat] Failed to save error message to DB:', dbErr)
          send({ type: 'error', message: 'Something went wrong. Please try again.' })
        }
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
