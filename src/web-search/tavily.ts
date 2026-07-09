import type { ProviderSearchOptions, WebSearchProvider, WebSearchResponse, WebSearchResult } from './types'
import { domainOf } from './fetch'

// Genuine news / real-time queries — these benefit from Tavily's `news` topic + a recent
// window. Kept NARROW: generic freshness words like "currently"/"latest" must NOT force news
// mode, or entity questions ("what is Nshama doing currently") get starved into an empty
// 3-day news window instead of a normal web answer.
const NEWS_RE = /\b(news|headlines?|breaking|stock market|stocks?|sensex|nifty|share price|index points|live score|match score|exchange rate|weather forecast)\b/i

// Broader "freshness" signal — warrants advanced depth (better sources) but stays on the
// general topic so results aren't restricted to the last few days.
const FRESH_RE = /\b(today|tonight|now|current(ly)?|latest|recent(ly)?|this (week|month)|as of|up[- ]?to[- ]?date|20\d{2})\b/i

// Recent-news window (days) when the news topic is used — generous so it doesn't return empty.
const NEWS_WINDOW_DAYS = 14

// Tavily provider. All Tavily-specific request/response handling is confined to this file —
// the rest of the app only sees the normalized WebSearchResult[] via the WebSearchProvider
// interface, so adding Exa/Brave/Bing later means writing a sibling file, nothing more.

const TAVILY_ENDPOINT = 'https://api.tavily.com/search'

interface TavilyResult {
  title?: string
  url?: string
  content?: string        // snippet
  raw_content?: string    // full page content (when include_raw_content = true)
  score?: number
  published_date?: string
}

export class TavilyProvider implements WebSearchProvider {
  readonly name = 'tavily' as const

  async search(query: string, opts: ProviderSearchOptions): Promise<WebSearchResponse> {
    const apiKey = process.env.TAVILY_API_KEY
    if (!apiKey) throw new Error('TAVILY_API_KEY is not set')

    const isNews = NEWS_RE.test(query)
    const isFresh = isNews || FRESH_RE.test(query)
    const topic = isNews ? 'news' : 'general'
    // Escalate to advanced depth for news/fresh queries even if config says basic — basic
    // depth is where the "generic homepage" results come from.
    const depth = isFresh ? 'advanced' : opts.depth

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
    try {
      const res = await fetch(TAVILY_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          api_key: apiKey,
          query,
          search_depth: depth,
          topic,
          ...(topic === 'news' ? { days: NEWS_WINDOW_DAYS } : {}),
          max_results: opts.maxResults,
          include_raw_content: true,
          include_answer: 'advanced',  // Tavily-synthesized answer — usually holds the actual figure
          include_images: false,
        }),
      })

      if (!res.ok) {
        const err = await res.text().catch(() => res.statusText)
        throw new Error(`Tavily error ${res.status}: ${err.slice(0, 300)}`)
      }

      const data = await res.json()
      const raw: TavilyResult[] = Array.isArray(data.results) ? data.results : []

      const results = raw
        .filter((r) => r.url)
        .map((r) => {
          const url = r.url as string
          const full = (r.raw_content ?? '').trim()
          return {
            title: (r.title ?? url).trim(),
            url,
            domain: domainOf(url),
            publishedDate: r.published_date ?? null,
            snippet: (r.content ?? '').trim(),
            fullContent: full || (r.content ?? '').trim(),
            score: typeof r.score === 'number' ? r.score : 0,
          } satisfies WebSearchResult
        })

      const answer = typeof data.answer === 'string' && data.answer.trim() ? data.answer.trim() : null
      return { results, answer }
    } finally {
      clearTimeout(timer)
    }
  }
}
