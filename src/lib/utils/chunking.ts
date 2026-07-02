const TARGET_CHUNK_SIZE = 2500  // characters (~375 tokens)
const MAX_CHUNK_SIZE    = 3200  // hard ceiling
const MIN_CHUNK_SIZE    = 100   // discard tiny fragments
const OVERLAP_SENTENCES = 2     // sentences of overlap between chunks

// Marks a table block so whitespace normalisation doesn't destroy it
const TABLE_PLACEHOLDER_RE = /\[TABLE_\d+\]/g

/**
 * Detect lines that look like a table row:
 *  - contains two or more consecutive spaces / tabs (columnar alignment)
 *  - or contains a pipe | separator
 *  - or matches CSV pattern (3+ comma-separated fields)
 */
function isTableLine(line: string): boolean {
  return (
    /\|/.test(line) ||
    /\t/.test(line) ||
    /  {2,}/.test(line) ||
    (line.split(',').length >= 3 && /\d/.test(line))
  )
}

/**
 * Extract contiguous table blocks from raw text, replace each with a
 * placeholder, and return the cleaned text + a map of placeholder → table.
 */
function extractTables(text: string): { text: string; tables: Map<string, string> } {
  const lines = text.split('\n')
  const tables = new Map<string, string>()
  const output: string[] = []
  let tableBuffer: string[] = []
  let tableIdx = 0

  function flushTable() {
    if (tableBuffer.length < 2) {
      // Single line that looked like a table — keep inline
      output.push(...tableBuffer)
    } else {
      const key = `[TABLE_${tableIdx++}]`
      tables.set(key, tableBuffer.join('\n'))
      output.push(key)
    }
    tableBuffer = []
  }

  for (const line of lines) {
    if (isTableLine(line)) {
      tableBuffer.push(line)
    } else {
      if (tableBuffer.length > 0) flushTable()
      output.push(line)
    }
  }
  if (tableBuffer.length > 0) flushTable()

  return { text: output.join('\n'), tables }
}

/**
 * Split text into sentences using punctuation boundaries.
 * Preserves sentence endings (.!?) and handles abbreviations tolerably.
 */
