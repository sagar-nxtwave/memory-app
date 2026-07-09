import type { SearchDepth, WebSearchProviderName } from './types'

// All web-search settings come from environment variables (no hardcoding, no secrets in code).
// Read lazily per-call so tests / runtime env changes are picked up without a rebuild.

export interface WebSearchConfig {
  enabled: boolean
  provider: WebSearchProviderName
  maxResults: number
  depth: SearchDepth
  timeoutMs: number
  cacheEnabled: boolean
  cacheTtlMinutes: number
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback
  return /^(1|true|yes|on)$/i.test(v.trim())
}

function int(v: string | undefined, fallback: number): number {
  const n = parseInt(v ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function getWebSearchConfig(): WebSearchConfig {
  const provider = (process.env.WEB_SEARCH_PROVIDER ?? 'tavily').toLowerCase() as WebSearchProviderName
  const depth = (process.env.WEB_SEARCH_DEPTH ?? 'basic').toLowerCase() as SearchDepth

  // Enabled only if explicitly on AND the selected provider actually has an API key —
  // otherwise web search silently no-ops and chat falls back to internal RAG (never errors).
  const flagOn = bool(process.env.WEB_SEARCH_ENABLED, true)
  const hasKey = providerHasKey(provider)

  return {
    enabled: flagOn && hasKey,
    provider,
    maxResults: int(process.env.WEB_SEARCH_MAX_RESULTS, 5),
    depth: depth === 'advanced' ? 'advanced' : 'basic',
    timeoutMs: int(process.env.WEB_SEARCH_TIMEOUT_MS, 10_000),
    // Default OFF during active tuning so stale cached results can't mask code changes.
    cacheEnabled: bool(process.env.WEB_SEARCH_CACHE_ENABLED, false),
    cacheTtlMinutes: int(process.env.WEB_SEARCH_CACHE_TTL_MINUTES, 60),
  }
}

export function providerHasKey(provider: WebSearchProviderName): boolean {
  switch (provider) {
    case 'tavily': return !!process.env.TAVILY_API_KEY
    case 'exa':    return !!process.env.EXA_API_KEY
    case 'brave':  return !!process.env.BRAVE_API_KEY
    case 'bing':   return !!process.env.BING_API_KEY
    case 'google': return !!process.env.GOOGLE_SEARCH_API_KEY
    default:       return false
  }
}
