import { db } from '@/lib/db'
import { documentTables, documentRows, type ColumnStat } from '@/lib/db/schema'
import type { TableSheet } from '@/lib/parsers'

// Bind-parameter safety: each row inserts 5 columns → 200 rows = 1000 params, well under
// Postgres's ~65535 ceiling (same reasoning as the chunk insert batching in processing.ts).
const ROW_INSERT_BATCH = 200

const NUMERIC_RE = /-?[\d,]*\.?\d+/
const DATE_RE = /^\d{4}-\d{2}-\d{2}|^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/

// Strip currency symbols, commas, %, whitespace so "$2,500.00" / "42%" parse as numbers.
function toNumber(raw: string): number | null {
  if (!raw) return null
  if (!NUMERIC_RE.test(raw)) return null
  const cleaned = raw.replace(/[^0-9.\-]/g, '')
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

function computeStats(headers: string[], rows: string[][]): ColumnStat[] {
  return headers.map((name, col) => {
    const distinct = new Set<string>()
    let numericCount = 0
    let nonEmpty = 0
    let dateCount = 0
    let min: number | null = null
    let max: number | null = null
    let sum = 0

    for (const row of rows) {
      const cell = (row[col] ?? '').trim()
      if (cell === '') continue
      nonEmpty++
      distinct.add(cell)
      const n = toNumber(cell)
      if (n !== null) {
        numericCount++
        sum += n
        min = min === null ? n : Math.min(min, n)
        max = max === null ? n : Math.max(max, n)
      } else if (DATE_RE.test(cell)) {
        dateCount++
      }
    }

    let type: ColumnStat['type'] = 'text'
    if (nonEmpty > 0 && numericCount / nonEmpty >= 0.6) type = 'number'
    else if (nonEmpty > 0 && dateCount / nonEmpty >= 0.6) type = 'date'

    return {
      name,
      type,
      numericCount,
      distinctCount: distinct.size,
      min: type === 'number' ? min : null,
      max: type === 'number' ? max : null,
      avg: type === 'number' && numericCount > 0 ? sum / numericCount : null,
    }
  })
}

// How many sample rows to include in the summary input (enough to convey shape, small
// enough that the true row count + column stats always survive the extractor's truncation).
const SUMMARY_SAMPLE_ROWS = 15

/**
 * Build the text handed to the AI summary extractor for tabular documents.
 *
 * The old path fed the first 8000 chars of raw CSV — which for a 6000-row file is only ~37
 * rows, so the summary reported "37 students" for a 6000-student sheet. Instead we lead with
 * the TRUE row count + per-column stats (distinct counts, numeric min/max/avg), then a small
 * sample. The aggregate facts come first so they survive the extractor's 8000-char cap.
 */
export function buildTableSummaryInput(sheets: TableSheet[]): string {
  const parts: string[] = []

  for (const sheet of sheets) {
    if (sheet.headers.length === 0 || sheet.rows.length === 0) continue
    const stats = computeStats(sheet.headers, sheet.rows)

    const colLines = sheet.headers.map((h, i) => {
      const s = stats[i]
      if (s.type === 'number' && s.numericCount > 0) {
        return `- ${h} (number): ${s.distinctCount} distinct, min ${s.min}, max ${s.max}, avg ${s.avg?.toFixed(2)}`
      }
      return `- ${h} (${s.type}): ${s.distinctCount} distinct values`
    })

    const sampleRows = sheet.rows.slice(0, SUMMARY_SAMPLE_ROWS)
    const sampleBlock = [
      sheet.headers.join(' | '),
      ...sampleRows.map((row) => sheet.headers.map((_, i) => row[i] ?? '').join(' | ')),
    ].join('\n')

    parts.push(
      `SPREADSHEET SHEET: "${sheet.sheetName}"\n` +
      `TOTAL DATA ROWS: ${sheet.rows.length}\n` +
      `COLUMNS AND STATISTICS:\n${colLines.join('\n')}\n\n` +
      `SAMPLE ROWS (first ${sampleRows.length} of ${sheet.rows.length}):\n${sampleBlock}`
    )
  }

  return parts.join('\n\n---\n\n')
}

/**
 * Persist every row of each parsed sheet into document_tables / document_rows so
 * enumeration/aggregation questions can be answered by SQL instead of vector retrieval.
 * Called from the ingest pipeline in addition to (not instead of) chunking + embedding.
 */
export async function persistSheets(
  documentId: string,
  spaceId: string,
  sheets: TableSheet[]
): Promise<void> {
  for (const sheet of sheets) {
    if (sheet.headers.length === 0 || sheet.rows.length === 0) continue

    const stats = computeStats(sheet.headers, sheet.rows)

    const [table] = await db
      .insert(documentTables)
      .values({
        documentId,
        spaceId,
        sheetName: sheet.sheetName,
        headers: sheet.headers,
        rowCount: sheet.rows.length,
        columnStats: stats,
      })
      .returning({ id: documentTables.id })

    const rows = sheet.rows.map((row, rowIndex) => {
      const data: Record<string, string> = {}
      sheet.headers.forEach((h, i) => {
        data[h] = (row[i] ?? '').trim()
      })
      return { tableId: table.id, documentId, spaceId, rowIndex, data }
    })

    for (let i = 0; i < rows.length; i += ROW_INSERT_BATCH) {
      await db.insert(documentRows).values(rows.slice(i, i + ROW_INSERT_BATCH))
    }
  }
}
