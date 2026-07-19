import { chatJson } from './provider'
import { intentRouterPrompt } from './prompts'

// Semantic intent routing — one AI call that decides which retrieval sources to use, instead
// of brittle per-source keyword regexes. Fixes the failure where CRM questions phrased
// without exact keywords ("how much sale last month", "units purchased") fell through to a
// default web search.

export interface Intent {
  salesforce: boolean
  documents: boolean
  web: boolean
  webConfidence: 'high' | 'low'
}

// Safe default when routing can't run (chitchat, or LLM failure): internal documents only —
// never web (web must be an explicit decision, never a silent fallback).
const DOCUMENTS_ONLY: Intent = { salesforce: false, documents: true, web: false, webConfidence: 'low' }

export async function classifyIntent(query: string): Promise<Intent> {
  try {
    const raw = await chatJson(intentRouterPrompt(), query)
    // Try to extract JSON from the response even if wrapped in text
    const jsonMatch = raw.match(/\{[^}]*"salesforce"[^}]*\}/)
    if (!jsonMatch) {
      console.error('[intentRouter] no JSON found in response:', raw.slice(0, 200))
      return DOCUMENTS_ONLY
    }
    const parsed = JSON.parse(jsonMatch[0]) as Partial<Intent>
    const web = parsed.web === true
    // Determine web confidence: high if the question clearly needs external info,
    // low if it's ambiguous (e.g., "who is X?" could be CRM or web)
    let webConfidence: 'high' | 'low' = 'low'
    if (web) {
      const q = query.toLowerCase()
      // High confidence: clear external signals
      const clearSignals = /\b(what is|what are|who is|who are|when was|when did|where is|where was|how many|how much|latest|recent|current|today|news|weather|price of|definition of|meaning of|ikipedia)\b/i.test(q)
      // Low confidence: could be CRM (e.g., "who is cognita?" might be a customer)
      const ambiguousSignals = /\b(who|what|which)\s+(is|are|was|were)\s+\w+\??$/i.test(q)
      webConfidence = clearSignals && !ambiguousSignals ? 'high' : 'low'
    }
    const intent: Intent = {
      salesforce: parsed.salesforce === true,
      documents: parsed.documents === true,
      web,
      webConfidence,
    }
    // Guarantee at least one source; if the model returned all-false, fall back to documents.
    if (!intent.salesforce && !intent.documents && !intent.web) return DOCUMENTS_ONLY
    return intent
  } catch (err) {
    console.error('[intentRouter] classification failed, defaulting to documents-only:', err)
    return DOCUMENTS_ONLY
  }
}
