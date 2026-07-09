// Shared, provider-independent types for the web search subsystem.
// Nothing here references Tavily (or any specific provider) — provider-specific shapes live
// only inside their own file (e.g. tavily.ts) and are normalized to WebSearchResult before
// leaving the provider layer.

export type WebSearchProviderName = 'tavily' | 'exa' | 'brave' | 'bing' | 'google'

export type SearchDepth = 'basic' | 'advanced'

/** Normalized result shape every provider must return. */
export interface WebSearchResult {
  title: string
  url: string
  domain: string
  publishedDate: string | null
  snippet: string
  fullContent: string
  score: number
}

/** Options passed down to a provider for a single search. */
export interface ProviderSearchOptions {
  maxResults: number
  depth: SearchDepth
  timeoutMs: number
}

/** A provider's full response: normalized results + an optional provider-synthesized answer. */
export interface WebSearchResponse {
  results: WebSearchResult[]
  answer: string | null   // provider's direct synthesis of the query (e.g. Tavily include_answer)
}

/** Contract every search provider implements. Add a new provider = implement this + register it. */
export interface WebSearchProvider {
  readonly name: WebSearchProviderName
  search(query: string, opts: ProviderSearchOptions): Promise<WebSearchResponse>
}

export type SourceType = 'internal' | 'web'

/**
 * Unified retrieval item — both internal RAG chunks and web results are normalized to this
 * shape before merging/reranking, so the LLM sees one consistent, labeled context list.
 */
export interface RetrievalItem {
  id: string            // stable citation handle, e.g. "INT-1" | "WEB-3"
  sourceType: SourceType
  content: string       // text sent to the LLM (never raw HTML)
  title: string
  // internal-only
  documentId?: string
  documentName?: string
  spaceName?: string
  // web-only
  url?: string
  domain?: string
  publishedDate?: string | null
  score?: number
}

/** Reranker contract — swap cosine → Cohere → BGE → Jina without touching callers. */
export interface Reranker {
  rerank(query: string, items: RetrievalItem[], topN: number): Promise<RetrievalItem[]>
}

/** Query classifier decision — whether to hit internal memory, the web, or both. */
export interface SearchDecision {
  useInternal: boolean
  useWeb: boolean
  reason: string
}
