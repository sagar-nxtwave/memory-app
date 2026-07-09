import type { WebSearchProvider, WebSearchProviderName } from './types'
import { TavilyProvider } from './tavily'

// Provider registry. To add a new search backend: implement WebSearchProvider in its own
// file and register the factory here — no other file changes.

type ProviderFactory = () => WebSearchProvider

const REGISTRY: Partial<Record<WebSearchProviderName, ProviderFactory>> = {
  tavily: () => new TavilyProvider(),
  // exa:   () => new ExaProvider(),
  // brave: () => new BraveProvider(),
  // bing:  () => new BingProvider(),
  // google:() => new GoogleProvider(),
}

export function getProvider(name: WebSearchProviderName): WebSearchProvider {
  const factory = REGISTRY[name]
  if (!factory) throw new Error(`Web search provider "${name}" is not implemented/registered`)
  return factory()
}

export function isProviderRegistered(name: WebSearchProviderName): boolean {
  return !!REGISTRY[name]
}
