// Public entry point for the web search subsystem. Routes should import from here only.

import type { Reranker, RetrievalItem, WebSearchResult } from './types'
import { getWebSearchConfig, type WebSearchConfig } from './config'
import { webSearch } from './search'
import { cohereReranker } from './rerank'
import { rerankWithScores } from '@/lib/ai/provider'
import { assignCitationIds, buildContext, toCitations, type Citation } from './citations'

// Minimum rerank relevance for an internal document to be included/cited alongside web
// results. Cohere rerank-v3.5 scores clearly-relevant chunks well above this and unrelated
// ones far below, so it cleanly drops "uploaded file that has nothing to do with the question".
const INTERNAL_RELEVANCE_MIN = 0.3

export { getWebSearchConfig } from './config'
export type { Citation } from './citations'
export type { RetrievalItem } from './types'

function toRetrievalItem(r: WebSearchResult): RetrievalItem {
  return {
    id: '',
    sourceType: 'web',
    content: r.fullContent || r.snippet,
    title: r.title,
    url: r.url,
    domain: r.domain,
    publishedDate: r.publishedDate,
    score: r.score,
  }
}

export interface MergeResult {
  webUsed: boolean
  items: RetrievalItem[]
  context: string
  citations: Citation[]
}

/**
 * Given the caller's already-retrieved INTERNAL items, decide whether to add a web search,
 * and if so run it, merge, rerank the combined set, and produce the labeled context +
 * citations. If web isn't needed or returns nothing, `webUsed` is false and the caller
 * should keep its existing internal-only path (this never mutates the internal pipeline).
 *
 * @param query    the user's question
 * @param internal internal RAG results normalized to RetrievalItem (id may be blank)
 * @param topN     max items to keep after reranking the merged set
 * @param config   resolved web-search config (defaults to env)
 * @param reranker reranker for the merged list (defaults to the Cohere cross-encoder)
 */
export async function retrieveAndMerge(params: {
  query: string
  internal: RetrievalItem[]
  topN: number
  config?: WebSearchConfig
  reranker?: Reranker
}): Promise<MergeResult> {
  const { query, internal, topN } = params
  const config = params.config ?? getWebSearchConfig()
  const reranker = params.reranker ?? cohereReranker

  // The caller (semantic intent router) has already decided web is wanted; we only guard on
  // whether the provider is configured.
  if (!config.enabled) {
    return { webUsed: false, items: [], context: '', citations: [] }
  }

  const { results: webResults, answer } = await webSearch(query, config)
  if (webResults.length === 0 && !answer) {
    return { webUsed: false, items: [], context: '', citations: [] }
  }

  // Reserve slots per source so a single rerank over the merged set can't starve out ALL web
  // results (which happened for "what is Nshama doing" — internal docs mentioning "Nshama"
  // out-ranked the web pages, leaving zero web citations). Rerank each pool separately.
  const webPool = webResults.map(toRetrievalItem)
  const webQuota = Math.min(webPool.length, Math.max(2, Math.floor(topN / 2)))
  const webPick = await reranker.rerank(query, webPool, webQuota)

  // Only keep internal docs that are ACTUALLY relevant to the question — otherwise a pure web
  // question (e.g. "what is Nshama doing") would still cite unrelated uploaded files as
  // sources, which is misleading. Threshold by rerank relevance score; drop the rest.
  const internalScored = internal.length > 0
    ? await rerankWithScores(query, internal, Math.max(0, topN - webPick.length))
    : []
  const internalPick = internalScored
    .filter((r) => r.score >= INTERNAL_RELEVANCE_MIN)
    .map((r) => r.item)

  // The provider's synthesized answer (Tavily include_answer) usually holds the direct answer
  // for factual/time-sensitive queries. Pin it first and never let rerank drop it. It has no
  // URL, so it grounds the response but isn't itself a clickable citation — the real sources
  // (which the synthesis is built from) are cited separately.
  const answerItem: RetrievalItem[] = answer
    ? [{ id: '', sourceType: 'web', content: answer, title: 'Web search synthesis' }]
    : []
  const withIds = assignCitationIds([...answerItem, ...internalPick, ...webPick])

  return {
    webUsed: true,
    items: withIds,
    context: buildContext(withIds),
    citations: toCitations(withIds),
  }
}
