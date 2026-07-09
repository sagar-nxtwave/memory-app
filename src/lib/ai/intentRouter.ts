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
}

// Safe default when routing can't run (chitchat, or LLM failure): internal documents only —
// never web (web must be an explicit decision, never a silent fallback).
const DOCUMENTS_ONLY: Intent = { salesforce: false, documents: true, web: false }

export async function classifyIntent(query: string): Promise<Intent> {
  try {
    const raw = await chatJson(intentRouterPrompt(), query)
    const parsed = JSON.parse(raw) as Partial<Intent>
    const intent: Intent = {
      salesforce: parsed.salesforce === true,
      documents: parsed.documents === true,
      web: parsed.web === true,
    }
    // Guarantee at least one source; if the model returned all-false, fall back to documents.
    if (!intent.salesforce && !intent.documents && !intent.web) return DOCUMENTS_ONLY
    return intent
  } catch (err) {
    console.error('[intentRouter] classification failed, defaulting to documents-only:', err)
    return DOCUMENTS_ONLY
  }
}
