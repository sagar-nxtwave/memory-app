import type { SearchDecision } from './types'

// Decides whether a question needs live web data, internal memory, or both.
//
// v1 is a fast, zero-cost heuristic (no extra LLM call on every message). Internal memory is
// ALWAYS consulted (cheap, it's the product's core), so this really decides whether to ADD a
// web search. Kept as a single pure function so it can later be swapped for / backed by an
// LLM classifier without changing callers.

// Signals the question is clearly about the user's OWN data — for these we do NOT spend a web
// search (the documents/structured tables are authoritative and web results would only add
// noise). Everything else defaults to ALSO searching the web, so the assistant behaves like a
// general assistant with the user's files attached — instead of dead-ending on "Not in
// documents" whenever a fact happens not to be in an uploaded file.
const INTERNAL_ONLY_SIGNALS: RegExp[] = [
  /\b(my|our|this|the) (document|doc|file|project|space|spreadsheet|contract|deal|report|dataset|sheet)\b/i,
  /\b(uploaded|attached|in the (doc|file|document|sheet|report|contract))\b/i,
  /\b(how many|list all|list every|total number|average|sum of|count of)\b/i,   // structured/tabular
  /\b(summar(y|ise|ize)|brief me|catch me up|key numbers|risks?|decisions?)\b/i, // doc-scoped asks
]

export function classifyQuery(query: string): SearchDecision {
  const q = query.trim()
  if (!q) return { useInternal: true, useWeb: false, reason: 'empty query' }

  const internalOnly = INTERNAL_ONLY_SIGNALS.some((re) => re.test(q))
  if (internalOnly) {
    return { useInternal: true, useWeb: false, reason: "question targets the user's own data" }
  }

  // Default: consult both. Internal RAG is preferred by the prompt when it answers; the web
  // fills the gap so a general/external question doesn't dead-end on "Not in documents".
  return { useInternal: true, useWeb: true, reason: 'general/external question — augmenting with web' }
}
