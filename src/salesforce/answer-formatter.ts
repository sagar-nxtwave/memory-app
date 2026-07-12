// Answer formatting — clean up raw CRM data into natural language.

/**
 * Format a number as AED currency.
 */
export function formatAED(amount: number): string {
  if (amount >= 1_000_000_000) return `AED ${(amount / 1_000_000_000).toFixed(1)}B`
  if (amount >= 1_000_000) return `AED ${(amount / 1_000_000).toFixed(1)}M`
  if (amount >= 1_000) return `AED ${(amount / 1_000).toFixed(1)}K`
  return `AED ${amount.toLocaleString()}`
}

/**
 * Format a number with commas.
 */
export function formatNumber(num: number): string {
  return num.toLocaleString()
}

/**
 * Format a percentage.
 */
export function formatPercent(value: number, decimals: number = 1): string {
  return `${value.toFixed(decimals)}%`
}

/**
 * Format a date string to a readable format.
 */
export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return 'N/A'
  try {
    const d = new Date(dateStr)
    if (isNaN(d.getTime())) return dateStr
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return dateStr
  }
}

/**
 * Format a ratio (e.g., 5/10 → "5 out of 10 (50%)").
 */
export function formatRatio(part: number, total: number): string {
  if (total === 0) return '0 out of 0 (0%)'
  const pct = ((part / total) * 100).toFixed(1)
  return `${part.toLocaleString()} out of ${total.toLocaleString()} (${pct}%)`
}

/**
 * Format days into human-readable duration.
 */
export function formatDuration(days: number): string {
  if (days < 1) return '< 1 day'
  if (days === 1) return '1 day'
  if (days < 30) return `${Math.round(days)} days`
  if (days < 365) return `${(days / 30).toFixed(1)} months`
  return `${(days / 365).toFixed(1)} years`
}

/**
 * Clean up raw field names to human-readable labels.
 */
export function cleanFieldName(field: string): string {
  return field
    .replace(/__c$/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}

/**
 * Format a list of items with counts into a readable summary.
 */
export function formatCountList(items: { name: string; count: number }[]): string {
  const total = items.reduce((sum, item) => sum + item.count, 0)
  return items
    .map(item => {
      const pct = total > 0 ? ((item.count / total) * 100).toFixed(1) : '0'
      return `${item.name}: ${item.count.toLocaleString()} (${pct}%)`
    })
    .join('\n')
}
