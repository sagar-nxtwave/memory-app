'use client'

import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { motion } from 'framer-motion'
import {
  Digest, SpaceSignal, RecentDoc, greeting, Sparkle, ChevronRight, SpaceCard, openCreateSpace,
  computeRiskLevel, riskCountsBySpace, type RiskLevel,
} from '@/components/portfolio-ui'
import dynamic from 'next/dynamic'

const AttentionSheet = dynamic(() => import('@/components/attention-sheet').then(m => m.AttentionSheet), { ssr: false })
const GlobalChatPanel = dynamic(() => import('@/components/global-chat-panel').then(m => m.GlobalChatPanel), { ssr: false })

type SignalItem = { text: string; spaceName: string; spaceId: string }

export function HomeDashboard() {
  const router = useRouter()
  const { data: session } = useSession()
  const [digest, setDigest] = useState<Digest | null>(null)
  const [loading, setLoading] = useState(true)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [askOpen, setAskOpen] = useState(false)
  const [autoMic, setAutoMic] = useState(false)
  const [prefill, setPrefill] = useState('')

  useEffect(() => {
    let active = true
    ;(async () => {
      const res = await fetch('/api/portfolio/digest')
      if (active && res.ok) setDigest(await res.json())
      if (active) setLoading(false)
    })()
    return () => { active = false }
  }, [])

  const allSpaces = digest?.spaces ?? []
  const allDocsRaw = digest?.recentDocuments ?? []
  const spaces = allSpaces.filter((s: SpaceSignal) => !s.name.toLowerCase().startsWith('test'))
  const spaceIds = new Set(spaces.map((s) => s.id))
  const allDocs = allDocsRaw.filter((d: RecentDoc) => spaceIds.has(d.spaceId))

  const allSignals: SignalItem[] = []
  for (const doc of allDocs) {
    for (const r of doc.risks ?? []) allSignals.push({ text: r, spaceName: doc.spaceName, spaceId: doc.spaceId })
    for (const d of doc.decisions ?? []) allSignals.push({ text: d, spaceName: doc.spaceName, spaceId: doc.spaceId })
  }
  const visibleSignals = allSignals.slice(0, 2)
  const hasMoreSignals = allSignals.length > 2

  // Preview on the home; full list lives at /spaces (6 fills the desktop grid evenly)
  const previewSpaces = spaces.slice(0, 6)
  const hasMoreSpaces = spaces.length > previewSpaces.length

  // Portfolio risk heat-map — derived from status + extracted-risk counts, no new backend fields.
  // Surfaced as a small dot on each SpaceCard only (the "Need your attention" section above
  // already covers the summary — no need to duplicate it as a pill row here).
  const riskCounts = riskCountsBySpace(allDocs)
  const spaceRiskLevels = new Map<string, RiskLevel>(spaces.map((s) => [s.id, computeRiskLevel(s, riskCounts.get(s.id) ?? 0)]))

  // Picked once per mount so the greeting doesn't re-randomize on every re-render
  const greetingText = useMemo(() => greeting(session?.user?.name), [session?.user?.name])

  return (
    <div className="relative min-h-full overflow-y-auto bg-white dark:bg-[#0a0a0a]">
      <div className="w-full max-w-2xl md:max-w-5xl mx-auto px-4 md:px-8 pt-[calc(max(1rem,env(safe-area-inset-top))+5.25rem)] md:pt-10 pb-40 md:pb-16">

        {/* -- Greeting — Title1/Regular: SF Pro 28/34, +0.0136em, #0F172A -- */}
        <h1 className="font-sf t-title font-normal text-[#0F172A] dark:text-white mb-6">
          {greetingText}
        </h1>

        {/* -- Ask memory pill — pad 24/24/24/32, radius 999, Icon shadow -- */}
        {!askOpen && (
          <motion.div
            whileTap={{ scale: 0.985 }}
            role="button"
            tabIndex={0}
            onClick={() => setAskOpen(true)}
            onKeyDown={(e) => { if (e.key === 'Enter') setAskOpen(true) }}
            className="font-sf w-full md:max-w-2xl flex items-center gap-2 pl-8 pr-6 py-6 mb-6 md:mb-8 rounded-full bg-white dark:bg-[#111] shadow-[0_4px_16px_rgba(0,0,0,0.08)] dark:ring-white/5 text-left cursor-pointer"
          >
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="shrink-0 text-[#94A3B8] dark:text-slate-400">
              <path d="M12 5v14M5 12h14" />
            </svg>
            {/* Title3/Regular: SF Pro 20/25, -0.0225em, #64748B */}
            <span className="flex-1 t-ask text-[#64748B] dark:text-slate-400">Ask memory…</span>
            <button
              type="button"
              title="Speak your question"
              aria-label="Voice input"
              onClick={(e) => { e.stopPropagation(); setAutoMic(true); setAskOpen(true) }}
              className="shrink-0 text-[#94A3B8] dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4" />
              </svg>
            </button>
          </motion.div>
        )}

        {askOpen ? (
          <div className="h-[70vh] md:h-[75vh] rounded-3xl overflow-hidden bg-[#F1F5F9] dark:bg-[#111] shadow-[0_4px_16px_rgba(0,0,0,0.08)] dark:ring-white/5">
            <GlobalChatPanel
              autoStartMic={autoMic}
              prefill={prefill || undefined}
              onClose={() => { setAskOpen(false); setAutoMic(false); setPrefill('') }}
            />
          </div>
        ) : loading ? (
          <LoadingSkeleton />
        ) : (
          <div className="space-y-6">

            {/* -- Need your attention -- */}
            <section className="rounded-3xl bg-white dark:bg-[#111] shadow-[0_4px_16px_rgba(0,0,0,0.08)] dark:ring-white/5">
              {allSignals.length > 0 ? (
                <div className="py-6">
                  <p className="font-sf px-6 text-[15px] leading-[18px] font-semibold tracking-[-0.0153em] text-[#0F172A] dark:text-white mb-4">
                    Need your attention
                  </p>
                  <div className="px-6 space-y-4 md:grid md:grid-cols-2 md:gap-x-8 md:gap-y-4 md:space-y-0">
                    {visibleSignals.map((sig, i) => (
                      <motion.button
                        key={i}
                        whileTap={{ scale: 0.99 }}
                        onClick={() => router.push(`/spaces/${sig.spaceId}?name=${encodeURIComponent(sig.spaceName)}`)}
                        className="font-sf w-full flex items-start gap-2 text-left"
                      >
                        <span className="pt-0.5 shrink-0 text-emerald-500"><Sparkle className="w-3 h-3" /></span>
                        <span className="flex-1 min-w-0 text-[13px] leading-[18px] tracking-[-0.0062em] text-[#475569] dark:text-slate-300">
                          {sig.spaceName} - {sig.text}
                        </span>
                      </motion.button>
                    ))}
                  </div>
                  {hasMoreSignals && (
                    <button
                      onClick={() => setSheetOpen(true)}
                      className="font-sf mt-4 mx-6 inline-flex items-center gap-0.5 text-[13px] font-semibold text-[#475569] dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors"
                    >
                      Show all
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ) : (
                <div className="font-sf px-6 py-8 flex flex-col items-center text-center">
                  <span className="text-white mb-3"><Sparkle className="w-6 h-6" /></span>
                  <p className="text-[15px] leading-[18px] font-semibold text-[#0F172A] dark:text-white mb-1.5">You&rsquo;re all caught up</p>
                  <p className="text-[13px] tracking-[-0.0153em] leading-[18px] text-[#475569] dark:text-slate-400 max-w-[280px]">
                    No new updates since your last visit. We&rsquo;ll let you know when something changes
                  </p>
                </div>
              )}
            </section>

            {/* -- Your Spaces -- */}
            <section>
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-sf t-h2 font-normal text-[#0F172A] dark:text-white">Your Spaces</h2>
                {spaces.length > 0 && (
                  <button
                    onClick={() => router.push('/spaces')}
                    className="font-sf flex items-center gap-0.5 text-[13px] font-semibold text-[#475569] dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors"
                  >
                    Show all
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {spaces.length === 0 ? (
                <EmptyState onCreateClick={openCreateSpace} />
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
                  {previewSpaces.map((space, i) => (
                    <SpaceCard key={space.id} space={space} index={i} riskLevel={spaceRiskLevels.get(space.id)} onClick={() => router.push(`/spaces/${space.id}?name=${encodeURIComponent(space.name)}`)} />
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </div>

      {/* Draggable "Need your attention" sheet — Few → More → full scroll */}
      <AttentionSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        signals={allSignals}
        onNavigate={(id, name) => { setSheetOpen(false); router.push(`/spaces/${id}${name ? `?name=${encodeURIComponent(name)}` : ''}`) }}
      />
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="rounded-3xl h-44 shimmer shadow-[0_4px_16px_rgba(0,0,0,0.08)] ring-1 ring-black/[0.04]" />
      <div>
        <div className="h-7 w-40 rounded-lg shimmer mb-4" />
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-4 p-2 pr-4 rounded-3xl bg-[#F1F5F9]/70 dark:bg-[#111] shadow-[0_4px_16px_rgba(0,0,0,0.08)] ring-1 ring-black/[0.04] dark:ring-white/5">
              <div className="w-[72px] h-[72px] rounded-[18px] shimmer" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-2/5 rounded shimmer" />
                <div className="h-3 w-3/5 rounded shimmer" />
              </div>
              <div className="w-7 h-7 rounded-full shimmer" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function EmptyState({ onCreateClick }: { onCreateClick: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center justify-center py-14 text-center"
    >
      <div className="mb-4 text-slate-300 dark:text-gray-600">
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
      </div>
      <h2 className="font-sf text-base font-semibold text-[#0F172A] dark:text-white mb-2">Create your first space</h2>
      <p className="font-sf text-sm text-[#64748B] dark:text-gray-500 mb-6 max-w-xs leading-relaxed">
        A space holds all documents, decisions, and memory for one investment.
      </p>
      <motion.button
        whileTap={{ scale: 0.97 }}
        onClick={onCreateClick}
        className="px-5 py-2.5 text-sm font-medium bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-xl hover:bg-slate-700 dark:hover:bg-gray-100 transition-colors"
      >
        New space
      </motion.button>
    </motion.div>
  )
}
