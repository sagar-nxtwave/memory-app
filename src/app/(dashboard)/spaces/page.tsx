'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'

interface SpaceSignal {
  id: string
  name: string
  description: string | null
  documentCount: number
  lastActivityAt: string | null
  newDocsSinceVisit: number
  lastVisitAt: string | null
}

interface RecentDoc {
  id: string
  name: string
  fileType: string
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
  if (!dateStr) return 'No activity'
  const diff = Date.now() - new Date(dateStr).getTime()
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

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

export default function PortfolioDashboard() {
  const router = useRouter()
  const [digest, setDigest] = useState<Digest | null>(null)
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [creating, setCreating] = useState(false)
  const [activeFilter, setActiveFilter] = useState<'all' | 'updated' | 'risks' | 'documents'>('all')

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
  const spaces = digest?.spaces ?? []
  const recentDocs = digest?.recentDocuments ?? []

  // Build per-space signal map from recent docs
  const spaceSignalMap = new Map<string, { hasRisk: boolean; hasDecision: boolean }>()
  for (const doc of recentDocs) {
    const existing = spaceSignalMap.get(doc.spaceId) ?? { hasRisk: false, hasDecision: false }
    spaceSignalMap.set(doc.spaceId, {
      hasRisk: existing.hasRisk || (doc.risks?.length ?? 0) > 0,
      hasDecision: existing.hasDecision || (doc.decisions?.length ?? 0) > 0,
    })
  }

  // Only flag attention if new docs contain risks OR decisions — not just any upload
  const attentionSpaces = spaces.filter((s) => {
    if (s.newDocsSinceVisit === 0) return false
    const sig = spaceSignalMap.get(s.id)
    return sig?.hasRisk || sig?.hasDecision
  })
  const risksTotal = spaces.filter((s) => spaceSignalMap.get(s.id)?.hasRisk).length

  // Filtered + sorted list based on active pulse card
  const filteredSpaces = (() => {
    if (activeFilter === 'updated') return spaces.filter((s) => s.newDocsSinceVisit > 0)
    if (activeFilter === 'risks') return spaces.filter((s) => spaceSignalMap.get(s.id)?.hasRisk)
    return spaces
  })()

  const filterLabel: Record<typeof activeFilter, string> = {
    all: 'All projects',
    documents: 'All documents',
    updated: 'Updated projects',
    risks: 'Projects with risks',
  }

  return (
    <div className="min-h-full bg-white dark:bg-[#0f0f0f] overflow-y-auto">
      <div className="max-w-2xl mx-auto px-4 pb-20 pt-5 pl-16 md:pl-4">

        {/* ── Header ── */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Portfolio</h1>
            <p className="text-sm text-gray-400 dark:text-gray-500 mt-0.5">{greeting()}</p>
          </div>
          <div className="flex items-center gap-2">
            {spaces.length > 0 && (
              <motion.button
                whileTap={{ scale: 0.96 }}
                onClick={() => router.push('/spaces/global')}
                className="px-3.5 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-xl transition-colors"
              >
                Ask all
              </motion.button>
            )}
            <motion.button
              whileTap={{ scale: 0.96 }}
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-xl hover:bg-gray-700 dark:hover:bg-gray-100 transition-colors"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
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
            {/* ── Portfolio pulse — 4 tappable filter cards ── */}
            {stats && (
              <div className="grid grid-cols-4 gap-2 mb-7">
                <PulseStat label="Projects" value={stats.totalSpaces} active={activeFilter === 'all'} onClick={() => setActiveFilter('all')} />
                <PulseStat label="Documents" value={stats.totalDocuments} active={activeFilter === 'documents'} onClick={() => setActiveFilter('documents')} />
                <PulseStat label="Updated" value={stats.spacesWithNewActivity} highlight={stats.spacesWithNewActivity > 0} active={activeFilter === 'updated'} onClick={() => setActiveFilter('updated')} />
                <PulseStat label="Risks" value={risksTotal} danger={risksTotal > 0} active={activeFilter === 'risks'} onClick={() => setActiveFilter('risks')} />
              </div>
            )}

            {/* ── Needs attention ── */}
            <AnimatePresence>
              {attentionSpaces.length > 0 && (
                <motion.section
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mb-7"
                >
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-600 mb-2">
                    Needs attention
                  </p>
                  <div className="rounded-2xl border border-gray-100 dark:border-gray-800 overflow-hidden divide-y divide-gray-100 dark:divide-gray-800">
                    {attentionSpaces.map((space, i) => {
                      const sig = spaceSignalMap.get(space.id)
                      // Most recent new doc for this space — tells investor WHY it needs attention
                      const latestDoc = recentDocs.find((d) => d.spaceId === space.id)
                      return (
                        <AttentionRow
                          key={space.id}
                          space={space}
                          hasRisk={sig?.hasRisk ?? false}
                          hasDecision={sig?.hasDecision ?? false}
                          latestDocName={latestDoc?.name ?? null}
                          index={i}
                          onClick={() => router.push(`/spaces/${space.id}`)}
                        />
                      )
                    })}
                  </div>
                </motion.section>
              )}
            </AnimatePresence>

            {/* ── Filtered list ── */}
            <section>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-600">
                  {filterLabel[activeFilter]}
                </p>
                {activeFilter !== 'all' && (
                  <button
                    onClick={() => setActiveFilter('all')}
                    className="text-[11px] text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
                  >
                    Clear
                  </button>
                )}
              </div>

              {activeFilter === 'documents' ? (
                recentDocs.length === 0 ? (
                  <p className="text-sm text-gray-400 dark:text-gray-500 py-6 text-center">No documents yet.</p>
                ) : (
                  <DocsGrouped docs={recentDocs} onSpaceClick={(spaceId) => router.push(`/spaces/${spaceId}`)} />
                )
              ) : filteredSpaces.length === 0 ? (
                <p className="text-sm text-gray-400 dark:text-gray-500 py-6 text-center">No projects match this filter.</p>
              ) : (
                <div className="rounded-2xl border border-gray-100 dark:border-gray-800 overflow-hidden divide-y divide-gray-100 dark:divide-gray-800">
                  {filteredSpaces.map((space, i) => (
                    <ProjectRow
                      key={space.id}
                      space={space}
                      index={i}
                      hasNew={space.newDocsSinceVisit > 0}
                      onClick={() => router.push(`/spaces/${space.id}`)}
                    />
                  ))}
                </div>
              )}
            </section>
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
                <p className="text-base font-semibold text-gray-900 dark:text-white mb-4">New project space</p>
                <div className="space-y-3 mb-5">
                  <input
                    autoFocus
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Project name — e.g. Sea Gardens"
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
                    className="flex-1 py-3 text-sm font-medium bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-xl disabled:opacity-40 hover:bg-gray-700 dark:hover:bg-gray-100 transition-colors"
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

// ── Portfolio pulse stat ─────────────────────────────────────────────────────

function PulseStat({ label, value, highlight, danger, active, onClick }: {
  label: string
  value: number
  highlight?: boolean
  danger?: boolean
  active?: boolean
  onClick?: () => void
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.96 }}
      onClick={onClick}
      className={`flex flex-col items-center justify-center py-3 px-2 rounded-2xl transition-all ${
        active
          ? danger
            ? 'bg-red-100 dark:bg-red-900/25 ring-1 ring-red-300 dark:ring-red-700'
            : highlight
            ? 'bg-emerald-100 dark:bg-emerald-900/25 ring-1 ring-emerald-300 dark:ring-emerald-700'
            : 'bg-gray-200 dark:bg-gray-700 ring-1 ring-gray-300 dark:ring-gray-600'
          : danger
          ? 'bg-red-50 dark:bg-red-900/10 hover:bg-red-100 dark:hover:bg-red-900/20'
          : highlight
          ? 'bg-emerald-50 dark:bg-emerald-900/10 hover:bg-emerald-100 dark:hover:bg-emerald-900/20'
          : 'bg-gray-50 dark:bg-gray-900/60 hover:bg-gray-100 dark:hover:bg-gray-800'
      }`}
    >
      <span className={`text-xl font-bold tabular-nums ${
        danger ? 'text-red-500 dark:text-red-400'
        : highlight ? 'text-emerald-600 dark:text-emerald-400'
        : 'text-gray-900 dark:text-white'
      }`}>
        {value}
      </span>
      <span className="text-[10px] text-gray-400 dark:text-gray-500 mt-0.5 font-medium">{label}</span>
    </motion.button>
  )
}

// ── Attention row ────────────────────────────────────────────────────────────

function AttentionRow({ space, hasRisk, hasDecision, latestDocName, index, onClick }: {
  space: SpaceSignal
  hasRisk: boolean
  hasDecision: boolean
  latestDocName: string | null
  index: number
  onClick: () => void
}) {
  return (
    <motion.button
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.04 }}
      whileTap={{ scale: 0.995 }}
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3.5 bg-white dark:bg-[#111] hover:bg-gray-50 dark:hover:bg-gray-900/60 transition-colors text-left"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0 mt-0.5" />

      {/* Name + what changed */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{space.name}</p>
        {latestDocName && (
          <p className="text-[11px] text-gray-400 dark:text-gray-500 truncate mt-0.5">{latestDocName}</p>
        )}
      </div>

      {/* Tags + time */}
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
          {space.newDocsSinceVisit} new
        </span>
        {hasRisk && (
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-red-50 dark:bg-red-900/20 text-red-500 dark:text-red-400">
            risk
          </span>
        )}
        {hasDecision && (
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-blue-50 dark:bg-blue-900/20 text-blue-500 dark:text-blue-400">
            decision
          </span>
        )}
        <span className="text-[11px] text-gray-400 dark:text-gray-500 ml-1">
          {timeAgo(space.lastActivityAt)}
        </span>
      </div>

      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-300 dark:text-gray-600 shrink-0">
        <path d="M5 12h14M12 5l7 7-7 7" />
      </svg>
    </motion.button>
  )
}

// ── Project row (compact list) ───────────────────────────────────────────────

function ProjectRow({ space, index, hasNew, onClick }: {
  space: SpaceSignal
  index: number
  hasNew: boolean
  onClick: () => void
}) {
  return (
    <motion.button
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: index * 0.02 }}
      whileTap={{ scale: 0.995 }}
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3 bg-white dark:bg-[#111] hover:bg-gray-50 dark:hover:bg-gray-900/60 transition-colors text-left group"
    >
      <p className="flex-1 min-w-0 text-sm text-gray-700 dark:text-gray-300 truncate group-hover:text-gray-900 dark:group-hover:text-white transition-colors">
        {space.name}
      </p>

      <div className="flex items-center gap-2 shrink-0">
        {hasNew && (
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
        )}
        <span className="text-[11px] text-gray-400 dark:text-gray-500">
          {space.lastActivityAt ? timeAgo(space.lastActivityAt) : 'No docs'}
        </span>
      </div>

      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-300 dark:text-gray-700 shrink-0">
        <path d="M5 12h14M12 5l7 7-7 7" />
      </svg>
    </motion.button>
  )
}

// ── Documents grouped by project ────────────────────────────────────────────

function DocsGrouped({ docs, onSpaceClick }: { docs: RecentDoc[]; onSpaceClick: (spaceId: string) => void }) {
  // Group docs by spaceId, preserving order of first appearance
  const groups: { spaceId: string; spaceName: string; docs: RecentDoc[] }[] = []
  const seen = new Map<string, number>()
  for (const doc of docs) {
    if (seen.has(doc.spaceId)) {
      groups[seen.get(doc.spaceId)!].docs.push(doc)
    } else {
      seen.set(doc.spaceId, groups.length)
      groups.push({ spaceId: doc.spaceId, spaceName: doc.spaceName, docs: [doc] })
    }
  }

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div key={group.spaceId} className="rounded-2xl border border-gray-100 dark:border-gray-800 overflow-hidden">
          {/* Project header */}
          <button
            onClick={() => onSpaceClick(group.spaceId)}
            className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 dark:bg-gray-900/60 hover:bg-gray-100 dark:hover:bg-gray-800/60 transition-colors text-left"
          >
            <p className="text-xs font-semibold text-gray-600 dark:text-gray-400">{group.spaceName}</p>
            <span className="text-[11px] text-gray-400 dark:text-gray-500">{group.docs.length} doc{group.docs.length !== 1 ? 's' : ''}</span>
          </button>

          {/* Doc rows */}
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {group.docs.map((doc) => (
              <button
                key={doc.id}
                onClick={() => onSpaceClick(doc.spaceId)}
                className="w-full flex items-center gap-3 px-4 py-2.5 bg-white dark:bg-[#111] hover:bg-gray-50 dark:hover:bg-gray-900/50 transition-colors text-left group"
              >
                <p className="flex-1 min-w-0 text-sm text-gray-700 dark:text-gray-300 truncate group-hover:text-gray-900 dark:group-hover:text-white transition-colors">
                  {doc.name}
                </p>
                <span className="text-[11px] text-gray-400 dark:text-gray-500 shrink-0">{timeAgo(doc.createdAt)}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Loading skeleton ─────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="space-y-7 animate-pulse">
      <div className="grid grid-cols-4 gap-2">
        {[1, 2, 3, 4].map((i) => <div key={i} className="h-16 rounded-2xl bg-gray-100 dark:bg-gray-800" />)}
      </div>
      <div>
        <div className="h-3 w-28 bg-gray-100 dark:bg-gray-800 rounded mb-3" />
        <div className="rounded-2xl border border-gray-100 dark:border-gray-800 overflow-hidden divide-y divide-gray-100 dark:divide-gray-800">
          {[1, 2, 3].map((i) => <div key={i} className="h-12 bg-white dark:bg-[#111]" />)}
        </div>
      </div>
      <div>
        <div className="h-3 w-20 bg-gray-100 dark:bg-gray-800 rounded mb-3" />
        <div className="rounded-2xl border border-gray-100 dark:border-gray-800 overflow-hidden divide-y divide-gray-100 dark:divide-gray-800">
          {[1, 2, 3, 4, 5].map((i) => <div key={i} className="h-11 bg-white dark:bg-[#111]" />)}
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
        A space holds all documents, decisions, and memory for one project.
      </p>
      <motion.button
        whileTap={{ scale: 0.97 }}
        onClick={onCreateClick}
        className="px-5 py-2.5 text-sm font-medium bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-2xl hover:bg-gray-700 dark:hover:bg-gray-100 transition-colors"
      >
        + Create a space
      </motion.button>
    </motion.div>
  )
}
