'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import { Digest, SpaceSignal, SpaceCard, openCreateSpace, computeRiskLevel, riskCountsBySpace, PortfolioHealthBar, type RiskLevel } from '@/components/portfolio-ui'

export default function SpacesListPage() {
  const router = useRouter()
  const [digest, setDigest] = useState<Digest | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [riskFilter, setRiskFilter] = useState<RiskLevel | null>(null)

  const load = useCallback(async () => {
    const res = await fetch('/api/portfolio/digest')
    if (res.ok) setDigest(await res.json())
    setLoading(false)
  }, [])

  useEffect(() => {
    let active = true
    ;(async () => {
      const res = await fetch('/api/portfolio/digest')
      if (active && res.ok) setDigest(await res.json())
      if (active) setLoading(false)
    })()
    const onCreated = () => load()
    window.addEventListener('space-created', onCreated)
    return () => { active = false; window.removeEventListener('space-created', onCreated) }
  }, [load])

  const spaces = (digest?.spaces ?? []).filter((s: SpaceSignal) => !s.name.toLowerCase().startsWith('test'))
  const riskCounts = riskCountsBySpace(digest?.recentDocuments ?? [])
  const spaceRiskLevels = new Map<string, RiskLevel>(spaces.map((s) => [s.id, computeRiskLevel(s, riskCounts.get(s.id) ?? 0)]))
  const healthCounts: Record<RiskLevel, number> = { critical: 0, watch: 0, healthy: 0, new: 0 }
  for (const level of spaceRiskLevels.values()) healthCounts[level]++

  const filtered = spaces
    .filter((s) => !query.trim() || s.name.toLowerCase().includes(query.trim().toLowerCase()))
    .filter((s) => !riskFilter || spaceRiskLevels.get(s.id) === riskFilter)

  return (
    <div className="relative min-h-full overflow-y-auto bg-[radial-gradient(circle_at_50%_0%,#faf9f9_68%,#e2e8f0_100%)] dark:bg-[#0a0a0a] dark:bg-none">
      <div className="w-full max-w-2xl md:max-w-5xl mx-auto px-4 md:px-8 pt-[calc(max(1rem,env(safe-area-inset-top))+5.25rem)] md:pt-10 pb-40 md:pb-16">

        <h1 className="font-sf t-title font-normal text-[#0F172A] dark:text-white mb-5">Spaces</h1>

        {/* -- Portfolio health at a glance — click a pill to filter -- */}
        {!loading && <PortfolioHealthBar counts={healthCounts} active={riskFilter} onFilter={setRiskFilter} />}

        {/* Search */}
        <div className="relative mb-6 md:max-w-xl">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-4 top-1/2 -translate-y-1/2 text-[#94A3B8]">
            <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search spaces"
            className="font-sf w-full pl-11 pr-4 py-3.5 text-[16px] rounded-full bg-white dark:bg-[#111] shadow-[0_4px_16px_rgba(0,0,0,0.04)] ring-1 ring-black/[0.02] dark:ring-white/5 outline-none text-[#0F172A] dark:text-white placeholder:text-[#94A3B8]"
          />
        </div>

        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-4 p-2 pr-4 rounded-3xl bg-white/70 dark:bg-[#111] shadow-[0_4px_16px_rgba(0,0,0,0.04)] ring-1 ring-black/[0.02] dark:ring-white/5">
                <div className="w-[72px] h-[72px] rounded-[18px] shimmer" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-2/5 rounded shimmer" />
                  <div className="h-3 w-3/5 rounded shimmer" />
                </div>
                <div className="w-7 h-7 rounded-full shimmer" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <p className="font-sf text-[15px] tracking-[-0.0153em] text-[#64748B] dark:text-slate-400 mb-5">
              {query.trim() || riskFilter ? 'No spaces match your filters.' : 'No spaces yet.'}
            </p>
            {!query.trim() && !riskFilter && (
              <motion.button
                whileTap={{ scale: 0.97 }}
                onClick={openCreateSpace}
                className="px-5 py-2.5 text-sm font-medium bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-xl hover:bg-slate-700 dark:hover:bg-gray-100 transition-colors"
              >
                New space
              </motion.button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {filtered.map((space, i) => (
              <SpaceCard key={space.id} space={space} index={i} riskLevel={spaceRiskLevels.get(space.id)} onClick={() => router.push(`/spaces/${space.id}?name=${encodeURIComponent(space.name)}`)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
