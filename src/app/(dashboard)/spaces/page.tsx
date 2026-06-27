'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { motion, AnimatePresence } from 'framer-motion'
import { parseUtc } from '@/lib/utils/date'

type SpaceStatus = 'on_track' | 'at_risk' | 'on_hold' | 'completed'

interface SpaceSignal {
  id: string
  name: string
  description: string | null
  status: SpaceStatus
  documentCount: number
  lastActivityAt: string | null
  latestDocumentName: string | null
  newDocsSinceVisit: number
  lastVisitAt: string | null
}

interface RecentDoc {
  id: string
  name: string
  fileType: string
  summary: string | null
  risks: string[] | null
  decisions: string[] | null
  createdAt: string
  spaceId: string
  spaceName: string
}

interface DigestStats {
  totalSpaces: number
  totalDocuments: number
  spacesWithNewActivity: number
  newDocumentsTotal: number
}

interface Digest {
  stats: DigestStats
  spaces: SpaceSignal[]
  recentDocuments: RecentDoc[]
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return ''
  const diff = Date.now() - parseUtc(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return mins <= 1 ? 'Just now' : `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const d = Math.floor(hrs / 24)
  if (d === 1) return 'Yesterday'
  if (d < 7) return `${d}d ago`
  if (d < 30) return `${Math.floor(d / 7)}w ago`
  return `${Math.floor(d / 30)}mo ago`
}

function greeting(name?: string | null): string {
  const h = new Date().getHours()
  const base = h < 12 ? 'Good Morning' : h < 17 ? 'Good Afternoon' : 'Good Evening'
  return name ? `${base}, ${name.split(' ')[0]}` : base
}

type SignalItem = { type: 'risk' | 'decision'; text: string; spaceName: string; spaceId: string; docCreatedAt: string }

export default function PortfolioDashboard() {
  const router = useRouter()
  const { data: session } = useSession()
  const [digest, setDigest] = useState<Digest | null>(null)
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [creating, setCreating] = useState(false)
  const [showAllSignals, setShowAllSignals] = useState(false)
  const [activeFilter, setActiveFilter] = useState<'all' | 'risks' | 'decisions' | 'newdocs'>('all')

  const loadDigest = useCallback(async () => {
    const res = await fetch('/api/portfolio/digest')
    if (res.ok) setDigest(await res.json())
    setLoading(false)
  }, [])

  useEffect(() => { loadDigest() }, [loadDigest])

  async function createSpace(e: React.FormEvent) {
    e.preventDefault()
    if (!newName.trim()) return
    setCreating(true)
    const res = await fetch('/api/spaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim(), description: newDesc.trim() || null }),
    })
    if (res.ok) {
      const space = await res.json()
      setShowCreate(false); setNewName(''); setNewDesc('')
      router.push(`/spaces/${space.id}`)
    }
    setCreating(false)
  }

  const stats = digest?.stats
  const allSpaces = digest?.spaces ?? []
  const allDocsRaw = digest?.recentDocuments ?? []

  // Filter out test spaces from portfolio view
  const spaces = allSpaces.filter((s) => !s.name.toLowerCase().startsWith('test'))
  const spaceIds = new Set(spaces.map((s) => s.id))
  const allDocs = allDocsRaw.filter((d) => spaceIds.has(d.spaceId))

  // Build lastVisit map and new-doc set
  const lastVisitMap = new Map(spaces.map((s) => [s.id, s.lastVisitAt]))
  const newDocs = allDocs.filter((doc) => {
    const lastVisit = lastVisitMap.get(doc.spaceId)
    if (!lastVisit) return true
    return parseUtc(doc.createdAt).getTime() > parseUtc(lastVisit).getTime()
  })

  // Flatten all risk and decision signals from ALL docs, preserving source metadata
  const allSignals: SignalItem[] = []
  for (const doc of allDocs) {
    for (const r of doc.risks ?? []) {
      allSignals.push({ type: 'risk', text: r, spaceName: doc.spaceName, spaceId: doc.spaceId, docCreatedAt: doc.createdAt })
    }
    for (const d of doc.decisions ?? []) {
      allSignals.push({ type: 'decision', text: d, spaceName: doc.spaceName, spaceId: doc.spaceId, docCreatedAt: doc.createdAt })
    }
  }
  const riskSignals = allSignals.filter((s) => s.type === 'risk')
  const decisionSignals = allSignals.filter((s) => s.type === 'decision')

  // Per-space signal map (used for stat counts + space row badges)
  const spaceSignalMap = new Map<string, { hasRisk: boolean; hasDecision: boolean }>()
  for (const doc of allDocs) {
    const existing = spaceSignalMap.get(doc.spaceId) ?? { hasRisk: false, hasDecision: false }
    spaceSignalMap.set(doc.spaceId, {
      hasRisk: existing.hasRisk || (doc.risks?.length ?? 0) > 0,
      hasDecision: existing.hasDecision || (doc.decisions?.length ?? 0) > 0,
    })
  }
  // Count spaces (not individual strings) — "4 spaces have risks" is what an investor acts on
  const spacesWithRisks = spaces.filter((s) => spaceSignalMap.get(s.id)?.hasRisk).length
  const spacesWithDecisions = spaces.filter((s) => spaceSignalMap.get(s.id)?.hasDecision).length

  // Filtered signals for active filter
  const filteredSignals = activeFilter === 'risks' ? riskSignals
    : activeFilter === 'decisions' ? decisionSignals
    : allSignals
  const filteredSpaces = activeFilter === 'risks' ? spaces.filter((s) => spaceSignalMap.get(s.id)?.hasRisk)
    : activeFilter === 'decisions' ? spaces.filter((s) => spaceSignalMap.get(s.id)?.hasDecision)
    : activeFilter === 'newdocs' ? spaces.filter((s) => newDocs.some((d) => d.spaceId === s.id))
    : spaces
  const visibleSignals = showAllSignals ? filteredSignals : filteredSignals.slice(0, 5)
  const hasMoreSignals = filteredSignals.length > 5

  return (
    <div className="min-h-full bg-gray-50 dark:bg-[#0a0a0a] overflow-y-auto">
      <div className="max-w-2xl mx-auto px-4 pb-24 pt-5 pl-16 md:pl-4">

        {/* ── Header ── */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-lg font-semibold text-gray-900 dark:text-white tracking-tight">Portfolio</h1>
            <p className="text-xs text-gray-400 dark:text-gray-600 mt-0.5">{greeting(session?.user?.name)}</p>
          </div>
          <div className="flex items-center gap-2">
            {spaces.length > 0 && (
              <motion.button
                whileTap={{ scale: 0.96 }}
                onClick={() => router.push('/spaces/global')}
                className="h-8 px-3 text-xs font-medium text-gray-500 dark:text-gray-400 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
              >
                Ask all
              </motion.button>
            )}
            <motion.button
              whileTap={{ scale: 0.96 }}
              onClick={() => setShowCreate(true)}
              className="h-8 flex items-center gap-1.5 px-3 text-xs font-medium bg-gray-900 dark:bg-gray-700 text-white rounded-lg hover:bg-gray-700 dark:hover:bg-gray-600 transition-colors"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              New
            </motion.button>
          </div>
        </div>

        {loading ? (
          <LoadingSkeleton />
        ) : spaces.length === 0 ? (
          <EmptyState onCreateClick={() => setShowCreate(true)} />
        ) : (
          <>
            {/* ── Stat strip — clickable filters ── */}
            <div className="grid grid-cols-4 gap-2 mb-5">
              <StatCard value={spaces.length} label="Spaces" active={activeFilter === 'all'} onClick={() => setActiveFilter('all')} />
              <StatCard value={newDocs.length} label="New Docs" accent={newDocs.length > 0 ? 'emerald' : undefined} active={activeFilter === 'newdocs'} onClick={() => setActiveFilter(activeFilter === 'newdocs' ? 'all' : 'newdocs')} />
              <StatCard value={spacesWithDecisions} label="Decisions" accent={spacesWithDecisions > 0 ? 'blue' : undefined} active={activeFilter === 'decisions'} onClick={() => setActiveFilter(activeFilter === 'decisions' ? 'all' : 'decisions')} />
              <StatCard value={spacesWithRisks} label="Risks" accent={spacesWithRisks > 0 ? 'red' : undefined} active={activeFilter === 'risks'} onClick={() => setActiveFilter(activeFilter === 'risks' ? 'all' : 'risks')} />
            </div>

            {/* ── Content ── */}
            <div className="space-y-5">
              {/* Intelligence feed */}
              {filteredSignals.length > 0 && activeFilter !== 'newdocs' && (
                <section>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-600">Intelligence</p>
                    <p className="text-[10px] text-gray-400 dark:text-gray-600">
                      {activeFilter === 'all'
                        ? `${riskSignals.length} risk${riskSignals.length !== 1 ? 's' : ''} · ${decisionSignals.length} decision${decisionSignals.length !== 1 ? 's' : ''}`
                        : `${filteredSignals.length} ${activeFilter}`}
                    </p>
                  </div>
                  <div className="rounded-2xl bg-white dark:bg-[#111] border border-gray-200/60 dark:border-gray-800 overflow-hidden divide-y divide-gray-100 dark:divide-gray-800/80 shadow-sm">
                    {visibleSignals.map((sig, i) => (
                      <motion.button
                        key={`${sig.type}-${i}`}
                        whileTap={{ scale: 0.995 }}
                        onClick={() => router.push(`/spaces/${sig.spaceId}`)}
                        className="w-full flex items-start gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-900/60 transition-colors text-left group"
                      >
                        <span className={`mt-0.5 shrink-0 inline-flex items-center justify-center w-[62px] text-[9px] font-bold py-0.5 rounded uppercase tracking-wide ${
                          sig.type === 'risk'
                            ? 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400'
                            : 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                        }`}>
                          {sig.type === 'risk' ? 'Risk' : 'Decision'}
                        </span>
                        <span className="flex-1 min-w-0 text-sm text-gray-700 dark:text-gray-300 group-hover:text-gray-900 dark:group-hover:text-white transition-colors leading-snug line-clamp-2">
                          {sig.text}
                        </span>
                        <span className="shrink-0 text-[11px] text-gray-400 dark:text-gray-600 pt-0.5">{sig.spaceName}</span>
                      </motion.button>
                    ))}
                    {hasMoreSignals && (
                      <button
                        onClick={() => setShowAllSignals((v) => !v)}
                        className="w-full py-2.5 text-xs text-gray-400 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-400 transition-colors"
                      >
                        {showAllSignals ? 'Show less' : `Show ${filteredSignals.length - 5} more`}
                      </button>
                    )}
                  </div>
                </section>
              )}

              {/* New docs */}
              {newDocs.length > 0 && (activeFilter === 'all' || activeFilter === 'newdocs') && (
                <section>
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-600 mb-2">New since last visit</p>
                  <div className="rounded-2xl bg-white dark:bg-[#111] border border-gray-200/60 dark:border-gray-800 overflow-hidden divide-y divide-gray-100 dark:divide-gray-800/80 shadow-sm">
                    {newDocs.slice(0, 5).map((doc) => (
                      <motion.button
                        key={doc.id}
                        whileTap={{ scale: 0.995 }}
                        onClick={() => router.push(`/spaces/${doc.spaceId}`)}
                        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-900/60 transition-colors text-left group"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-gray-800 dark:text-gray-200 truncate group-hover:text-gray-900 dark:group-hover:text-white">{doc.name}</p>
                          <p className="text-[11px] text-gray-400 dark:text-gray-600 truncate mt-0.5">{doc.spaceName}</p>
                        </div>
                        <span className="shrink-0 text-[11px] text-gray-400 dark:text-gray-600">{timeAgo(doc.createdAt)}</span>
                      </motion.button>
                    ))}
                  </div>
                </section>
              )}

              {/* Spaces list */}
              <section>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 dark:text-gray-600 mb-2">
                  {activeFilter === 'all' ? 'All spaces' : activeFilter === 'newdocs' ? 'Spaces with new documents' : activeFilter === 'risks' ? 'Spaces with risks' : 'Spaces with decisions'}
                </p>
                {filteredSpaces.length === 0
                  ? <p className="text-sm text-gray-400 dark:text-gray-600 py-8 text-center">No spaces match this filter.</p>
                  : <SpaceList spaces={filteredSpaces} spaceSignalMap={spaceSignalMap} newDocs={newDocs} onNavigate={(id) => router.push(`/spaces/${id}`)} />
                }
              </section>
            </div>

          </>
        )}
      </div>

      {/* ── New space sheet ── */}
      <AnimatePresence>
        {showCreate && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
            onClick={() => { setShowCreate(false); setNewName(''); setNewDesc('') }}
          >
            <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', stiffness: 420, damping: 36 }}
              onClick={(e) => e.stopPropagation()}
              className="relative w-full max-w-md bg-white dark:bg-[#1c1c1e] rounded-t-3xl sm:rounded-3xl shadow-2xl"
              style={{ paddingBottom: 'env(safe-area-inset-bottom, 20px)' }}
            >
              <div className="flex justify-center pt-3 pb-1">
                <div className="w-9 h-1 bg-gray-200 dark:bg-gray-700 rounded-full" />
              </div>
              <form onSubmit={createSpace} className="px-5 pt-3 pb-5">
                <p className="text-base font-semibold text-gray-900 dark:text-white mb-4">New space</p>
                <div className="space-y-3 mb-5">
                  <input
                    autoFocus
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Space name — e.g. Sea Gardens"
                    className="w-full px-4 py-3 text-base text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors placeholder:text-gray-400 dark:placeholder:text-gray-600"
                  />
                  <input
                    type="text"
                    value={newDesc}
                    onChange={(e) => setNewDesc(e.target.value)}
                    placeholder="Short description (optional)"
                    className="w-full px-4 py-3 text-base text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors placeholder:text-gray-400 dark:placeholder:text-gray-600"
                  />
                </div>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => { setShowCreate(false); setNewName(''); setNewDesc('') }}
                    className="flex-1 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-xl hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={creating || !newName.trim()}
                    className="flex-1 py-3 text-sm font-medium bg-gray-900 dark:bg-gray-700 text-white rounded-xl disabled:opacity-40 hover:bg-gray-700 dark:hover:bg-gray-600 transition-colors"
                  >
                    {creating ? 'Creating…' : 'Create space'}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Stat card ────────────────────────────────────────────────────────────────

function StatCard({ value, label, accent, active, onClick }: {
  value: number
  label: string
  accent?: 'red' | 'blue' | 'emerald'
  active?: boolean
  onClick?: () => void
}) {
  const numCls = accent === 'red' ? 'text-red-500 dark:text-red-400'
    : accent === 'blue' ? 'text-blue-500 dark:text-blue-400'
    : accent === 'emerald' ? 'text-emerald-600 dark:text-emerald-400'
    : 'text-gray-900 dark:text-white'

  return (
    <motion.button
      whileTap={{ scale: 0.95 }}
      onClick={onClick}
      className={`flex flex-col items-center justify-center py-3.5 px-2 rounded-2xl border shadow-sm transition-colors w-full ${
        active
          ? 'bg-gray-900 dark:bg-gray-800 border-transparent dark:border-gray-600'
          : 'bg-white dark:bg-[#111] border-gray-200/60 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-900/60'
      }`}
    >
      <span className={`text-2xl font-bold tabular-nums leading-none ${active ? 'text-white' : numCls}`}>{value}</span>
      <span className={`text-[10px] mt-1 font-medium ${active ? 'text-gray-300 dark:text-gray-400' : 'text-gray-400 dark:text-gray-600'}`}>{label}</span>
    </motion.button>
  )
}

// ── Space row ────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<SpaceStatus, { label: string; dot: string; badge: string }> = {
  on_track:  { label: 'On Track',  dot: 'bg-emerald-400',             badge: 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400' },
  at_risk:   { label: 'At Risk',   dot: 'bg-red-400',                 badge: 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400' },
  on_hold:   { label: 'On Hold',   dot: 'bg-amber-400',               badge: 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400' },
  completed: { label: 'Completed', dot: 'bg-gray-400 dark:bg-gray-500', badge: 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400' },
}

function SpaceRow({ space, hasRisk, hasDecision, hasNew, index, onClick }: {
  space: SpaceSignal
  hasRisk: boolean
  hasDecision: boolean
  hasNew: boolean
  index: number
  onClick: () => void
}) {
  const status = STATUS_CONFIG[space.status ?? 'on_track']
  const isEmpty = space.documentCount === 0

  return (
    <motion.button
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: index * 0.02 }}
      whileTap={{ scale: 0.995 }}
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-gray-50 dark:hover:bg-gray-900/60 transition-colors text-left group"
    >
      {/* New-doc indicator dot */}
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${hasNew ? 'bg-emerald-400' : 'bg-transparent'}`} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate group-hover:text-gray-900 dark:group-hover:text-white transition-colors">
            {space.name}
          </p>
          {/* Status badge */}
          <span className={`shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide ${status.badge}`}>
            {status.label}
          </span>
        </div>
        {/* Latest doc name or empty state */}
        {isEmpty ? (
          <p className="text-[11px] text-gray-400 dark:text-gray-600 mt-0.5">No documents yet</p>
        ) : space.latestDocumentName ? (
          <p className="text-[11px] text-gray-400 dark:text-gray-600 truncate mt-0.5">
            {space.latestDocumentName}
            {space.lastActivityAt && <span className="text-gray-300 dark:text-gray-700"> · {timeAgo(space.lastActivityAt)}</span>}
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        {hasRisk && (
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide bg-red-100 dark:bg-red-900/30 text-red-500 dark:text-red-400">
            Risk
          </span>
        )}
        {hasDecision && (
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide bg-blue-100 dark:bg-blue-900/30 text-blue-500 dark:text-blue-400">
            Decision
          </span>
        )}
      </div>

      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-300 dark:text-gray-700 shrink-0">
        <path d="M5 12h14M12 5l7 7-7 7" />
      </svg>
    </motion.button>
  )
}

// ── Space list (shared across tabs) ─────────────────────────────────────────

function SpaceList({ spaces, spaceSignalMap, newDocs, onNavigate }: {
  spaces: SpaceSignal[]
  spaceSignalMap: Map<string, { hasRisk: boolean; hasDecision: boolean }>
  newDocs: RecentDoc[]
  onNavigate: (id: string) => void
}) {
  return (
    <div className="rounded-2xl bg-white dark:bg-[#111] border border-gray-200/60 dark:border-gray-800 overflow-hidden divide-y divide-gray-100 dark:divide-gray-800/80 shadow-sm">
      {spaces.map((space, i) => {
        const sig = spaceSignalMap.get(space.id)
        return (
          <SpaceRow
            key={space.id}
            space={space}
            hasRisk={sig?.hasRisk ?? false}
            hasDecision={sig?.hasDecision ?? false}
            hasNew={newDocs.some((d) => d.spaceId === space.id)}
            index={i}
            onClick={() => onNavigate(space.id)}
          />
        )
      })}
    </div>
  )
}

// ── Loading skeleton ─────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="space-y-5 animate-pulse">
      <div className="grid grid-cols-4 gap-2">
        {[1, 2, 3, 4].map((i) => <div key={i} className="h-16 rounded-2xl bg-gray-100 dark:bg-gray-900" />)}
      </div>
      <div>
        <div className="h-2.5 w-20 bg-gray-100 dark:bg-gray-900 rounded mb-2" />
        <div className="rounded-2xl border border-gray-200/60 dark:border-gray-800 overflow-hidden divide-y divide-gray-100 dark:divide-gray-800">
          {[1, 2, 3, 4].map((i) => <div key={i} className="h-12 bg-white dark:bg-[#111]" />)}
        </div>
      </div>
      <div>
        <div className="h-2.5 w-16 bg-gray-100 dark:bg-gray-900 rounded mb-2" />
        <div className="rounded-2xl border border-gray-200/60 dark:border-gray-800 overflow-hidden divide-y divide-gray-100 dark:divide-gray-800">
          {[1, 2, 3, 4, 5].map((i) => <div key={i} className="h-12 bg-white dark:bg-[#111]" />)}
        </div>
      </div>
    </div>
  )
}

// ── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ onCreateClick }: { onCreateClick: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center justify-center py-24 text-center"
    >
      <div className="text-4xl mb-4 select-none">💭</div>
      <h2 className="text-base font-semibold text-gray-900 dark:text-white mb-2">Create your first space</h2>
      <p className="text-sm text-gray-400 dark:text-gray-500 mb-6 max-w-xs leading-relaxed">
        A space holds all documents, decisions, and memory for one investment.
      </p>
      <motion.button
        whileTap={{ scale: 0.97 }}
        onClick={onCreateClick}
        className="px-5 py-2.5 text-sm font-medium bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-xl hover:bg-gray-700 dark:hover:bg-gray-100 transition-colors"
      >
        New space
      </motion.button>
    </motion.div>
  )
}
