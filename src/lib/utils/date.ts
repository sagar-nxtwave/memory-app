/**
 * Neon returns timestamps without timezone info (TIMESTAMP WITHOUT TIME ZONE).
 * JavaScript Date parses such strings as local time, causing offsets for non-UTC users.
 * This helper forces UTC interpretation by appending 'Z' when no timezone is present.
 */
export function parseUtc(dateStr: string): Date {
  const s = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T')
  return new Date(s.endsWith('Z') || s.includes('+') ? s : s + 'Z')
}
