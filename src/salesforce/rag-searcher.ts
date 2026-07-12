// Salesforce RAG searcher — semantic search over indexed Salesforce records
// (salesforce_chunks). Used as a fallback when the tool matcher can't find an exact
// tool match: instead of asking the user to clarify, we search actual indexed data
// and let the LLM compose an answer from real records it can see.
import { generateEmbedding } from '@/lib/ai/provider'
import { db } from '@/lib/db'
import { sql } from 'drizzle-orm'
import type { ToolResult } from './tools'

export interface RagSearchResult {
  objectName: string
  recordId: string
  content: string
  similarity: number
}

/**
 * Semantic search over indexed Salesforce data. Returns the top-K most similar records
 * across all indexed objects (or filtered to a specific object).
 */
export async function searchSalesforceData(
  query: string,
  opts: { limit?: number; objectName?: string } = {}
): Promise<RagSearchResult[]> {
  const limit = opts.limit ?? 40
  const queryEmbedding = await generateEmbedding(query)
  if (!queryEmbedding || queryEmbedding.length === 0) return []

  const vectorLiteral = `[${queryEmbedding.join(',')}]`

  const objectFilter = opts.objectName ? sql`AND object_name = ${opts.objectName}` : sql``

  const rows = await db.execute(sql`
    SELECT object_name, record_id, content, 1 - (embedding <=> ${vectorLiteral}::vector) AS similarity
    FROM salesforce_chunks
    WHERE embedding IS NOT NULL ${objectFilter}
    ORDER BY embedding <=> ${vectorLiteral}::vector
    LIMIT ${limit}
  `)

  const results = rows as unknown as { object_name: string; record_id: string; content: string; similarity: number }[]

  return results.map((r) => ({
    objectName: String(r.object_name),
    recordId: String(r.record_id),
    content: String(r.content),
    similarity: Number(r.similarity),
  }))
}

/**
 * High-level fallback: searches indexed data for the question and formats it as a
 * ToolResult, same shape as the pre-built tools return. Filters out low-similarity
 * matches (below 0.25) since those are noise, not relevant data.
 */
export async function ragFallback(query: string): Promise<ToolResult | null> {
  try {
    const results = await searchSalesforceData(query, { limit: 40 })
    const relevant = results.filter((r) => r.similarity >= 0.25)

    if (relevant.length === 0) return null

    // Group by object for a cleaner presentation
    const byObject = new Map<string, RagSearchResult[]>()
    for (const r of relevant) {
      const list = byObject.get(r.objectName) ?? []
      list.push(r)
      byObject.set(r.objectName, list)
    }

    const sections: string[] = []
    for (const [objectName, records] of byObject) {
      sections.push(`${objectName} (${records.length} relevant records):\n${records.map((r) => r.content).join('\n')}`)
    }

    const context = `Found via semantic search over indexed Salesforce data (top matches, may not be exhaustive — use for pattern/summary questions, not exact counts):\n\n${sections.join('\n\n')}`

    return { context, citation: { documentName: 'Salesforce (live CRM)' } }
  } catch (err) {
    console.error('[rag-searcher] search failed:', err)
    return null
  }
}
