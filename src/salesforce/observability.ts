// Structured logging for Salesforce pipeline observability.
// Tracks tool match accuracy, SOQL error rates, latency, and fallback usage.

export interface QueryMetric {
  timestamp: string
  question: string
  toolMatched: string | null
  confidence: 'high' | 'medium' | 'low'
  method: 'direct' | 'tool' | 'ad-hoc' | 'catch-all' | 'fallback'
  latencyMs: number
  soqlSuccess: boolean
  soqlError?: string
  guardrailBlocked: boolean
  instructorRetries: number
  resultCount: number
}

// In-memory metric store (replace with database in production)
const metrics: QueryMetric[] = []
const MAX_METRICS = 1000

export function recordMetric(metric: QueryMetric): void {
  metrics.push(metric)
  if (metrics.length > MAX_METRICS) {
    metrics.shift()
  }

  // Structured console log for log aggregation
  console.log(JSON.stringify({
    level: 'info',
    category: 'salesforce_pipeline',
    ...metric,
  }))
}

export function recordError(question: string, error: string, latencyMs: number): void {
  recordMetric({
    timestamp: new Date().toISOString(),
    question,
    toolMatched: null,
    confidence: 'low',
    method: 'fallback',
    latencyMs,
    soqlSuccess: false,
    soqlError: error,
    guardrailBlocked: false,
    instructorRetries: 0,
    resultCount: 0,
  })
}

export function recordGuardrailBlock(question: string, reason: string, latencyMs: number): void {
  recordMetric({
    timestamp: new Date().toISOString(),
    question,
    toolMatched: null,
    confidence: 'low',
    method: 'fallback',
    latencyMs,
    soqlSuccess: false,
    soqlError: `Guardrail: ${reason}`,
    guardrailBlocked: true,
    instructorRetries: 0,
    resultCount: 0,
  })
}

// Get summary statistics
export function getMetricsSummary(): {
  totalQueries: number
  toolMatchRate: number
  avgLatencyMs: number
  soqlErrorRate: number
  guardrailBlockRate: number
  topTools: { tool: string; count: number }[]
  methodBreakdown: { method: string; count: number }[]
} {
  const total = metrics.length
  if (total === 0) {
    return { totalQueries: 0, toolMatchRate: 0, avgLatencyMs: 0, soqlErrorRate: 0, guardrailBlockRate: 0, topTools: [], methodBreakdown: [] }
  }

  const toolMatched = metrics.filter(m => m.toolMatched !== null).length
  const avgLatency = metrics.reduce((sum, m) => sum + m.latencyMs, 0) / total
  const soqlErrors = metrics.filter(m => !m.soqlSuccess).length
  const guardrailBlocks = metrics.filter(m => m.guardrailBlocked).length

  // Top tools
  const toolCounts = new Map<string, number>()
  for (const m of metrics) {
    if (m.toolMatched) {
      toolCounts.set(m.toolMatched, (toolCounts.get(m.toolMatched) || 0) + 1)
    }
  }
  const topTools = Array.from(toolCounts.entries())
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  // Method breakdown
  const methodCounts = new Map<string, number>()
  for (const m of metrics) {
    methodCounts.set(m.method, (methodCounts.get(m.method) || 0) + 1)
  }
  const methodBreakdown = Array.from(methodCounts.entries())
    .map(([method, count]) => ({ method, count }))
    .sort((a, b) => b.count - a.count)

  return {
    totalQueries: total,
    toolMatchRate: toolMatched / total,
    avgLatencyMs: Math.round(avgLatency),
    soqlErrorRate: soqlErrors / total,
    guardrailBlockRate: guardrailBlocks / total,
    topTools,
    methodBreakdown,
  }
}

// Export metrics as JSON for external monitoring
export function exportMetrics(): QueryMetric[] {
  return [...metrics]
}
