// Server-side formatting of raw SOQL observation data.
// Parses JSON from MCP tool results and renders as markdown table (for numeric/comparison data)
// or clean formatted text (for ownership/text-based data). No LLM involved — deterministic.
import type { SalesforceResult } from './query'

/**
 * Try to parse raw JSON observations from MCP SOQL tool results.
 * Handles: JSON arrays, JSON objects wrapped in text, error strings.
 * Returns parsed rows or null if unparseable.
 */
export function tryParseJson(raw?: string): Record<string, unknown>[] | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed as Record<string, unknown>[]
    if (typeof parsed === 'object' && parsed !== null) return [parsed]
    return null
  } catch {
    return null
  }
}

/**
 * Detect if any column in the rows contains numeric values ( Amount, COUNT, SUM).
 * Used to decide between table rendering (numbers) vs text rendering (ownership).
 */
export function hasNumericColumns(rows: Record<string, unknown>[]): boolean {
  if (rows.length === 0) return false
  const sample = rows[0]
  for (const key of Object.keys(sample)) {
    const val = sample[key]
    if (typeof val === 'number') return true
    if (typeof val === 'string' && /^[\d,]+(\.\d+)?$/.test(val.replace(/AED\s*/i, ''))) return true
    // Check nested objects for numeric values (e.g. aggregate results)
    if (typeof val === 'object' && val !== null) {
      for (const nested of Object.values(val as Record<string, unknown>)) {
        if (typeof nested === 'number') return true
      }
    }
  }
  return false
}

// ── Aggregate result detection & pre-computed totals ──────────────────────
// GROUP BY queries return multiple rows with count/sum columns. LLMs are unreliable
// at summing these, so we compute totals server-side and inject them into the
// observation before the LLM ever sees the data.

/**
 * Detect if rows are from a GROUP BY aggregate query — multiple rows with numeric
 * count/sum columns (e.g. cnt, total, Amount, SUM). Returns true when there are
 * 2+ rows AND at least one numeric column that looks like an aggregation.
 */
export function isAggregateResult(rows: Record<string, unknown>[]): boolean {
  if (rows.length < 2) return false
  const sample = rows[0]
  for (const key of Object.keys(sample)) {
    const val = sample[key]
    if (typeof val !== 'number') continue
    const k = key.toLowerCase()
    if (k === 'cnt' || k.includes('cnt') || k.includes('count') || k === 'total' || k.includes('sum') || k.includes('amount') || k.includes('revenue')) {
      return true
    }
  }
  return false
}

/**
 * Compute grand totals for all numeric columns in aggregate rows.
 * Returns a string like "Grand Total: 1,790 units | AED 2,063,921,520"
 * that can be appended to the observation.
 */
export function computeAggregateTotals(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return ''

  const flat = rows.map(r => flattenRow(r))
  const columns = Object.keys(flat[0]).filter(c => c !== 'Id' && c !== 'id')

  const totals: string[] = []
  for (const col of columns) {
    const allNumbers = flat.every(r => typeof r[col] === 'number')
    if (!allNumbers) continue
    const sum = flat.reduce((acc, r) => acc + ((r[col] as number) || 0), 0)
    const formatted = formatValue(sum, col)
    totals.push(`${displayName(col)}: ${formatted}`)
  }

  return totals.length > 0 ? `[PRE-COMPUTED TOTALS]\nGrand Total: ${totals.join(' | ')}` : ''
}

/**
 * Compute subtotals grouped by a key column (e.g. "year" for year-wise breakdowns).
 * Returns lines like "2023 Total: 1,790 units | AED 2,063,921,520"
 * and a grand total line.
 */
