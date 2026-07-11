import { NextResponse } from 'next/server'
import { getMetricsSummary, exportMetrics } from '@/salesforce/observability'

export const dynamic = 'force-dynamic'

export async function GET() {
  const summary = getMetricsSummary()
  return NextResponse.json(summary)
}

export async function POST() {
  const metrics = exportMetrics()
  return NextResponse.json({ metrics, count: metrics.length })
}
