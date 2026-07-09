import type { RetrievalItem } from './types'

// Builds the labeled context string the LLM reads, and the citation objects the UI renders.
// Every context item carries a stable handle ([INT-n] / [WEB-n]) so the model can attribute
// each statement back to a source, and the UI can separate Internal vs Web sources.

// Cap per-item content so a few long web pages can't blow the context budget.
const MAX_ITEM_CHARS = 2_500

/**
 * Assign stable citation IDs (INT-1, WEB-1, …) to merged items, preserving their given order
 * (which is the post-rerank relevance order). Internal and web are numbered independently.
 */
export function assignCitationIds(items: RetrievalItem[]): RetrievalItem[] {
  let int = 0
  let web = 0
  return items.map((item) => ({
    ...item,
    id: item.sourceType === 'web' ? `WEB-${++web}` : `INT-${++int}`,
  }))
}

/** Render the combined, labeled context block sent to the LLM. */
export function buildContext(items: RetrievalItem[]): string {
  return items
    .map((item) => {
      const content = item.content.replace(/!\[[^\]]*\]\([^)]*\)/g, '').slice(0, MAX_ITEM_CHARS).trim()
      if (item.sourceType === 'web') {
        // Synthesis item (no URL) — grounds the answer but isn't a standalone clickable source.
        if (!item.url) return `[${item.id}] ${item.title}\n${content}`
        const meta = [item.domain, item.publishedDate].filter(Boolean).join(', ')
        return `[${item.id}] ${item.title}${meta ? ` (${meta})` : ''}\nURL: ${item.url}\n${content}`
      }
      const src = item.spaceName ? `${item.spaceName} › ${item.documentName}` : item.documentName
      return `[${item.id}] ${src}\n${content}`
    })
    .join('\n\n---\n\n')
}

// UI-facing citation shape — extends the existing internal citation with optional web fields.
// (Existing rows have documentId+documentName; web rows have url+sourceType='web'.)
export interface Citation {
  documentId?: string
  documentName: string
  spaceName?: string
  url?: string
  sourceType?: 'internal' | 'web'
  citationId?: string   // INT-1 / WEB-2 — lets the UI match inline markers if desired
}

/** Convert merged items into UI citations, de-duped, preserving order. */
export function toCitations(items: RetrievalItem[]): Citation[] {
  const out: Citation[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (item.sourceType === 'web') {
      const key = `web|${item.url}`
      if (!item.url || seen.has(key)) continue
      seen.add(key)
      out.push({
        documentName: item.title || item.domain || item.url,
        url: item.url,
        sourceType: 'web',
        citationId: item.id,
      })
    } else {
      const key = `int|${item.spaceName ?? ''}|${item.documentName ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        documentId: item.documentId,
        documentName: item.documentName ?? 'Document',
        spaceName: item.spaceName,
        sourceType: 'internal',
        citationId: item.id,
      })
    }
  }
  return out
}