export function computeGroupedTotals(rows: Record<string, unknown>[], groupByKey: string): string {
  if (rows.length === 0) return ''

  const flat = rows.map(r => flattenRow(r))
  if (!flat[0][groupByKey]) return computeAggregateTotals(rows)

  // Group rows by the key
  const groups = new Map<string, Record<string, unknown>[]>()
  for (const row of flat) {
    const key = String(row[groupByKey])
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(row)
  }

  const lines: string[] = []
  const numericCols = Object.keys(flat[0]).filter(c =>
    c !== 'Id' && c !== 'id' && c !== groupByKey &&
    flat.every(r => typeof r[c] === 'number')
  )

  // Per-group subtotals
  for (const [groupKey, groupRows] of groups) {
    const parts = numericCols.map(col => {
      const sum = groupRows.reduce((acc, r) => acc + ((r[col] as number) || 0), 0)
      return `${displayName(col)}: ${formatValue(sum, col)}`
    })
    lines.push(`${groupKey}: ${parts.join(' | ')}`)
  }

  // Grand total
  const grandParts = numericCols.map(col => {
    const sum = flat.reduce((acc, r) => acc + ((r[col] as number) || 0), 0)
    return `${displayName(col)}: ${formatValue(sum, col)}`
  })
  lines.push(`Grand Total: ${grandParts.join(' | ')}`)

  return `[PRE-COMPUTED TOTALS]\n${lines.join('\n')}`
}

/**
 * Flatten a row for display — extract values from nested objects.
 * e.g. { Account: { Name: "Sagar" }, Name: "OPP-001" } → { "Account.Name": "Sagar", "Name": "OPP-001" }
 */
function flattenRow(row: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(row)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      Object.assign(result, flattenRow(val as Record<string, unknown>, fullKey))
    } else {
      result[fullKey] = val
    }
  }
  return result
}

/**
 * Get display-friendly column name from SOQL field name.
 * e.g. "Account.Name" → "Owner", "cm_Sales_Person__r.Name" → "Salesperson"
 */
function displayName(col: string): string {
  const map: Record<string, string> = {
    'Name': 'Name',
    'Account.Name': 'Owner',
    'Account.Phone': 'Phone',
    'Account.Email__c': 'Email',
    'Amount': 'Amount',
    'CloseDate': 'Close Date',
    'Milestone_Current_Status__c': 'Status',
    'StageName': 'Stage',
    'cm_Sales_Person__r.Name': 'Salesperson',
    'cm_Agency_Name__r.Name': 'Agency',
    'cm_Agent_Name__r.Name': 'Agent',
    'Building_Name__c': 'Project',
    'Building_Community__c': 'Community',
    'Sales_Room__c': 'Bedrooms',
    'Unit_Details__c': 'Unit Type',
    'RecordType.Name': 'Record Type',
    'Contact.Name': 'Contact',
    'Opportunity_Name__r.Name': 'Linked Deal',
    'Id': 'ID',
  }
  return map[col] || col.replace(/[._]/g, ' ').replace(/__r |__c /g, ' ').trim()
}

/**
 * Format a value for display — AED currency, dates, etc.
 */
function formatValue(val: unknown, colKey: string): string {
  if (val === null || val === undefined) return '—'
  if (typeof val === 'number') {
    if (/amount|revenue|total|sum/i.test(colKey)) {
      return `AED ${val.toLocaleString('en-US')}`
    }
    return val.toLocaleString('en-US')
  }
  if (typeof val === 'string') {
    // Date-like strings
    if (/^\d{4}-\d{2}-\d{2}/.test(val)) {
      try {
        return new Date(val).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      } catch { return val }
    }
    return val
  }
  return String(val)
}

/**
 * Build a markdown table from SOQL result rows.
 * Used for numeric/comparison data (revenue breakdowns, deal counts, etc.).
 */
export function buildMarkdownTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return ''

  // Flatten nested objects and pick display columns
  const flat = rows.map(r => flattenRow(r))
  // Exclude 'Id' column — not useful for display
  const columns = Object.keys(flat[0]).filter(c => c !== 'Id' && c !== 'id')
  if (columns.length === 0) return ''

  // Limit to 8 columns for readability
  const displayCols = columns.slice(0, 8)

  // Build table
  const header = `| ${displayCols.map(c => displayName(c)).join(' | ')} |`
  const separator = `| ${displayCols.map(() => '---').join(' | ')} |`
  const dataRows = flat.map(row =>
    `| ${displayCols.map(c => formatValue(row[c], c)).join(' | ')} |`
  )

  // Append a totals row for aggregate results (GROUP BY queries)
  if (isAggregateResult(rows)) {
    const totalCells = displayCols.map(c => {
      const allNumeric = flat.every(r => typeof r[c] === 'number')
      if (allNumeric) {
        const sum = flat.reduce((acc, r) => acc + ((r[c] as number) || 0), 0)
        return formatValue(sum, c)
      }
      return 'Total'
    })
    const totalsRow = `| ${totalCells.join(' | ')} |`
    const totalsSeparator = `| ${displayCols.map(() => '---').join(' | ')} |`
    return [header, separator, ...dataRows, totalsSeparator, totalsRow].join('\n')
  }

  return [header, separator, ...dataRows].join('\n')
}

