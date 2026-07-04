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

export function timeAgo(dateStr: string | null): string {
  if (!dateStr) return ''
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

export function SpaceCard({ space, index = 0, onClick }: { space: SpaceSignal; index?: number; onClick: () => void }) {
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
      className="w-full flex items-center gap-4 p-2 pr-4 rounded-3xl bg-white dark:bg-[#111] shadow-[0_4px_16px_rgba(0,0,0,0.04)] ring-1 ring-black/[0.02] dark:ring-white/5 text-left group"
    >
      {/* Thumbnail 72×72 (fluid), radius 18 — real cover photo when set, else gradient monogram */}
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

      <div className="flex-1 min-w-0">
        {/* Label-1/SemiBold: Figtree 600 16/22, -0.0113em, #0F172A */}
        <p className="font-figtree text-[16px] leading-[22px] font-semibold tracking-[-0.011em] text-[#0F172A] dark:text-white truncate">{space.name}</p>
        {/* Caption1/Regular: SF Pro 12/16, #94A3B8 */}
        <p className="font-sf text-[12px] leading-[16px] text-[#94A3B8] dark:text-slate-500 truncate mt-0.5">{subtitle}</p>
      </div>

      {/* Chevron pill: bg #F1F5F9, radius 999, chevron 20 */}
      <span className="shrink-0 grid place-items-center w-7 h-7 rounded-full bg-[#F1F5F9] dark:bg-white/5 text-slate-700 dark:text-slate-400 transition-colors">
        <ChevronRight className="w-5 h-5" />
      </span>
    </motion.button>
  )
}
