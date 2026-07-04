'use client'

import { useCallback, useEffect, useState } from 'react'

export interface SpaceListItem {
  id: string
  name: string
  description?: string | null
}

// Module-level cache shared across every component that just needs to READ the spaces
// list (space detail page's "other projects", GlobalChatPanel's project filter). Without
// this, every mount (e.g. reopening the inline Ask panel) re-fetches /api/spaces even
// though the sidebar likely fetched the same data moments earlier. The sidebar itself
// keeps its own fetch — it also mutates (rename/delete/create) and stays mounted for the
// whole session, so it doesn't have this duplicate-fetch-per-mount problem.
let cache: SpaceListItem[] | null = null
let inFlight: Promise<SpaceListItem[]> | null = null
const subscribers = new Set<(spaces: SpaceListItem[]) => void>()

function fetchSpaces(): Promise<SpaceListItem[]> {
  if (inFlight) return inFlight
  inFlight = fetch('/api/spaces')
    .then((r) => (r.ok ? r.json() : []))
    .then((d) => (Array.isArray(d) ? d : []))
    .catch(() => cache ?? [])
    .finally(() => { inFlight = null })
  return inFlight
}

function setCache(spaces: SpaceListItem[]) {
  cache = spaces
  subscribers.forEach((cb) => cb(spaces))
}

export function useSpacesList() {
  const [spaces, setSpaces] = useState<SpaceListItem[]>(cache ?? [])
  const [loaded, setLoaded] = useState(cache !== null)

  const reload = useCallback(() => {
    fetchSpaces().then(setCache)
  }, [])

  useEffect(() => {
    subscribers.add(setSpaces)
    // Initial state already captured `cache` at construction time — only fetch if it was
    // null then (first consumer ever, or cache was cleared).
    if (cache === null) {
      fetchSpaces().then((d) => { setCache(d); setLoaded(true) })
    }
    return () => { subscribers.delete(setSpaces) }
  }, [])

  // Same invalidation signal the sidebar already fires on create
  useEffect(() => {
    window.addEventListener('space-created', reload)
    return () => window.removeEventListener('space-created', reload)
  }, [reload])

  return { spaces, loaded, reload }
}
