'use client'

import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChartBlock, type ChartSpec } from './charts/ChartBlock'

interface PinnedChart {
  id: string
  chart: ChartSpec
  pinnedAt: number
}

const STORAGE_KEY = 'pinned-charts'

function getPinned(): PinnedChart[] {
  if (typeof window === 'undefined') return []
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') }
  catch { return [] }
}

function removePin(id: string) {
  const pins = getPinned().filter((p) => p.id !== id)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(pins))
  window.dispatchEvent(new Event('pinned-charts-updated'))
}

const chartIcons: Record<string, string> = {
  line: '📈',
  bar: '📊',
  pie: '🍩',
  area: '📉',
  funnel: '🔽',
  stackedBar: '📊',
  scatter: '⚬',
  radial: '🔢',
}

export function PinnedCharts() {
  const [pins, setPins] = useState<PinnedChart[]>(() => getPinned())
  const [viewId, setViewId] = useState<string | null>(null)

  useEffect(() => {
    function onStorageUpdate() { setPins(getPinned()) }
    window.addEventListener('pinned-charts-updated', onStorageUpdate)
    return () => window.removeEventListener('pinned-charts-updated', onStorageUpdate)
  }, [])

  if (pins.length === 0) return null

  const viewing = pins.find((p) => p.id === viewId)

  return (
    <>
      <p className="font-sf text-[10px] font-semibold uppercase tracking-wider text-[#94A3B8] dark:text-gray-500 mb-1 mt-1 px-1">
        Pinned Charts
      </p>
      <div className="space-y-0.5 mb-2">
        {pins.map((pin) => (
          <div key={pin.id} className="group flex items-center gap-1">
            <button
              onClick={() => setViewId(pin.id)}
              className="flex-1 flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 rounded-xl transition-colors truncate"
            >
              <span className="text-xs shrink-0">{chartIcons[pin.chart.type] || '📊'}</span>
              <span className="truncate">{pin.chart.title}</span>
            </button>
            <button
              onClick={() => removePin(pin.id)}
              title="Unpin"
              className="p-1 rounded-lg text-gray-300 dark:text-gray-600 hover:text-red-500 dark:hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all shrink-0"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>
      <div className="h-px bg-gray-100 dark:bg-gray-800 mb-2" />

      {/* Fullscreen viewer */}
      <AnimatePresence>
        {viewing && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="chart-fullscreen"
            onClick={() => setViewId(null)}
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.92, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 400, damping: 35 }}
              onClick={(e) => e.stopPropagation()}
              className="w-[95vw] max-w-3xl max-h-[85vh] flex flex-col bg-white dark:bg-[#111] rounded-3xl overflow-hidden shadow-[0_24px_80px_rgba(0,0,0,0.4)]"
            >
              <div className="shrink-0 flex items-center justify-between h-14 px-6 border-b border-gray-100 dark:border-gray-800">
                <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">{viewing.chart.title}</p>
                <button
                  onClick={() => setViewId(null)}
                  className="p-2 rounded-xl text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-6">
                <ChartBlock spec={viewing.chart} />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
