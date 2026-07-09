import { createHash } from 'crypto'
import { and, eq, gt } from 'drizzle-orm'
import { db } from '@/lib/db'
import { webSearchCache, webSearchLogs } from '@/lib/db/schema'
import { mapWithConcurrency } from '@/lib/utils/concurrency'
import type { WebSearchResponse, WebSearchResult } from './types'
import type { WebSearchConfig } from './config'
import { getProvider } from './provider'
import { fetchPageContent } from './fetch'

// Orchestrates a single web search: cache lookup → provider call → content backfill →
// cache store → request log. Fails soft (returns []) so a provider outage never breaks chat.

// Below this length a result's "full content" is really just a snippet — try to fetch the
// page for richer grounding. Tavily's include_raw_content usually makes this a no-op.
const MIN_FULL_CONTENT = 200
const MAX_FETCH_CONCURRENCY = 4

function hashQuery(query: string, config: WebSearchConfig): string {
  const norm = query.trim().toLowerCase().replace(/\s+/g, ' ')
  return createHash('sha256')
    .update(`${config.provider}|${config.depth}|${config.maxResults}|${norm}`)
    .digest('hex')
}

async function readCache(queryHash: string): Promise<WebSearchResponse | null> {
  try {
    const [row] = await db
      .select({ results: webSearchCache.results })
      .from(webSearchCache)
      .where(and(eq(webSearchCache.queryHash, queryHash), gt(webSearchCache.expiresAt, new Date())))
      .limit(1)
    if (!row) return null
    // Back-compat: older cache rows stored a bare results array; normalize to the response shape.
    const cached = row.results as WebSearchResponse | WebSearchResult[]
    return Array.isArray(cached) ? { results: cached, answer: null } : cached
  } catch {
    return null // cache is best-effort — never block search on a cache read failure
  }
}

async function writeCache(queryHash: string, query: string, config: WebSearchConfig, response: WebSearchResponse): Promise<void> {
  try {
    const expiresAt = new Date(Date.now() + config.cacheTtlMinutes * 60_000)
    await db
      .insert(webSearchCache)
      .values({ queryHash, query, provider: config.provider, results: response, expiresAt })
      .onConflictDoUpdate({
        target: webSearchCache.queryHash,
        set: { results: response, provider: config.provider, expiresAt, createdAt: new Date() },
      })
  } catch (err) {
    console.error('[web-search] cache write failed:', err)
  }
}

async function log(entry: { query: string; provider: string; latencyMs: number; resultsReturned: number; cacheHit: boolean; error?: string }): Promise<void> {
  try {
    await db.insert(webSearchLogs).values({
      query: entry.query,
      provider: entry.provider,
      latencyMs: entry.latencyMs,
      resultsReturned: entry.resultsReturned,
      cacheHit: entry.cacheHit,
      error: entry.error ?? null,
    })
  } catch (err) {
    console.error('[web-search] log write failed:', err)
  }
}

// Backfill weak full-content results by fetching + cleaning the page (bounded concurrency).
async function ensureContent(results: WebSearchResult[], timeoutMs: number): Promise<WebSearchResult[]> {
  return mapWithConcurrency(results, MAX_FETCH_CONCURRENCY, async (r) => {
    if (r.fullContent.length >= MIN_FULL_CONTENT) return r
    const fetched = await fetchPageContent(r.url, timeoutMs)
    return fetched.length > r.fullContent.length ? { ...r, fullContent: fetched } : r
  })
}

/**
 * Run a web search (with caching + logging). Returns normalized results + the provider's
 * synthesized answer, or an empty response on any failure (caller falls back to internal RAG).
 */
export async function webSearch(query: string, config: WebSearchConfig): Promise<WebSearchResponse> {
  const start = Date.now()
  const queryHash = hashQuery(query, config)

  if (config.cacheEnabled) {
    const cached = await readCache(queryHash)
    if (cached) {
      await log({ query, provider: config.provider, latencyMs: Date.now() - start, resultsReturned: cached.results.length, cacheHit: true })
      return cached
    }
  }

  try {
    const provider = getProvider(config.provider)
    const response = await provider.search(query, {
      maxResults: config.maxResults,
      depth: config.depth,
      timeoutMs: config.timeoutMs,
    })
    const results = await ensureContent(response.results, config.timeoutMs)
    const finalResponse: WebSearchResponse = { results, answer: response.answer }
    if (config.cacheEnabled) await writeCache(queryHash, query, config, finalResponse)
    await log({ query, provider: config.provider, latencyMs: Date.now() - start, resultsReturned: results.length, cacheHit: false })
    return finalResponse
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[web-search] search failed:', message)
    await log({ query, provider: config.provider, latencyMs: Date.now() - start, resultsReturned: 0, cacheHit: false, error: message.slice(0, 500) })
    return { results: [], answer: null } // graceful — caller continues with internal RAG only
  }
}
