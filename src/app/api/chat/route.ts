import { NextRequest, NextResponse } from 'next/server'
import { and, eq, desc } from 'drizzle-orm'

export const maxDuration = 60
import { sql } from 'drizzle-orm'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { messages, spaceMembers, documents, spaces } from '@/lib/db/schema'
import { generateEmbedding, chatStream, rerankWithScores } from '@/lib/ai/provider'
import { chatPrompt, styleInstruction } from '@/lib/ai/prompts'
import { sanitizeForPrompt, truncateToTokenLimit } from '@/lib/utils/sanitize'
import { formatDateTime } from '@/lib/utils/date'
import { parseQueryFilters, isFinancialQuery, wantsVisual, isChitChat } from '@/lib/utils/queryFilters'
import { answerTabularQuery } from '@/lib/ai/tableQuery'
import { retrieveAndMerge, type RetrievalItem } from '@/web-search'
import { answerSalesforceQuery } from '@/salesforce'
import { formatSalesforceData } from '@/salesforce/format-results'
import { dateContext } from '@/salesforce/today'
import { validateAnswerAgainstData, validateListCompleteness } from '@/salesforce/answer-validator'
import { classifyIntent, type Intent } from '@/lib/ai/intentRouter'
import { features } from '@/lib/feature-flags'
import { generateFollowUpSuggestions } from '@/salesforce/follow-up-suggestions'
import { webContextNote } from '@/lib/ai/prompts'
import { hasCrossSpaceIntent, findMentionedSpaces, findMentionedDocs, formatCandidate, type CrossSpaceCandidate } from '@/lib/utils/crossSpaceIntent'

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const spaceId = req.nextUrl.searchParams.get('spaceId')
  if (!spaceId) return NextResponse.json({ error: 'spaceId required' }, { status: 400 })

  const history = await db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
      citations: messages.citations,
      documentImages: messages.documentImages,
      thinkingSteps: messages.thinkingSteps,
      thinkingStepActions: messages.thinkingStepActions,
      thinkingStepResults: messages.thinkingStepResults,
    })
    .from(messages)
    .where(eq(messages.spaceId, spaceId))
    .orderBy(messages.createdAt)

  return NextResponse.json(history)
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { spaceId, content, spaceName, responseStyle, provider, mentionedDocIds: bodyMentionedDocIds, mentionedSpaceIds } = await req.json()

  if (!spaceId || !content?.trim()) {
    return NextResponse.json({ error: 'spaceId and content are required' }, { status: 400 })
  }

  const [member] = await db
    .select()
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, session.user.id)))
    .limit(1)

  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })

  const [userMsg] = await db
    .insert(messages)
    .values({ spaceId, userId: session.user.id, role: 'user', content: content.trim() })
    .returning()

  const encoder = new TextEncoder()
  const userId = session.user.id

  // Cross-space comparison ("compare this to Space B", "how does X differ from the Sea
  // Gardens vendor doc") — asked from inside Space A's chat but needs Space B's documents
  // too. Detect it here and pull the other space into retrieval instead of forcing the
  // user to switch to Ask All Spaces.
  let crossSpaceIds = [spaceId]
  let crossSpaceNote = ''
  const explicitSpaceIds: string[] = Array.isArray(mentionedSpaceIds)
    ? [...new Set(mentionedSpaceIds.filter((id: unknown) => typeof id === 'string' && id !== spaceId))]
    : []

  if (explicitSpaceIds.length > 0) {
    // User explicitly picked another project via @ mention — no ambiguity to resolve,
    // just verify they're actually a member of it before including its documents.
    const memberOfExplicit = await db
      .select({ id: spaces.id, name: spaces.name })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
      .where(and(eq(spaceMembers.userId, session.user.id), sql`${spaceMembers.spaceId} = ANY(${explicitSpaceIds}::uuid[])`))

    if (memberOfExplicit.length > 0) {
      crossSpaceIds = [spaceId, ...memberOfExplicit.map((s) => s.id)]
      crossSpaceNote = `\nThe user explicitly referenced content from ${memberOfExplicit.length > 1 ? 'other projects' : 'another project'} (${memberOfExplicit.map((s) => `"${s.name}"`).join(', ')}) alongside "${spaceName ?? 'this project'}". The context below includes documents from all referenced projects, each labeled with its project name — clearly attribute which facts come from which project.`
    }
  } else if (hasCrossSpaceIntent(content)) {
    const userSpaces = await db
      .select({ id: spaces.id, name: spaces.name })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
      .where(eq(spaceMembers.userId, session.user.id))

    const otherDocs = await db
      .select({ id: documents.id, name: documents.name, spaceId: documents.spaceId, spaceName: spaces.name })
      .from(documents)
      .innerJoin(spaces, eq(spaces.id, documents.spaceId))
      .innerJoin(spaceMembers, eq(spaceMembers.spaceId, documents.spaceId))
      .where(and(eq(spaceMembers.userId, session.user.id), eq(documents.status, 'ready')))

    const spaceMatches = findMentionedSpaces(content, userSpaces, spaceId)
    const docMatches = findMentionedDocs(content, otherDocs, spaceId)
    const candidates: CrossSpaceCandidate[] = [...spaceMatches, ...docMatches]
    const distinctOtherSpaceIds = [...new Set(candidates.map((c) => (c.type === 'space' ? c.id : c.spaceId)))]

    if (distinctOtherSpaceIds.length > 1) {
      // Multiple different projects/docs could match — don't guess, ask which one.
      const clarify = `I found multiple possible matches for that comparison:\n${candidates.map((c, i) => `${i + 1}. ${formatCandidate(c)}`).join('\n')}\n\nWhich one did you mean? Reply with the project or document name and I'll compare it against "${spaceName ?? 'this project'}".`

      const stream = new ReadableStream({
        async start(controller) {
          const send = (data: object) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
          send({ type: 'start', userMessageId: userMsg.id })
          send({ type: 'delta', content: clarify })
          const [assistantMsg] = await db
            .insert(messages)
            .values({ spaceId, userId, role: 'assistant', content: clarify })
            .returning()
          send({ type: 'done', assistantMessageId: assistantMsg.id, userMessageId: userMsg.id, citations: [], documentImages: [] })
          controller.close()
        },
      })
      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
      })
    } else if (distinctOtherSpaceIds.length === 1) {
      crossSpaceIds = [spaceId, distinctOtherSpaceIds[0]]
      const matchedName = candidates.find((c) => (c.type === 'space' ? c.id : c.spaceId) === distinctOtherSpaceIds[0])
      const otherName = matchedName?.type === 'space' ? matchedName.name : matchedName?.spaceName
      crossSpaceNote = `\nThe user is asking to compare "${spaceName ?? 'this project'}" with another project ("${otherName}"). The context below includes documents from BOTH projects, each labeled with its project name — clearly attribute which facts come from which project.`
    }
  }

  const crossSpace = crossSpaceIds.length > 1
  const spaceIdsSQL = sql.join(crossSpaceIds.map((id) => sql`${id}::uuid`), sql`, `)

  const spaceDocsRows = await db
    .select({ id: documents.id, name: documents.name, createdAt: documents.createdAt, fileType: documents.fileType, spaceId: documents.spaceId, spaceName: spaces.name })
    .from(documents)
    .innerJoin(spaces, eq(spaces.id, documents.spaceId))
    .where(and(sql`${documents.spaceId} IN (${spaceIdsSQL})`, eq(documents.status, 'ready')))
    .orderBy(desc(documents.createdAt))

  // Auto-focus: if the query explicitly names one specific document (e.g. "tell me about
  // Statement_0061R00001Jjo4oQAB"), pull that document directly. Filenames/IDs often don't
  // semantically resemble their own content, so pure embedding + BM25 search misses them
  // entirely even though the document is fully processed and available.
  let mentionedDocIds: string[] = Array.isArray(bodyMentionedDocIds) ? bodyMentionedDocIds : []
  if (mentionedDocIds.length === 0) {
    const nameMatches = findMentionedDocs(content, spaceDocsRows)
    const distinctDocIds = [...new Set(nameMatches.map((m) => m.id))]
    if (distinctDocIds.length === 1) mentionedDocIds = distinctDocIds
  }

  // Skip retrieval entirely for greetings/small talk ("Hello", "thanks") — otherwise a
  // generic reply still cites whatever chunk happened to clear the similarity threshold.
  // mentionedDocIds check: an explicit doc reference always wins even if oddly phrased.
  const skipRetrieval = isChitChat(content) && mentionedDocIds.length === 0

  // Fetched early so follow-ups like "yes break down" / "which building?" can be resolved
  // against recent turns before reaching the Salesforce planner (see resolveFollowUp) —
  // without this, a follow-up reaches the planner as an isolated string with nothing to
  // refer to, and it wrongly concludes the requested data doesn't exist.
  const priorTurns = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(and(eq(messages.spaceId, spaceId), sql`${messages.id} != ${userMsg.id}`))
    .orderBy(desc(messages.createdAt))
    .limit(6)
  const conversationHistory: { role: 'user' | 'assistant'; content: string }[] = priorTurns.reverse().map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

  // Semantic intent routing decides which sources to use (CRM / documents / web) — replaces
  // brittle keyword gates. Run it concurrently with embedding to avoid adding latency.
  let queryEmbedding: number[] = []
  let intent: Intent = { salesforce: false, documents: true, web: false }
  if (!skipRetrieval) {
    const [emb, routed] = await Promise.all([
      generateEmbedding(content).catch((err) => { console.error('[chat] Embedding failed:', err); return [] as number[] }),
      classifyIntent(content),
    ])
    queryEmbedding = emb
    intent = routed
  }

  const embeddingStr = `[${queryEmbedding.join(',')}]`

  const hasMentions = Array.isArray(mentionedDocIds) && mentionedDocIds.length > 0
  const financialBoost = isFinancialQuery(content)
    ? sql` + CASE WHEN dc.contains_numbers = true OR dc.chunk_type IN ('table', 'financial') THEN 0.15 ELSE 0 END`
    : sql``

  // Metadata filters derived from natural language hints in the query
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

  const relevantChunks = queryEmbedding.length === 0 ? [] : hasMentions
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
        LIMIT ${crossSpace ? 20 : 12}
      `)

  let rawChunks = relevantChunks as unknown as { content: string; document_id: string; document_name: string; space_name: string }[]

  // Guardrail: a hard 0.40 similarity cutoff returns ZERO rows for plenty of legitimately
  // relevant questions that are just phrased differently from the document text — the
  // reranker below is a much better relevance judge than a blind cosine threshold, so it's
  // worth giving it weaker candidates to evaluate rather than returning an empty context
  // (which reads to the user as "empty response" / an unhelpful "not in documents").
  if (!hasMentions && rawChunks.length === 0 && queryEmbedding.length > 0) {
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
      console.log(`[chat] No retrieval matches even at 0.20 threshold — space=${spaceId} query="${content.slice(0, 200)}"`)
    }
  }

  // Only look up images when the user is explicitly asking to see something visual —
  // otherwise every answer in a space with any images would surface an unrelated image strip.
  const showImages = wantsVisual(content)
  const documentImages: { url: string; alt: string; documentName: string }[] = []
  if (showImages && queryEmbedding.length > 0) {
    // Primary path: rank dedicated image chunks by how well their caption matches the query.
    const imgRows = await db.execute(sql`
      SELECT dc.image_url, dc.image_title, dc.content, d.name as document_name,
             (1 - (dc.embedding <=> ${embeddingStr}::vector)) AS similarity
      FROM document_chunks dc
      INNER JOIN documents d ON d.id = dc.document_id
      WHERE d.space_id IN (${spaceIdsSQL})
        AND d.status = 'ready'
        AND dc.chunk_type = 'image'
        AND dc.image_url IS NOT NULL
        AND dc.embedding IS NOT NULL
      ORDER BY dc.embedding <=> ${embeddingStr}::vector
      LIMIT 6
    `)
    const rows = imgRows as unknown as { image_url: string; image_title: string | null; content: string; document_name: string; similarity: number }[]
    // Only surface images that are a genuinely close match — cap at 3, and require them to be
    // within a small margin of the best match, so a vague query doesn't dump every loosely-related figure.
    const topScore = rows[0]?.similarity ?? 0
    const passing = rows.filter((r) => r.similarity >= 0.3 && r.similarity >= topScore - 0.05).slice(0, 3)
    const chosen = passing.length > 0 ? passing : rows.slice(0, 1)
    for (const r of chosen) {
      if (!documentImages.find((i) => i.url === r.image_url)) {
        documentImages.push({ alt: r.image_title || r.content.slice(0, 80) || 'image', url: r.image_url, documentName: r.document_name })
      }
    }

    // Legacy fallback: documents uploaded before dedicated image chunks existed still have
    // their figures embedded as markdown inside prose chunks. Only used if nothing matched above.
    if (documentImages.length === 0) {
      const legacyRows = await db.execute(sql`
        SELECT dc.content, dc.document_id, d.name as document_name
        FROM document_chunks dc
        INNER JOIN documents d ON d.id = dc.document_id
        WHERE d.space_id IN (${spaceIdsSQL})
          AND d.status = 'ready'
          AND dc.chunk_type <> 'image'
          AND dc.content LIKE '%![%'
        LIMIT 50
      `)
      const legacy = legacyRows as unknown as { content: string; document_id: string; document_name: string }[]
      const IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g
      for (const chunk of legacy) {
        let m: RegExpExecArray | null
        IMAGE_RE.lastIndex = 0
        while ((m = IMAGE_RE.exec(chunk.content)) !== null) {
          let url = m[2]
          if (!url.startsWith('/')) url = `/api/documents/${chunk.document_id}/images/${encodeURIComponent(url)}`
          if (!documentImages.find((i) => i.url === url)) {
            documentImages.push({ alt: m[1] || url.split('/').pop() || 'image', url, documentName: chunk.document_name })
          }
        }
      }
    }
  }

  // Structured-data path: count / list-all / average / filter questions over spreadsheet
  // rows can't be answered by top-K vector retrieval (it only ever sees a handful of rows).
  // Run a safe SQL query over the stored table and hand the LLM the authoritative figure.
  const tabularResult = skipRetrieval ? null : await answerTabularQuery(content, crossSpaceIds)

  // Create the SSE stream early so MCP tool calls can emit thinking steps in real-time.
  // The stream's start() callback is called synchronously, so ctrl is available immediately.
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream({
    start(controller) { ctrl = controller }
  })
  const sseSend = (data: object) => {
    try { ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)) } catch {}
  }

  // Collect thinking steps, actions, and results for persistence
  const steps: string[] = []
  const stepActions: string[] = []
  const stepResults: string[] = []
  const collectStep = (step: string, action?: string, result?: string) => {
    steps.push(step)
    stepActions.push(action ?? '')
    stepResults.push(result ?? '')
  }

  // Live Salesforce CRM path — CRM questions ("how many closed-won deals", "pipeline by
  // stage", "open tasks") are answered against live Salesforce via guarded SOQL. Authoritative
  // over RAG/web for CRM facts; fails soft to those when it can't answer.
  // Each MCP tool call / SOQL query is surfaced in real-time via sseSend().
  // Emit generic thinking steps BEFORE the call so they appear in order.
  if (intent.salesforce) {
    try { sseSend({ type: 'thinking', action: 'info', step: 'Querying live Salesforce CRM data...' }) } catch {}
    collectStep('Querying live Salesforce CRM data...', 'info')
  }
  if (!skipRetrieval && !intent.salesforce) {
    try { sseSend({ type: 'thinking', action: 'info', step: 'Understanding your question...' }) } catch {}
    collectStep('Understanding your question...', 'info')
    if (intent.documents) {
      try { sseSend({ type: 'thinking', action: 'info', step: 'Searching documents for relevant content...' }) } catch {}
      collectStep('Searching documents for relevant content...', 'info')
    }
    if (intent.web) {
      try { sseSend({ type: 'thinking', action: 'info', step: 'Searching the web for supplementary information...' }) } catch {}
      collectStep('Searching the web for supplementary information...', 'info')
    }
  }
  let salesforceResult = intent.salesforce ? await answerSalesforceQuery(content, conversationHistory, (step) => {
    try { sseSend({ type: 'thinking', action: step.action, step: step.detail, result: step.result || undefined }) } catch {}
    collectStep(step.detail, step.action, step.result)
  }) : null

  // Follow-up detection: if the previous assistant message mentioned Salesforce data and the
  // user's current message is a vague follow-up ("can you do it?", "do it", "run it", "yes"),
  // treat it as a Salesforce query even if the intent classifier didn't flag it.
  if (!salesforceResult && conversationHistory.length > 0) {
    const lastAssistant = [...conversationHistory].reverse().find(m => m.role === 'assistant')
    const isFollowUp = /^(can you |could you |please |yes|sure|go ahead|do it|run it|execute it|go for it)/i.test(content.trim())
    if (lastAssistant && isFollowUp && (lastAssistant.content.includes('SALESFORCE') || lastAssistant.content.includes('Salesforce'))) {
      console.log('[chat] detected Salesforce follow-up despite intent=false, re-routing')
      salesforceResult = await answerSalesforceQuery(content, conversationHistory, (step) => {
        try { sseSend({ type: 'thinking', action: step.action, step: step.detail, result: step.result || undefined }) } catch {}
        collectStep(step.detail, step.action, step.result)
      })
    }
  }

  // Threshold internal citations by rerank relevance (same 0.3 cutoff used for web results) —
  // otherwise a loosely keyword-matched chunk gets cited as a "source" even when the real
  // answer came entirely from Salesforce/tabular data (e.g. "how many unconverted leads"
  // wrongly citing unrelated uploaded docs). Explicit @-mentions always pass through.
  const INTERNAL_RELEVANCE_MIN = 0.2
  const rerankedScored = await rerankWithScores(content, rawChunks, crossSpace ? 8 : 5)
  const reranked = hasMentions
    ? rerankedScored.map((r) => r.item)
    : rerankedScored.filter((r) => r.score >= INTERNAL_RELEVANCE_MIN).map((r) => r.item)
  let citations: import('@/web-search').Citation[] = [...new Map(reranked.map((c) => [
    `${c.space_name}|${c.document_name}`,
    crossSpace
      ? { documentId: c.document_id, documentName: c.document_name, spaceName: c.space_name }
      : { documentId: c.document_id, documentName: c.document_name },
  ])).values()]

  // Surface the structured-query source document(s) as citations too (if not already cited).
  if (tabularResult) {
    for (const tc of tabularResult.citations) {
      if (!citations.some((c) => c.documentId === tc.documentId)) {
        citations.unshift({ documentId: tc.documentId, documentName: tc.documentName })
      }
    }
  }

  // Cite the live CRM as a source when it answered.
  if (salesforceResult) {
    const sfCitation = salesforceResult.citation
    if (!citations.some((c) => c.documentName === sfCitation.documentName)) citations.unshift(sfCitation)
  }

  let context = reranked
    .map((c) => `[${crossSpace ? `${c.space_name} › ` : 'From: '}${c.document_name}]\n${c.content.replace(/!\[[^\]]*\]\([^)]*\)/g, '')}`)
    .join('\n\n---\n\n')

  // Web search augmentation — only when the classifier detects a current/external question
  // and web search is enabled. Merges internet results with internal RAG into one labeled,
  // cited context. Fails soft: if web isn't needed or returns nothing, the internal-only
  // path above is left completely untouched.
  // Web search runs ONLY when the semantic router says the question needs current/external
  // info — never as a default fallback (that was the bug: CRM questions hitting the web).
  let webUsed = false
  if (!skipRetrieval && intent.web) {
    const internalItems: RetrievalItem[] = reranked.map((c) => ({
      id: '', sourceType: 'internal', content: c.content,
      title: c.document_name, documentId: c.document_id, documentName: c.document_name,
      spaceName: crossSpace ? c.space_name : undefined,
    }))
    const merged = await retrieveAndMerge({ query: content, internal: internalItems, topN: crossSpace ? 8 : 6 })
    if (merged.webUsed) {
      const hasInternalItems = merged.context.includes('[INT-')
      if (hasInternalItems) {
        context = merged.context
        citations = merged.citations
        webUsed = true
      }
    }
  }

  // Safety net: the semantic router is a single LLM call and can miss oddly-phrased CRM
  // questions (e.g. "how many deals closed this year", or a bare project/community name with
  // no verb like "Address Grand Downtown"). If EVERY source came back empty, don't just answer
  // "not in documents" — try Salesforce once as a last resort before giving up. High-level
  // executive questions must not silently fail just because one classification call guessed
  // wrong; this is the client's top complaint. Deliberately NOT gated behind a keyword regex
  // anymore — a regex can never recognize an arbitrary project/customer name, so "try Salesforce
  // whenever everything else came up empty" is the safer default for a CRM-first tool.
  if (!intent.salesforce && !tabularResult && !webUsed && context.trim().length === 0) {
    const fallback = await answerSalesforceQuery(content, conversationHistory, (step) => {
      try { sseSend({ type: 'thinking', action: step.action, step: step.detail }) } catch {}
    })
    if (fallback) {
      salesforceResult = fallback
      if (!citations.some((c) => c.documentName === fallback.citation.documentName)) {
        citations.unshift(fallback.citation)
      }
    }
  }

  const spaceDocs = spaceDocsRows.filter((d) => d.spaceId === spaceId)

  const docManifest = !crossSpace
    ? (spaceDocs.length > 0
        ? `Documents in this space (${spaceDocs.length} total):\n${spaceDocs.map((d, i) => `${i + 1}. ${d.name} (${d.fileType ?? 'unknown'}, uploaded ${formatDateTime(d.createdAt)})`).join('\n')}`
        : 'No documents have been uploaded to this space yet.')
    : Object.entries(
        spaceDocsRows.reduce<Record<string, typeof spaceDocsRows>>((acc, d) => {
          acc[d.spaceName] = acc[d.spaceName] ?? []
          acc[d.spaceName].push(d)
          return acc
        }, {})
      ).map(([sName, docs]) => `${sName} (${docs.length} document${docs.length !== 1 ? 's' : ''}):\n${docs.map((d, i) => `  ${i + 1}. ${d.name} (${d.fileType ?? 'unknown'}, uploaded ${formatDateTime(d.createdAt)})`).join('\n')}`).join('\n\n')

  const recentHistory = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(and(eq(messages.spaceId, spaceId)))
    .orderBy(desc(messages.createdAt))
    .limit(10)

  const focusNote = hasMentions
    ? `\nThe user has focused this question on specific document(s): ${mentionedDocIds.map((id: string) => { const d = spaceDocsRows.find((x) => x.id === id); return d ? (crossSpace ? `${d.name} (${d.spaceName})` : d.name) : id }).join(', ')}. Answer exclusively from those documents.`
    : ''

  const imageNote = documentImages.length > 0
    ? `\nIMPORTANT: The following ${documentImages.length} image(s) are already displayed to the user below your response, in this exact order:\n${documentImages.map((img, i) => `${i + 1}. ${img.alt}`).join('\n')}\nWhen answering, identify which numbered image(s) answer the question and describe them directly by their content (e.g. "Image 2 below shows..."). Never tell the user to scroll, search, or look through the images themselves — you already know which one(s) are relevant. Never say images are missing, corrupted, or inaccessible.`
    : ''

  const systemPrompt = `${chatPrompt(spaceName ?? 'this project')}
