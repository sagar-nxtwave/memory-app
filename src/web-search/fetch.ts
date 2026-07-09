import { htmlToText } from './parser'

// Fallback page fetcher — used only when a provider returns a result WITHOUT usable full
// content (Tavily with include_raw_content usually does return it, so this rarely runs).
// Times out fast and fails soft (returns '') so one slow/blocked page can't stall an answer.

const MAX_CONTENT_CHARS = 12_000

export async function fetchPageContent(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MemoryBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    })
    if (!res.ok) return ''
    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) return ''
    const html = await res.text()
    return htmlToText(html).slice(0, MAX_CONTENT_CHARS)
  } catch {
    return '' // timeout, network error, blocked — caller falls back to snippet
  } finally {
    clearTimeout(timer)
  }
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}
