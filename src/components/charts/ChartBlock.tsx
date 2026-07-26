'use client'

import { useState, useCallback, useEffect, memo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  LineTrend, BarComp, PieDonut, AreaTrend,
  FunnelChart, StackedBarComp, ScatterPlot, RadialKPI,
  type ChartDataPoint, type LineConfig,
} from './charts'
import { SPRING_MEDIUM } from '@/lib/animations'

export interface ChartSpec {
  type: 'line' | 'bar' | 'pie' | 'area' | 'funnel' | 'stackedBar' | 'scatter' | 'radial'
  title: string
  subtitle?: string
  data: ChartDataPoint[]
  lines?: LineConfig[]
}

interface PinnedChart {
  id: string
  chart: ChartSpec
  pinnedAt: number
}

const STORAGE_KEY = 'pinned-charts'
const MAX_PINS = 10

function getPinnedCharts(): PinnedChart[] {
  if (typeof window === 'undefined') return []
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
  } catch { return [] }
}

function savePinnedCharts(charts: PinnedChart[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(charts))
  window.dispatchEvent(new Event('pinned-charts-updated'))
}

function ChartRenderer({ spec, height }: { spec: ChartSpec; height: number }) {
  switch (spec.type) {
    case 'line':
      return <LineTrend data={spec.data} lines={spec.lines} height={height} />
    case 'bar':
      return <BarComp data={spec.data} lines={spec.lines} height={height} />
    case 'pie':
      return <PieDonut data={spec.data} height={height} />
    case 'area':
      return <AreaTrend data={spec.data} lines={spec.lines} height={height} />
    case 'funnel':
      return <FunnelChart data={spec.data} height={height} />
    case 'stackedBar':
      return <StackedBarComp data={spec.data} lines={spec.lines} height={height} />
    case 'scatter':
      return <ScatterPlot data={spec.data} lines={spec.lines} height={height} />
    case 'radial':
      return <RadialKPI data={spec.data} height={height} />
    default:
      return <LineTrend data={spec.data} lines={spec.lines} height={height} />
  }
}

export const ChartBlock = memo(function ChartBlock({ spec }: { spec: ChartSpec }) {
  const [expanded, setExpanded] = useState(false)
  const [pinned, setPinned] = useState(() => {
    const pins = getPinnedCharts()
    return pins.some((p) => p.chart.title === spec.title)
  })

  const togglePin = useCallback(() => {
    const pins = getPinnedCharts()
    const existing = pins.findIndex((p) => p.chart.title === spec.title)
    if (existing >= 0) {
      pins.splice(existing, 1)
      setPinned(false)
    } else {
      if (pins.length >= MAX_PINS) pins.shift()
      pins.push({ id: `pin-${Date.now()}`, chart: spec, pinnedAt: Date.now() })
      setPinned(true)
    }
    savePinnedCharts(pins)
  }, [spec])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && expanded) setExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  return (
    <>
      {/* Inline chart — hidden when fullscreen is open */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className={`my-3 chart-card-glow ${expanded ? 'invisible h-0 overflow-hidden my-0' : ''}`}
      >
        <div className="bg-white dark:bg-[#111] rounded-3xl overflow-hidden">
          <div className="flex items-center justify-between px-4 pt-3 pb-1">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-gray-900 dark:text-white truncate">{spec.title}</p>
              {spec.subtitle && (
                <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">{spec.subtitle}</p>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0 ml-2">
              <button
                onClick={togglePin}
                title={pinned ? 'Unpin chart' : 'Pin to sidebar'}
                className={`p-1.5 rounded-lg transition-colors ${pinned ? 'text-teal-500 dark:text-teal-400' : 'text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400'}`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 17v5M9 2h6l-1 7h4l-7 8V12H5l4-10z" />
                </svg>
              </button>
              <button
                onClick={() => setExpanded(true)}
                title="Expand chart"
                className="p-1.5 rounded-lg text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400 transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                </svg>
              </button>
            </div>
          </div>
          <div className="px-2 pb-2">
            <ChartRenderer spec={spec} height={220} />
          </div>
        </div>
      </motion.div>

      {/* Fullscreen overlay */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="chart-fullscreen"
            onClick={() => setExpanded(false)}
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.92, opacity: 0 }}
              transition={{ type: 'spring', ...SPRING_MEDIUM }}
              onClick={(e) => e.stopPropagation()}
              className="w-[95vw] max-w-3xl max-h-[85vh] flex flex-col bg-white dark:bg-[#111] rounded-3xl overflow-hidden shadow-[0_24px_80px_rgba(0,0,0,0.4)]"
            >
              <div className="shrink-0 flex items-center justify-between h-14 px-6 border-b border-gray-100 dark:border-gray-800">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">{spec.title}</p>
                  {spec.subtitle && (
                    <p className="text-[11px] text-gray-400 dark:text-gray-500">{spec.subtitle}</p>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0 ml-3">
                  <button
                    onClick={togglePin}
                    title={pinned ? 'Unpin chart' : 'Pin to sidebar'}
                    className={`p-2 rounded-xl transition-colors ${pinned ? 'text-teal-500 dark:text-teal-400 bg-teal-50 dark:bg-teal-900/20' : 'text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5'}`}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 17v5M9 2h6l-1 7h4l-7 8V12H5l4-10z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => setExpanded(false)}
                    title="Close"
                    className="p-2 rounded-xl text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-6">
                <ChartRenderer spec={spec} height={420} />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
})

export function parseChartJson(raw: string): ChartSpec | null {
  try {
    const cleaned = raw.replace(/^```chart\s*/i, '').replace(/```\s*$/, '').trim()
    const parsed = JSON.parse(cleaned)
    if (parsed.type && Array.isArray(parsed.data)) {
      return {
        type: parsed.type,
        title: parsed.title || 'Chart',
        subtitle: parsed.subtitle,
        data: parsed.data,
        lines: parsed.lines,
      }
    }
    return null
  } catch {
    return null
  }
}
