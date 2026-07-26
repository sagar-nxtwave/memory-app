'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { parseUtc } from '@/lib/utils/date'

export type SpaceStatus = 'new' | 'on_track' | 'at_risk' | 'on_hold' | 'completed'

export interface SpaceSignal {
  id: string
  name: string
  description: string | null
  status: SpaceStatus
  documentCount: number
  lastActivityAt: string | null
  latestDocumentName: string | null
  newDocsSinceVisit: number
  lastVisitAt: string | null
  hasImage?: boolean
}

export interface RecentDoc {
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

export interface Digest {
  stats: { totalSpaces: number; totalDocuments: number; spacesWithNewActivity: number; newDocumentsTotal: number }
  spaces: SpaceSignal[]
  recentDocuments: RecentDoc[]
}

// -- Portfolio risk heat-map ---------------------------------------------------
// Derived client-side from existing status + extracted-risk counts — no new
// backend fields needed. Gives an at-a-glance "what needs attention" signal.

export type RiskLevel = 'critical' | 'watch' | 'healthy' | 'new'

export function computeRiskLevel(space: SpaceSignal, riskCount: number): RiskLevel {
  if (space.documentCount === 0) return 'new'
  if (space.status === 'at_risk' || riskCount >= 3) return 'critical'
  if (space.status === 'on_hold' || riskCount >= 1) return 'watch'
  return 'healthy'
}

export function riskCountsBySpace(recentDocuments: RecentDoc[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const doc of recentDocuments) {
    const c = (doc.risks ?? []).length
    map.set(doc.spaceId, (map.get(doc.spaceId) ?? 0) + c)
  }
  return map
}

const RISK_DOT: Record<RiskLevel, string> = {
  critical: 'bg-red-500',
  watch: 'bg-amber-400',
  healthy: 'bg-emerald-400',
  new: 'bg-slate-300 dark:bg-slate-600',
}

const RISK_LABEL: Record<RiskLevel, string> = {
  critical: 'Needs attention',
  watch: 'Watching',
  healthy: 'On track',
  new: 'New',
}

export function PortfolioHealthBar({
  counts, active, onFilter,
}: {
  counts: Record<RiskLevel, number>
  active?: RiskLevel | null
  onFilter?: (level: RiskLevel | null) => void
}) {
  const levels: RiskLevel[] = ['critical', 'watch', 'healthy']
  const total = levels.reduce((sum, l) => sum + counts[l], 0)
  if (total === 0) return null

  return (
    <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide mb-6 -mx-0.5 px-0.5">
      {levels.map((level) => {
        if (counts[level] === 0) return null
        const isActive = active === level
        const clickable = !!onFilter
        return (
          <button
            key={level}
            type="button"
            onClick={clickable ? () => onFilter(isActive ? null : level) : undefined}
            className={`font-sf shrink-0 flex items-center gap-2 pl-3 pr-3.5 py-2 rounded-full text-[13px] font-medium whitespace-nowrap transition-all ${
              isActive
                ? 'bg-[#0F172A] dark:bg-white text-white dark:text-[#0F172A] shadow-[0_4px_16px_rgba(0,0,0,0.16)]'
                : 'bg-white dark:bg-[#111] text-[#475569] dark:text-slate-300 shadow-[0_4px_16px_rgba(0,0,0,0.08)] hover:shadow-[0_6px_20px_rgba(0,0,0,0.12)]'
            } ${clickable ? 'cursor-pointer' : 'cursor-default'}`}
          >
            <span className={`w-2 h-2 rounded-full shrink-0 ${RISK_DOT[level]}`} />
            <span className="font-semibold">{counts[level]}</span>
            <span className={isActive ? 'text-white/80 dark:text-[#0F172A]/70' : 'text-[#94A3B8] dark:text-slate-500'}>{RISK_LABEL[level]}</span>
          </button>
        )
      })}
    </div>
  )
}

export function timeAgo(dateStr: string | null): string {  if (!dateStr) return ''
  const diff = Date.now() - parseUtc(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return mins <= 1 ? 'just now' : `${mins} minutes ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} hour${hrs !== 1 ? 's' : ''} ago`
  const d = Math.floor(hrs / 24)
  if (d === 1) return 'yesterday'
  if (d < 7) return `${d} days ago`
  if (d < 30) return `${Math.floor(d / 7)} week${Math.floor(d / 7) !== 1 ? 's' : ''} ago`
  return `${Math.floor(d / 30)} month${Math.floor(d / 30) !== 1 ? 's' : ''} ago`
}

export function greeting(name?: string | null): string {
  const h = new Date().getHours()
  const base = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
  return name ? `${base}, ${name.split(' ')[0]}!` : `${base}!`
}

// Fire from anywhere to open the shared "new space" sheet in <AppChrome/>
export function openCreateSpace() {
  window.dispatchEvent(new CustomEvent('memory:new-space'))
}

// -- Icons (from Figma component set) -----------------------------------------

export function Sparkle({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 0c.45 6.3 5.4 11.25 11.7 11.7C17.4 12.15 12.45 17.1 12 23.4 11.55 17.1 6.6 12.15.3 11.7 6.6 11.25 11.55 6.3 12 0z" />
    </svg>
  )
}

export function ChevronRight({ className }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

// -- Space card (Figma: pad 8/16/8/8, gap 16, radius 24, Icon shadow) ---------

const THUMB_GRADIENTS = [
  'from-sky-400 to-indigo-500',
  'from-emerald-400 to-teal-500',
  'from-amber-400 to-orange-500',
  'from-rose-400 to-pink-500',
  'from-violet-400 to-purple-500',
  'from-cyan-400 to-blue-500',
]

export function SpaceCard({ space, index = 0, riskLevel, onClick }: { space: SpaceSignal; index?: number; riskLevel?: RiskLevel; onClick: () => void }) {
  const isEmpty = space.documentCount === 0
  const [imgFailed, setImgFailed] = useState(false)
  const gradient = THUMB_GRADIENTS[
    Math.abs([...space.name].reduce((a, c) => a + c.charCodeAt(0), 0)) % THUMB_GRADIENTS.length
  ]
  const subtitle = isEmpty
    ? 'No documents yet'
    : space.lastActivityAt
      ? `Updated ${timeAgo(space.lastActivityAt)}`
      : `${space.documentCount} document${space.documentCount !== 1 ? 's' : ''}`

  return (
    <motion.button
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.03 }}
      whileTap={{ scale: 0.99 }}
      onClick={onClick}
      className="w-full flex items-center gap-4 p-2 pr-4 rounded-3xl bg-white dark:bg-[#111] shadow-[0_4px_16px_rgba(0,0,0,0.08)] ring-1 ring-[#F1F5F9] dark:ring-white/5 text-left group"
    >
      {/* Thumbnail 72×72 (fluid), radius 18 — real cover photo when set, else gradient monogram */}
      <div className="relative shrink-0">
        {space.hasImage && !imgFailed ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed-URL redirect, not a static asset Next can optimize
          <img
            src={`/api/spaces/${space.id}/image`}
            alt=""
            onError={() => setImgFailed(true)}
            className="thumb shrink-0 rounded-[18px] object-cover"
          />
        ) : (
          <div className={`thumb shrink-0 grid place-items-center rounded-[18px] bg-gradient-to-br ${gradient}`}>
            <span className="font-figtree text-[clamp(1.25rem,6vw,1.5rem)] font-semibold text-white/95">{space.name.charAt(0).toUpperCase()}</span>
          </div>
        )}
        {/* Risk heat-map dot — omitted for healthy/new spaces to avoid visual noise */}
        {riskLevel && (riskLevel === 'critical' || riskLevel === 'watch') && (
          <span
            className={`absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full border-2 border-white dark:border-[#111] ${RISK_DOT[riskLevel]}`}
            title={RISK_LABEL[riskLevel]}
          />
        )}
      </div>

      <div className="flex-1 min-w-0">
        {/* Label-1/SemiBold: Figtree 600 16/22, -0.0113em, #0F172A */}
        <p className="font-figtree text-[16px] leading-[22px] font-semibold tracking-[-0.011em] text-[#0F172A] dark:text-white truncate">{space.name}</p>
        {/* Caption1/Regular: SF Pro 12/16, #94A3B8 */}
        <p className="font-sf text-[12px] leading-[16px] text-[#94A3B8] dark:text-slate-500 truncate mt-0.5">{subtitle}</p>
      </div>

      {/* Chevron pill: bg #F1F5F9, radius 999, chevron 20 */}
      <span className="shrink-0 grid place-items-center w-7 h-7 rounded-full bg-[#F1F5F9] dark:bg-white/5 text-[#0E0E0E] dark:text-slate-400 transition-colors">
        <ChevronRight className="w-5 h-5" />
      </span>
    </motion.button>
  )
}