/**
 * Build clean formatted text from SOQL result rows.
 * Used for ownership/text-based data (who owns X, customer info, etc.).
 * Returns bullet-point list of key-value pairs.
 */
export function buildFormattedText(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return ''

  const flat = rows.map(r => flattenRow(r))

  // For single row: show as key-value bullets
  if (flat.length === 1) {
    const row = flat[0]
    const entries = Object.entries(row).filter(([k]) => k !== 'Id' && k !== 'id')
    return entries.map(([k, v]) => `- **${displayName(k)}:** ${formatValue(v, k)}`).join('\n')
  }

  // For multiple rows: show as numbered list
  return flat.map((row, i) => {
    const entries = Object.entries(row).filter(([k]) => k !== 'Id' && k !== 'id')
    const primary = entries[0] ? `${entries[0][0]}: ${formatValue(entries[0][1], entries[0][0])}` : `Record ${i + 1}`
    const details = entries.slice(1).map(([k, v]) => `${displayName(k)}: ${formatValue(v, k)}`).join(' | ')
    return `${i + 1}. **${primary}**${details ? ` — ${details}` : ''}`
  }).join('\n')
}

/**
 * Main entry: format raw SOQL observations into user-friendly content.
 * Detects data type (numeric vs text) and renders accordingly.
 * Returns empty string if no data to format.
 */
export function formatSalesforceData(result: SalesforceResult): string {
  const rows = tryParseJson(result.rawObservations)
  if (!rows || rows.length === 0) return ''

  if (hasNumericColumns(rows)) {
    return buildMarkdownTable(rows)
  }
  return buildFormattedText(rows)
}

/**
 * Correct arithmetic errors in the LLM's composed answer.
 * When the answer states a total that doesn't match the sum of breakdown rows,
 * replace the wrong total with the correct one.
 *
 * Example: LLM says "1,282 units across 24 view types" but the rows sum to 1,196.
 * This function replaces 1,282 with 1,196 in the answer text.
 */
export function correctArithmeticErrors(answer: string, rows: Record<string, unknown>[]): string {
  if (!rows || rows.length < 2) return answer

  // Find the count column (e.g., 'cnt', 'count', 'total')
  const sample = rows[0]
  let countCol: string | null = null
  for (const key of Object.keys(sample)) {
    const val = sample[key]
    if (typeof val !== 'number') continue
    const k = key.toLowerCase()
    if (k === 'cnt' || k.includes('cnt') || k.includes('count') || k === 'total' || k.includes('sum')) {
      countCol = key
      break
    }
  }
  if (!countCol) return answer

  // Compute correct sum from rows
  const correctSum = rows.reduce((acc, r) => {
    const val = r[countCol!]
    return acc + (typeof val === 'number' ? val : 0)
  }, 0)

  if (correctSum === 0) return answer

  // Find all numbers in the answer that could be totals (>= 100, to skip small per-row values)
  // Pattern: standalone numbers like "1,282" or "1282" or "1 282"
  const numberPattern = /\b(\d[\d, ]{2,}\d)\b/g
  let match: RegExpExecArray | null
  let corrected = answer

  while ((match = numberPattern.exec(answer)) !== null) {
    const raw = match[1]
    const num = parseInt(raw.replace(/[,\s]/g, ''), 10)
    if (isNaN(num) || num < 100) continue

    // Skip if this number appears in the raw data as a per-row value
    const isRowValue = rows.some(r => {
      const v = r[countCol!]
      return typeof v === 'number' && v === num
    })
    if (isRowValue) continue

    // This number is NOT a per-row value — it's likely a stated total
    // Check if it differs from the correct sum
    if (num !== correctSum) {
      // Replace with correct sum, preserving comma formatting
      const formatted = correctSum.toLocaleString()
      corrected = corrected.replace(match[0], formatted)
      console.log(`[format-results] arithmetic fix: ${num} → ${correctSum}`)
      break // Only fix one total per answer
    }
  }

  return corrected
}