${styleInstruction(responseStyle)}${focusNote}${imageNote}${crossSpaceNote}${webUsed ? webContextNote() : ''}

IMPORTANT: ${dateContext()} When users ask about "this year", "this month", "this quarter" etc., use the ACTUAL current date above — never assume a different year.

CRITICAL INSTRUCTIONS FOR SALESFORCE CRM DATA:
- The formatted data below is already clean — present it to the user as-is
- For tables: render the markdown table directly, then add a 1-2 sentence summary
- For text lists: present the key facts clearly with labels
- NEVER rephrase data into vague language — use the exact values provided
- If data is empty, say "No records found" — don't say "0 records"

${docManifest}
${salesforceResult ? (() => {
  const formattedData = formatSalesforceData(salesforceResult)
  return `\nSalesforce CRM Data:\n\n${salesforceResult.context}\n${formattedData ? `\nFormatted Data (present this to the user):\n${formattedData}\n` : ''}\n`
})() : ''}
${tabularResult ? `\n${tabularResult.context}\n` : ''}
${context ? `${webUsed ? 'Context (each item is labeled [INT-n] internal document or [WEB-n] web source):' : 'Relevant content from documents:'}\n\n${truncateToTokenLimit(context)}` : (tabularResult || salesforceResult) ? '' : 'No relevant document content found for this query.'}`

  const history = recentHistory
    .reverse()
    .slice(0, -1)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

  // The stream and sseSend() were created earlier (before MCP processing) so MCP steps
  // are already emitted in real-time. Now populate the stream with the LLM response.
  ;(async () => {
    try {
      sseSend({ type: 'start', userMessageId: userMsg.id })

      if (skipRetrieval) {
        collectStep('Processing your message...', 'info')
        sseSend({ type: 'thinking', step: 'Processing your message...', index: steps.length })
      }

      let fullContent = ''
      for await (const chunk of chatStream(systemPrompt, sanitizeForPrompt(content), history, provider)) {
        fullContent += chunk
        sseSend({ type: 'delta', content: chunk })
      }

        // Post-generation hallucination check — compares the composed prose against the
        // raw Salesforce data it was supposed to summarize. Can't un-stream what the user
        // already saw, but this sends a follow-up disclaimer and logs for tracking.
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
            sseSend({ type: 'thinking', action: 'detectHallucination', step: 'Potential hallucination detected', result: allIssues.join(' | ') })
          } else {
            sseSend({ type: 'thinking', action: 'detectHallucination', step: 'Hallucination check passed', result: 'No issues found' })
          }
        }

        const [assistantMsg] = await db
          .insert(messages)
          .values({
            spaceId,
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

        // Follow-up suggestions — generate 2-3 clickable follow-up questions
        // Wrapped in try-catch so a failure here NEVER blocks the done event
        let suggestions: string[] = []
        if (features.followUpSuggestions && salesforceResult && fullContent.length > 50) {
          try {
            suggestions = await generateFollowUpSuggestions(content, fullContent)
          } catch (sErr) {
            console.warn('[chat] Follow-up suggestions failed (non-blocking):', sErr)
          }
        }

        sseSend({ type: 'done', assistantMessageId: assistantMsg.id, userMessageId: userMsg.id, citations, documentImages, suggestions })
      } catch (err) {
        console.error('[chat] Stream error:', err)
        try {
          const [assistantMsg] = await db
            .insert(messages)
            .values({ spaceId, userId, role: 'assistant', content: 'I encountered an error. Please try again.' })
            .returning()
          sseSend({ type: 'error', message: 'Something went wrong. Please try again.', assistantMessageId: assistantMsg.id })
        } catch (dbErr) {
          console.error('[chat] Failed to save error message to DB:', dbErr)
          sseSend({ type: 'error', message: 'Something went wrong. Please try again.' })
        }
      } finally {
        ctrl.close()
      }
  })()

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}