function splitSentences(text: string): string[] {
  // Handles English (.!?), Arabic (۔ ۔), Devanagari/Hindi (। ।), and Urdu punctuation
  return text
    .split(/(?<=[.!?۔।॥])\s+(?=[A-Z\d؀-ۿऀ-ॿ"'\[(])|(?<=[.!?۔।॥])\s*\n/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

/**
 * Split a block of text into paragraph-sized pieces, then merge small
 * paragraphs up to TARGET_CHUNK_SIZE, always splitting at sentence
 * boundaries so no sentence is cut in half.
 */
function splitIntoParagraphs(text: string): string[] {
  // Split on blank lines (paragraph breaks)
  return text
    .split(/\n{2,}/)
    .map(p => p.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(p => p.length > 0)
}

/**
 * Returns true if the paragraph contains 2+ financial/numeric patterns.
 * Used to tag chunks with [FINANCIAL DATA] so the LLM prioritises them for number queries.
 */
function isFinancialBlock(text: string): boolean {
  const patterns = [
    /\b(AED|USD|EUR|GBP|SAR|INR|PKR)\s?[\d,.]+/i,  // currency codes
    /[$€£₹]\s?[\d,.]+/,                               // currency symbols
    /[\d,.]+\s?%/,                                     // percentages
    /\b(revenue|profit|loss|cost|budget|EBITDA|ARR|MRR|burn|valuation|equity|debt|margin|ROI|IRR|NPV)\b/i,
    /\b\d{1,3}(,\d{3})+(\.\d+)?\b/,                  // large numbers like 1,000,000
    /\bQ[1-4]\s?\d{4}\b/i,                            // Q1 2024 style
    /\b(FY|H[12])\s?\d{2,4}\b/i,                     // FY2024 / H1 2024
  ]
  const matches = patterns.filter(p => p.test(text)).length
  return matches >= 2
}

/**
 * Expand a financial paragraph outward to include neighbouring label lines
 * so numbers never get separated from their context.
 */
function anchorFinancialBlocks(paragraphs: string[]): string[] {
  return paragraphs.map((para, i) => {
    if (!isFinancialBlock(para)) return para
    // Prepend previous paragraph if it's short (likely a heading/label)
    const prev = i > 0 && paragraphs[i - 1].length < 120 ? paragraphs[i - 1] + '\n' : ''
    return `[FINANCIAL DATA]\n${prev}${para}\n[/FINANCIAL DATA]`
  })
}

export function chunkText(rawText: string): string[] {
  // 1. Extract tables so they aren't destroyed by whitespace normalisation
  const { text: textWithPlaceholders, tables } = extractTables(rawText)

  // 2. Split into paragraphs, then anchor financial blocks
  const paragraphs = anchorFinancialBlocks(splitIntoParagraphs(textWithPlaceholders))

  // 3. Build chunks by merging paragraphs up to TARGET_CHUNK_SIZE
  const chunks: string[] = []
  let current = ''
  let currentSentences: string[] = []  // sentence cache for overlap

  function saveChunk() {
    const restored = restoreTables(current.trim(), tables)
    if (restored.length >= MIN_CHUNK_SIZE) chunks.push(restored)
    // Carry last OVERLAP_SENTENCES into next chunk
    currentSentences = currentSentences.slice(-OVERLAP_SENTENCES)
    current = currentSentences.join(' ')
  }

  for (const para of paragraphs) {
    // If paragraph is itself a table placeholder — emit as its own chunk
    if (TABLE_PLACEHOLDER_RE.test(para)) {
      if (current.trim()) saveChunk()
      const tableContent = restoreTables(para, tables)
      if (tableContent.length >= MIN_CHUNK_SIZE) chunks.push(tableContent)
      current = ''
      currentSentences = []
      continue
    }

    const sentences = splitSentences(para)

    for (const sentence of sentences) {
      // If adding this sentence would exceed MAX, flush first
      if (current.length + sentence.length + 1 > MAX_CHUNK_SIZE && current.trim()) {
        saveChunk()
      }
      current += (current ? ' ' : '') + sentence
      currentSentences.push(sentence)

      // If we've hit target size, flush at the next sentence boundary
      if (current.length >= TARGET_CHUNK_SIZE) {
        saveChunk()
      }
    }
  }

  // Flush remainder
  if (current.trim()) {
    const restored = restoreTables(current.trim(), tables)
    if (restored.length >= MIN_CHUNK_SIZE) chunks.push(restored)
  }

  return chunks
}

function restoreTables(text: string, tables: Map<string, string>): string {
  let result = text
  for (const [key, table] of tables) {
    result = result.replace(key, `\n[TABLE]\n${table}\n[/TABLE]\n`)
  }
  return result.trim()
}

// ── Table chunker ────────────────────────────────────────────────────────────

const ROWS_PER_CHUNK = 25  // data rows per chunk (header always repeated)

export interface TableChunk {
  content: string
  containsNumbers: boolean
}

/**
 * Chunk a structured spreadsheet sheet into fixed row-count chunks.
 *
 * Rules:
 * - Header row repeats at the top of every chunk (context never lost)
 * - 25 data rows per chunk — never split a single row
 * - Each chunk prefixed with: SPREADSHEET: {filename} | Sheet: {sheetName} | Rows {start}–{end}
 * - Numbers stay with their labels — the entire row is atomic
 */
export function chunkTable(
  filename: string,
  sheetName: string,
  headers: string[],
  rows: string[][]
): TableChunk[] {
  if (rows.length === 0 || headers.length === 0) return []

  const headerLine = headers.join(' | ')
  const separator = headers.map(() => '---').join(' | ')
  const chunks: TableChunk[] = []

  for (let start = 0; start < rows.length; start += ROWS_PER_CHUNK) {
    const end = Math.min(start + ROWS_PER_CHUNK, rows.length)
    const slice = rows.slice(start, end)

    const rowLines = slice.map(row => {
      // Pad/trim to match header column count
      const cells = headers.map((_, i) => row[i] ?? '')
      return cells.join(' | ')
    })

    const content = [
      `SPREADSHEET: ${filename} | Sheet: ${sheetName} | Rows ${start + 1}–${end}`,
      '',
      headerLine,
      separator,
      ...rowLines,
    ].join('\n')

    // containsNumbers: true if any cell in this slice looks like a number/currency/percentage
    const allCells = slice.flat().join(' ')
    const containsNumbers = /[\d,.]+\s*(%|AED|USD|EUR|GBP|SAR|\$|€|£)?|\d{4}-\d{2}-\d{2}/.test(allCells)

    chunks.push({ content, containsNumbers })
  }

  return chunks
}
