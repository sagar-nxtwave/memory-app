import type { Reranker, RetrievalItem } from './types'
import { rerankChunks } from '@/lib/ai/provider'

// Pluggable reranking layer over the MERGED internal+web context list. The default reuses
// the app's existing cross-encoder reranker (Cohere via OpenRouter); it degrades to score
// order on failure. Swap in BGE/Jina later by implementing Reranker and passing it to the
// orchestrator — nothing else changes.

export const cohereReranker: Reranker = {
  async rerank(query, items, topN) {
    if (items.length === 0) return []
    // rerankChunks<T extends {content}> handles the ordering + top-N and fails soft.
    return rerankChunks(query, items, topN)
  },
}

/**
 * Fallback reranker — pure cosine-free heuristic ordering by the item's own score
 * (web provider score / internal hybrid score). Used if no reranker is supplied.
 */
export const scoreReranker: Reranker = {
  async rerank(_query, items, topN) {
    return [...items].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, topN)
  },
}
