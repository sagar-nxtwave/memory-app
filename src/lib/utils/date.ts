/**
 * Neon returns timestamps without timezone info (TIMESTAMP WITHOUT TIME ZONE).
 * JavaScript Date parses such strings as local time, causing offsets for non-UTC users.
 * This helper forces UTC interpretation by appending 'Z' when no timezone is present.
 */
export function parseUtc(dateStr: string): Date {
  const s = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T')
  return new Date(s.endsWith('Z') || s.includes('+') ? s : s + 'Z')
}

export function formatDate(date: Date | string, opts?: { long?: boolean }): string {
  const d = typeof date === 'string' ? parseUtc(date) : date
  return d.toLocaleDateString('en-US', opts?.long
    ? { month: 'long', day: 'numeric', year: 'numeric' }
    : { month: 'short', day: 'numeric' }
  )
}

export function formatDateTime(date: Date | string, opts?: { long?: boolean }): string {
  const d = typeof date === 'string' ? parseUtc(date) : date
  return d.toLocaleString('en-US', opts?.long
    ? { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }
  )
}

/**
 * Format a timestamp as relative time in the user's local timezone.
 * - < 1 min: "just now"
 * - 1-59 min: "X mins ago"
 * - 1-23 hrs: "X hours ago"
 * - Yesterday: "yesterday 3:59 PM"
 * - Older: "Jan 1, 2025 3:59 PM"
 */
export function formatRelativeTime(date: Date | string): string {
  const d = typeof date === 'string' ? parseUtc(date) : date
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  const diffHrs = Math.floor(diffMs / 3600000)

  // Future timestamps — show as absolute
  if (diffMs < 0) {
    return formatChatTimestamp(d)
  }

  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin} min${diffMin === 1 ? '' : 's'} ago`
  if (diffHrs < 24) return `${diffHrs} hour${diffHrs === 1 ? '' : 's'} ago`

  // Check if it was yesterday (in user's local timezone)
  const dLocal = new Date(d)
  const nowLocal = new Date(now)
  const isYesterday = dLocal.getDate() === nowLocal.getDate() - 1 &&
    dLocal.getMonth() === nowLocal.getMonth() &&
    dLocal.getFullYear() === nowLocal.getFullYear()

  if (isYesterday) {
    return `yesterday ${dLocal.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
  }

  return formatChatTimestamp(d)
}

/**
 * Format a timestamp for chat display in user's local timezone.
 * Uses Intl.DateTimeFormat so it automatically respects the user's OS timezone.
 */
function formatChatTimestamp(date: Date): string {
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}
