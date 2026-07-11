import { format, startOfMonth, endOfMonth, startOfQuarter, endOfQuarter, startOfYear, endOfYear, subDays, subMonths, subYears, isAfter, isBefore, parseISO } from 'date-fns'

// Real-time date utilities — never use hardcoded dates.
// All date operations go through this module so the system always knows "today".

export function today(): Date {
  return new Date()
}

export function todayStr(): string {
  return format(today(), 'yyyy-MM-dd')
}

export function currentYear(): number {
  return today().getFullYear()
}

export function currentMonth(): number {
  return today().getMonth() + 1
}

export function currentQuarter(): number {
  return Math.ceil((today().getMonth() + 1) / 3)
}

export function currentMonthName(): string {
  return format(today(), 'MMMM')
}

// Get the date range for a relative period like "this month", "last quarter", etc.
export function getPeriodRange(period: string): { start: Date; end: Date } | null {
  const p = period.toLowerCase().trim()
  const now = today()

  if (p === 'today') {
    return { start: startOfMonth(now), end: endOfMonth(now) }
  }
  if (p === 'yesterday') {
    const yesterday = subDays(now, 1)
    return { start: yesterday, end: yesterday }
  }
  if (p === 'this week') {
    return { start: subDays(now, now.getDay()), end: now }
  }
  if (p === 'last week') {
    return { start: subDays(now, now.getDay() + 7), end: subDays(now, now.getDay() + 1) }
  }
  if (p === 'this month') {
    return { start: startOfMonth(now), end: endOfMonth(now) }
  }
  if (p === 'last month') {
    const lastMonth = subMonths(now, 1)
    return { start: startOfMonth(lastMonth), end: endOfMonth(lastMonth) }
  }
  if (p === 'this quarter') {
    return { start: startOfQuarter(now), end: endOfQuarter(now) }
  }
  if (p === 'last quarter') {
    const lastQ = subMonths(now, 3)
    return { start: startOfQuarter(lastQ), end: endOfQuarter(lastQ) }
  }
  if (p === 'this year') {
    return { start: startOfYear(now), end: endOfYear(now) }
  }
  if (p === 'last year') {
    const lastY = subYears(now, 1)
    return { start: startOfYear(lastY), end: endOfYear(lastY) }
  }
  if (p === 'last 7 days') {
    return { start: subDays(now, 7), end: now }
  }
  if (p === 'last 30 days') {
    return { start: subDays(now, 30), end: now }
  }
  if (p === 'last 90 days') {
    return { start: subDays(now, 90), end: now }
  }

  // Absolute year: "2025", "2024"
  const yearMatch = p.match(/^(\d{4})$/)
  if (yearMatch) {
    const year = parseInt(yearMatch[1], 10)
    if (year >= 2000 && year <= 2100) {
      return { start: new Date(year, 0, 1), end: new Date(year, 11, 31) }
    }
  }

  // Absolute month+year: "jan 2025", "january 2024"
  const monthYearMatch = p.match(/^(\w+)\s*[-–]?\s*(\d{4})$/)
  if (monthYearMatch) {
    const MONTH_MAP: Record<string, number> = {
      january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2,
      april: 3, apr: 3, may: 4, june: 5, jun: 5,
      july: 6, jul: 6, august: 7, aug: 7, september: 8, sep: 8,
      october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
    }
    const monthIdx = MONTH_MAP[monthYearMatch[1].toLowerCase()]
    const year = parseInt(monthYearMatch[2], 10)
    if (monthIdx !== undefined && year) {
      const d = new Date(year, monthIdx, 1)
      return { start: startOfMonth(d), end: endOfMonth(d) }
    }
  }

  return null
}

// Get a human-readable description of the current date context
export function dateContext(): string {
  const now = today()
  return `Today is ${format(now, 'EEEE, MMMM d, yyyy')} (UTC+4). Current quarter: Q${currentQuarter()} ${currentYear()}.`
}
