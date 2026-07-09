// HTML → clean plain text. The LLM must NEVER receive raw HTML — it wastes tokens and
// injects markup noise. Used by fetch.ts when a provider doesn't return usable full content.

const BLOCK_TAGS = /<\/(p|div|section|article|li|tr|h[1-6]|br)>/gi

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
}

/** Strip scripts/styles/markup, decode common entities, collapse whitespace. */
export function htmlToText(html: string): string {
  if (!html) return ''
  return html
    // Drop non-content regions entirely
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Preserve rough line structure before removing tags
    .replace(BLOCK_TAGS, '\n')
    .replace(/<[^>]+>/g, ' ')
    // Decode entities
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? ' ')
    // Normalize whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n')
    .trim()
}

/** Extract the page <title>, if any (used as a fallback result title). */
export function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  return m ? htmlToText(m[1]).slice(0, 200) : ''
}
