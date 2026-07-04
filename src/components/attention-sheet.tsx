'use client'

import { useEffect, useState } from 'react'
import { motion, AnimatePresence, useMotionValue, animate, useDragControls, type PanInfo } from 'framer-motion'
import { Sparkle, ChevronRight } from '@/components/portfolio-ui'

export type Signal = { text: string; spaceName: string; spaceId: string }

// Visible fraction of the viewport at each snap — Figma: Few → More → Updates scroll
const SNAPS = [0.55, 0.75, 0.94]
const PANEL = 0.94
const SPRING = { type: 'spring' as const, stiffness: 420, damping: 40 }

function ItemList({ signals, onNavigate }: { signals: Signal[]; onNavigate: (id: string, name?: string) => void }) {
  return (
    <>
      {signals.map((sig, i) => (
        <div key={i}>
          <button
            onClick={() => onNavigate(sig.spaceId, sig.spaceName)}
            className="font-sf w-full flex items-start gap-2.5 py-4 text-left group"
          >
            <span className="pt-1 shrink-0 text-teal-400"><Sparkle className="w-3 h-3" /></span>
            <span className="flex-1 min-w-0">
              {/* Subheadline/Regular 15/20 — name #475569, desc #64748B */}
              <span className="block text-[15px] leading-[20px] tracking-[-0.0153em] text-[#475569] dark:text-slate-200">{sig.spaceName}</span>
              <span className="block text-[15px] leading-[20px] tracking-[-0.0153em] text-[#64748B] dark:text-slate-400 mt-0.5">{sig.text}</span>
            </span>
            <span className="shrink-0 mt-1 grid place-items-center w-7 h-7 rounded-full bg-[#F1F5F9] dark:bg-white/5 text-slate-700 dark:text-slate-400 group-hover:bg-slate-200 dark:group-hover:bg-white/10 transition-colors">
              <ChevronRight className="w-5 h-5" />
            </span>
          </button>
          {i < signals.length - 1 && <div className="h-px bg-[#F1F5F9] dark:bg-white/5 ml-5" />}
        </div>
      ))}
    </>
  )
}

export function AttentionSheet({
  open, onClose, signals, onNavigate,
}: {
  open: boolean
  onClose: () => void
  signals: Signal[]
  onNavigate: (spaceId: string, spaceName?: string) => void
}) {
  const [vh, setVh] = useState(800)
  const [desktop, setDesktop] = useState(false)
  const y = useMotionValue(0)
  const controls = useDragControls()

  useEffect(() => {
    const setSize = () => setVh(window.innerHeight)
    const mq = window.matchMedia('(min-width: 768px)')
    const setMq = () => setDesktop(mq.matches)
    setSize(); setMq()
    window.addEventListener('resize', setSize)
    mq.addEventListener('change', setMq)
    return () => { window.removeEventListener('resize', setSize); mq.removeEventListener('change', setMq) }
  }, [])

  const panelH = vh * PANEL
  const offsetFor = (i: number) => panelH - vh * SNAPS[i]

  // Mobile: open → animate up to the smallest (Few) snap
  useEffect(() => {
    if (open && !desktop) {
      y.set(panelH)
      animate(y, offsetFor(0), SPRING)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, vh, desktop])

  function onDragEnd(_e: unknown, info: PanInfo) {
    const current = y.get() + info.velocity.y * 0.1
    if (current > offsetFor(0) + vh * 0.12) {
      animate(y, panelH, SPRING).then(onClose)
      return
    }
    const offsets = SNAPS.map((_, i) => offsetFor(i))
    let nearest = 0, best = Infinity
    offsets.forEach((o, i) => { const d = Math.abs(o - current); if (d < best) { best = d; nearest = i } })
    animate(y, offsets[nearest], SPRING)
  }

  // -- Desktop: centered modal dialog --
  if (desktop) {
    return (
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-[rgba(26,26,26,0.36)] backdrop-blur-[2px]"
          >
            <motion.div
              initial={{ scale: 0.96, opacity: 0, y: 8 }} animate={{ scale: 1, opacity: 1, y: 0 }} exit={{ scale: 0.96, opacity: 0, y: 8 }}
              transition={SPRING}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-lg max-h-[80vh] flex flex-col bg-white dark:bg-[#111] rounded-3xl overflow-hidden shadow-[0_24px_60px_rgba(0,0,0,0.25)]"
            >
              <div className="shrink-0 flex items-center justify-between h-16 px-6 shadow-[0_1px_8px_rgba(0,0,0,0.06)]">
                <p className="font-sf text-[15px] font-semibold tracking-[-0.0153em] text-[#0F172A] dark:text-white">Need your attention</p>
                <button onClick={onClose} className="grid place-items-center w-8 h-8 rounded-full text-slate-400 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-1 pb-4">
                <ItemList signals={signals} onNavigate={onNavigate} />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    )
  }

  // -- Mobile: draggable bottom sheet (Few → More → full) --
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => animate(y, panelH, SPRING).then(onClose)}
            className="fixed inset-0 z-40 bg-[rgba(26,26,26,0.36)] backdrop-blur-[2px]"
          />
          <motion.div
            className="fixed inset-x-0 bottom-0 z-50 flex flex-col px-2"
            style={{ height: panelH, y }}
            drag="y" dragListener={false} dragControls={controls}
            dragConstraints={{ top: offsetFor(SNAPS.length - 1), bottom: panelH }}
            dragElastic={0.02} onDragEnd={onDragEnd}
          >
            <div onPointerDown={(e) => controls.start(e)} className="shrink-0 flex justify-center py-3 cursor-grab active:cursor-grabbing touch-none">
              <div className="w-12 h-[5px] rounded-full bg-white/80" />
            </div>
            <div className="flex-1 min-h-0 flex flex-col bg-white dark:bg-[#111] rounded-t-3xl overflow-hidden shadow-[0_-1px_24px_rgba(0,0,0,0.12)]">
              <div
                onPointerDown={(e) => controls.start(e)}
                className="shrink-0 flex items-center justify-center h-16 px-6 touch-none cursor-grab active:cursor-grabbing shadow-[0_1px_8px_rgba(0,0,0,0.06)] rounded-t-3xl bg-white dark:bg-[#111] z-10"
              >
                <p className="font-sf text-[15px] leading-[18px] font-semibold tracking-[-0.0153em] text-[#0F172A] dark:text-white">Need your attention</p>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-6 pt-2 pb-8">
                <ItemList signals={signals} onNavigate={onNavigate} />
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
