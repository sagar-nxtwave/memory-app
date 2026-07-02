/**
 * Parses natural language query hints for metadata filtering at retrieval time.
 * Returns SQL-injectable filter values — caller adds them as WHERE clauses.
 */

export interface QueryFilters {
  fileTypes: string[]          // e.g. ['pdf', 'xlsx']
  afterDate: Date | null       // documents uploaded/dated after this
  beforeDate: Date | null      // documents uploaded/dated before this
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
}

export function parseQueryFilters(query: string, now: Date = new Date()): QueryFilters {
  const q = query.toLowerCase()
  const year = now.getFullYear()

  // ── File type hints ───────────────────────────────────────────────────────
  const fileTypes: string[] = []
  if (/\b(excel|spreadsheet|xlsx|xls)\b/.test(q)) fileTypes.push('xlsx')
  if (/\b(csv)\b/.test(q)) fileTypes.push('csv')
  if (/\b(pdf)\b/.test(q)) fileTypes.push('pdf')
  if (/\b(word|docx|doc|document)\b/.test(q)) fileTypes.push('docx')

  // ── Date hints ────────────────────────────────────────────────────────────
  let afterDate: Date | null = null
  let beforeDate: Date | null = null

  // "last 7 days", "last week", "last month", "last year"
  const lastN = q.match(/last\s+(\d+)\s+(day|week|month|year)s?/)
  if (lastN) {
    const n = parseInt(lastN[1])
    const unit = lastN[2]
    const d = new Date(now)
    if (unit === 'day') d.setDate(d.getDate() - n)
    else if (unit === 'week') d.setDate(d.getDate() - n * 7)
    else if (unit === 'month') d.setMonth(d.getMonth() - n)
    else if (unit === 'year') d.setFullYear(d.getFullYear() - n)
    afterDate = d
  } else if (/\b(today|this week|this month)\b/.test(q)) {
    const d = new Date(now)
    if (/today/.test(q)) d.setDate(d.getDate() - 1)
    else if (/this week/.test(q)) d.setDate(d.getDate() - 7)
    else if (/this month/.test(q)) d.setMonth(d.getMonth() - 1)
    afterDate = d
  } else if (/\byesterday\b/.test(q)) {
    const d = new Date(now)
    d.setDate(d.getDate() - 2)
    afterDate = d
    beforeDate = new Date(now)
    beforeDate.setDate(beforeDate.getDate() - 1)
  }

  // "Q1 2024", "Q3", "Q2 2023"
  const quarterMatch = q.match(/q([1-4])\s*(\d{4})?/)
  if (quarterMatch) {
    const q = parseInt(quarterMatch[1]) - 1  // 0-indexed quarter
    const y = quarterMatch[2] ? parseInt(quarterMatch[2]) : year
    afterDate = new Date(y, q * 3, 1)
    beforeDate = new Date(y, q * 3 + 3, 0)
  }

  // "January 2024", "March 2023"
  for (const [monthName, monthIdx] of Object.entries(MONTHS)) {
    const re = new RegExp(`\\b${monthName}\\s*(\\d{4})?\\b`)
    const m = q.match(re)
    if (m) {
      const y = m[1] ? parseInt(m[1]) : year
      afterDate = new Date(y, monthIdx, 1)
      beforeDate = new Date(y, monthIdx + 1, 0)
      break
    }
  }

  // "in 2024", "2023 documents"
  const yearOnly = q.match(/\bin\s+(\d{4})\b|\b(\d{4})\s+(documents?|reports?|files?|data)\b/)
  if (yearOnly && !afterDate) {
    const y = parseInt(yearOnly[1] ?? yearOnly[2])
    afterDate = new Date(y, 0, 1)
    beforeDate = new Date(y, 11, 31)
  }

  return { fileTypes, afterDate, beforeDate }
}
