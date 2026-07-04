import { NextRequest, NextResponse } from 'next/server'
import { and, eq, desc } from 'drizzle-orm'

export const maxDuration = 60
import { sql } from 'drizzle-orm'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { messages, spaceMembers, documents } from '@/lib/db/schema'
import { generateEmbedding, chatStream, rerankChunks } from '@/lib/ai/provider'
import { chatPrompt, styleInstruction } from '@/lib/ai/prompts'
import { sanitizeForPrompt, truncateToTokenLimit } from '@/lib/utils/sanitize'
import { formatDateTime } from '@/lib/utils/date'
import { parseQueryFilters, isFinancialQuery, wantsVisual } from '@/lib/utils/queryFilters'

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
    })
    .from(messages)
    .where(eq(messages.spaceId, spaceId))
    .orderBy(messages.createdAt)
    .limit(50)

  return NextResponse.json(history)
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { spaceId, content, spaceName, responseStyle, mentionedDocIds } = await req.json()

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

  let queryEmbedding: number[] = []
  try {
    queryEmbedding = await generateEmbedding(content)
  } catch (err) {
    console.error('[chat] Embedding failed:', err)
  }

  const embeddingStr = `[${queryEmbedding.join(',')}]`

  const hasMentions = Array.isArray(mentionedDocIds) && mentionedDocIds.length > 0
  const financialBoost = isFinancialQuery(content)
    ? sql` + CASE WHEN dc.contains_numbers = true OR dc.chunk_type IN ('table', 'financial') THEN 0.15 ELSE 0 END`
    : sql``

  // Metadata filters derived from natural language hints in the query
  const filters = parseQueryFilters(content)
  const fileTypeFilter = filters.fileTypes.length > 0
    ? sql` AND d.file_type = ANY(${filters.fileTypes}::text[])`
    : sql``
  const afterFilter = filters.afterDate
    ? sql` AND d.created_at >= ${filters.afterDate.toISOString()}`
    : sql``
  const beforeFilter = filters.beforeDate
    ? sql` AND d.created_at <= ${filters.beforeDate.toISOString()}`
    : sql``

  const relevantChunks = queryEmbedding.length === 0 ? [] : hasMentions
    ? await db.execute(sql`
        SELECT dc.content, dc.document_id, d.name as document_name,
               (0.6 * (1 - (dc.embedding <=> ${embeddingStr}::vector)) +
                0.4 * ts_rank(to_tsvector('simple', dc.content), websearch_to_tsquery('simple', ${content}))
                ${financialBoost}) AS hybrid_score
        FROM document_chunks dc
        INNER JOIN documents d ON d.id = dc.document_id
        WHERE d.space_id = ${spaceId}
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
        SELECT dc.content, dc.document_id, d.name as document_name,
               (0.6 * (1 - (dc.embedding <=> ${embeddingStr}::vector)) +
                0.4 * ts_rank(to_tsvector('simple', dc.content), websearch_to_tsquery('simple', ${content}))
                ${financialBoost}) AS hybrid_score
        FROM document_chunks dc
        INNER JOIN documents d ON d.id = dc.document_id
        WHERE d.space_id = ${spaceId}
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

  const rawChunks = relevantChunks as unknown as { content: string; document_id: string; document_name: string }[]

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
      WHERE d.space_id = ${spaceId}
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
        WHERE d.space_id = ${spaceId}
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

  const reranked = await rerankChunks(content, rawChunks, 5)
  const citations = [...new Set(reranked.map((c) => c.document_name))].map((name) => ({ documentName: name }))

  const context = reranked
    .map((c) => `[From: ${c.document_name}]\n${c.content.replace(/!\[[^\]]*\]\([^)]*\)/g, '')}`)
    .join('\n\n---\n\n')

  const spaceDocs = await db
    .select({ id: documents.id, name: documents.name, createdAt: documents.createdAt, fileType: documents.fileType })
    .from(documents)
    .where(and(eq(documents.spaceId, spaceId), eq(documents.status, 'ready')))
    .orderBy(desc(documents.createdAt))

  const docManifest = spaceDocs.length > 0
    ? `Documents in this space (${spaceDocs.length} total):\n${spaceDocs.map((d, i) => `${i + 1}. ${d.name} (${d.fileType ?? 'unknown'}, uploaded ${formatDateTime(d.createdAt)})`).join('\n')}`
    : 'No documents have been uploaded to this space yet.'

  const recentHistory = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(and(eq(messages.spaceId, spaceId)))
    .orderBy(desc(messages.createdAt))
    .limit(10)

  const focusNote = hasMentions
    ? `\nThe user has focused this question on specific document(s): ${mentionedDocIds.map((id: string) => { const d = spaceDocs.find((x) => x.id === id); return d ? d.name : id }).join(', ')}. Answer exclusively from those documents.`
    : ''

  const imageNote = documentImages.length > 0
    ? `\nIMPORTANT: The following ${documentImages.length} image(s) are already displayed to the user below your response, in this exact order:\n${documentImages.map((img, i) => `${i + 1}. ${img.alt}`).join('\n')}\nWhen answering, identify which numbered image(s) answer the question and describe them directly by their content (e.g. "Image 2 below shows..."). Never tell the user to scroll, search, or look through the images themselves — you already know which one(s) are relevant. Never say images are missing, corrupted, or inaccessible.`
    : ''

  const systemPrompt = `${chatPrompt(spaceName ?? 'this project')}
${styleInstruction(responseStyle)}${focusNote}${imageNote}

${docManifest}

${context ? `Relevant content from documents:\n\n${truncateToTokenLimit(context)}` : 'No relevant document content found for this query.'}`

  const history = recentHistory
    .reverse()
    .slice(0, -1)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

  const encoder = new TextEncoder()
  const userId = session.user.id

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))

      try {
        send({ type: 'start', userMessageId: userMsg.id })

        let fullContent = ''
        for await (const chunk of chatStream(systemPrompt, sanitizeForPrompt(content), history)) {
          fullContent += chunk
          send({ type: 'delta', content: chunk })
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
          })
          .returning()

        send({ type: 'done', assistantMessageId: assistantMsg.id, userMessageId: userMsg.id, citations, documentImages })
      } catch (err) {
        console.error('[chat] Stream error:', err)
        try {
          const [assistantMsg] = await db
            .insert(messages)
            .values({ spaceId, userId, role: 'assistant', content: 'I encountered an error. Please try again.' })
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
