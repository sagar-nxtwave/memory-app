// One-off: regenerate summary/keyNumbers/risks/decisions/importantDates for tabular
// documents using aggregate facts (true row count + column stats + sample) instead of the
// old truncated-first-37-rows input. Rows are already in document_tables/document_rows;
// only the stale document summary needs rebuilding. Cheap: one LLM call per document.
//
// Usage: node scripts/regen-table-summaries.mjs [--space=<spaceId>]
import { readFileSync } from 'fs'
import postgres from 'postgres'

const env = readFileSync('.env.local', 'utf-8')
  .split('\n')
  .filter((l) => l && !l.startsWith('#'))
  .reduce((acc, l) => { const [k, ...r] = l.split('='); if (k) acc[k.trim()] = r.join('=').trim(); return acc }, {})

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]))
const MODEL = env.OPENROUTER_EXTRACT_MODEL ?? env.OPENROUTER_CHAT_MODEL ?? 'anthropic/claude-haiku-4-5'
const sql = postgres(env.DATABASE_URL, { prepare: false })

const SAMPLE = 15

function processingPrompt(name) {
  return `You are processing a business document called "${name}".
Extract the following in JSON format:
{
  "summary": "2-3 sentence executive summary",
  "keyNumbers": ["list of important numbers, amounts, percentages, dates with context"],
  "risks": ["list of risks or concerns mentioned"],
  "decisions": ["list of decisions made or recommended"],
  "importantDates": ["list of deadlines, milestones, or key dates"]
}
Be precise. Only include what is explicitly stated in the document.
Return only valid JSON, no markdown.`
}

async function chatJson(system, user) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  })
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`)
  const data = await res.json()
  let raw = data.choices?.[0]?.message?.content ?? ''
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  return JSON.parse(raw)
}

async function buildInput(table) {
  const rows = await sql`SELECT data FROM document_rows WHERE table_id = ${table.id}::uuid ORDER BY row_index LIMIT ${SAMPLE}`
  const headers = table.headers
  const stats = table.column_stats ?? []
  const colLines = headers.map((h) => {
    const s = stats.find((x) => x.name === h)
    if (s?.type === 'number' && s.numericCount > 0) return `- ${h} (number): ${s.distinctCount} distinct, min ${s.min}, max ${s.max}, avg ${s.avg?.toFixed?.(2) ?? s.avg}`
    return `- ${h} (${s?.type ?? 'text'}): ${s?.distinctCount ?? '?'} distinct values`
  })
  const sampleBlock = [headers.join(' | '), ...rows.map((r) => headers.map((h) => r.data[h] ?? '').join(' | '))].join('\n')
  return `SPREADSHEET SHEET: "${table.sheet_name}"\nTOTAL DATA ROWS: ${table.row_count}\nCOLUMNS AND STATISTICS:\n${colLines.join('\n')}\n\nSAMPLE ROWS (first ${rows.length} of ${table.row_count}):\n${sampleBlock}`
}

const spaceFilter = args.space ? sql`AND dt.space_id = ${args.space}::uuid` : sql``
const tables = await sql`
  SELECT dt.id, dt.document_id, dt.sheet_name, dt.headers, dt.row_count, dt.column_stats, d.name AS doc_name
  FROM document_tables dt INNER JOIN documents d ON d.id = dt.document_id
  WHERE true ${spaceFilter}
  ORDER BY dt.document_id, dt.row_count DESC
`

// Group sheets per document — one summary per document, built from all its sheets.
const byDoc = new Map()
for (const t of tables) {
  if (!byDoc.has(t.document_id)) byDoc.set(t.document_id, { name: t.doc_name, tables: [] })
  byDoc.get(t.document_id).tables.push(t)
}

for (const [docId, { name, tables: ts }] of byDoc) {
  try {
    const input = (await Promise.all(ts.map(buildInput))).join('\n\n---\n\n')
    const parsed = await chatJson(processingPrompt(name), input.slice(0, 8000))
    await sql`
      UPDATE documents SET
        summary = ${parsed.summary ?? ''},
        key_numbers = ${sql.json(Array.isArray(parsed.keyNumbers) ? parsed.keyNumbers : [])},
        risks = ${sql.json(Array.isArray(parsed.risks) ? parsed.risks : [])},
        decisions = ${sql.json(Array.isArray(parsed.decisions) ? parsed.decisions : [])},
        important_dates = ${sql.json(Array.isArray(parsed.importantDates) ? parsed.importantDates : [])},
        updated_at = now()
      WHERE id = ${docId}::uuid
    `
    console.log(`✓ ${name}\n   ${parsed.summary}`)
  } catch (err) {
    console.error(`✗ ${name}:`, err.message)
  }
}

await sql.end()
console.log('Done.')
