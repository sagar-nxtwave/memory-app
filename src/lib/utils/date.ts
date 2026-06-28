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
