import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { chatJson } from './provider'
import { tableQueryPlannerPrompt } from './prompts'
import type { ColumnStat } from '@/lib/db/schema'

// Max values / rows returned into the LLM context. The *true* total is always reported
// separately, so "list all 6000 IDs" answers with the real count + a capped preview
// instead of dumping 6000 lines (impractical) or silently seeing only ~125 (the RAG bug).
const LIST_CAP = 500
const SAMPLE_CAP = 10

const OPS = ['=', '!=', '>', '<', '>=', '<=', 'contains'] as const
const NUMERIC_OPS = new Set(['>', '<', '>=', '<='])
const AGGREGATES = new Set(['sum', 'avg', 'min', 'max'])

type Op = (typeof OPS)[number]

interface Filter {
  column: string
  op: Op
  value: string
}

interface QueryTarget {
  tableId: string
  column: string | null
}

interface QuerySpec {
  operation: 'count' | 'list' | 'aggregate' | 'sample' | 'none'
  targets: QueryTarget[]
  aggregate: 'sum' | 'avg' | 'min' | 'max' | null
  filters: Filter[]
  distinct: boolean
  limit: number | null
}

export interface SpaceTable {
  id: string
  documentId: string
  documentName: string
  sheetName: string
  headers: string[]
  rowCount: number
  columnStats: ColumnStat[] | null
}

export interface TabularResult {
  context: string
  citations: { documentId: string; documentName: string }[]
}

// Cheap pre-filter so we don't fire an LLM planner call on every chat message — only when
// the phrasing plausibly wants an enumeration/count/aggregation over tabular data.
const TABULAR_HINT_RE =
  /\b(how many|how much|number of|count|total number|list( all| out| every)?|all (the )?\w+s\b|each|every|unique|distinct|average|avg|mean|median|sum|maximum|minimum|max|min|highest|lowest|most|least|greatest|top \d+|bottom \d+|per |breakdown|how often|frequency|rows?|records?|entries)\b/i

export function mightBeTabularQuery(query: string): boolean {
  return TABULAR_HINT_RE.test(query)
}

export async function getSpaceTables(spaceIds: string[]): Promise<SpaceTable[]> {
  if (spaceIds.length === 0) return []
  const idsSQL = sql.join(spaceIds.map((id) => sql`${id}::uuid`), sql`, `)
  const rows = await db.execute(sql`
    SELECT dt.id, dt.document_id, d.name AS document_name, dt.sheet_name,
           dt.headers, dt.row_count, dt.column_stats
    FROM document_tables dt
    INNER JOIN documents d ON d.id = dt.document_id
    WHERE dt.space_id IN (${idsSQL}) AND d.status = 'ready'
    ORDER BY dt.row_count DESC
    LIMIT 25
  `)
  return (rows as unknown as {
    id: string; document_id: string; document_name: string; sheet_name: string
    headers: string[]; row_count: number; column_stats: ColumnStat[] | null
  }[]).map((r) => ({
    id: r.id,
    documentId: r.document_id,
    documentName: r.document_name,
    sheetName: r.sheet_name,
    headers: r.headers,
    rowCount: r.row_count,
    columnStats: r.column_stats,
  }))
}

// Compact schema description handed to the planner — headers + type + a couple of stats
// per column so it can pick the right table/column without seeing the raw data.
function describeTables(tables: SpaceTable[]): string {
  return tables
    .map((t) => {
      const cols = t.headers
        .map((h) => {
          const stat = t.columnStats?.find((s) => s.name === h)
          const type = stat?.type ?? 'text'
          return `"${h}" (${type})`
        })
        .join(', ')
      return `tableId: ${t.id}\nSource: ${t.documentName} — sheet "${t.sheetName}", ${t.rowCount} rows\nColumns: ${cols}`
    })
    .join('\n\n')
}

async function plan(query: string, tables: SpaceTable[]): Promise<QuerySpec | null> {
  try {
    const raw = await chatJson(tableQueryPlannerPrompt(describeTables(tables)), query)
    const spec = JSON.parse(raw) as Partial<QuerySpec>
    if (!spec.operation || spec.operation === 'none') return null
    const targets = Array.isArray(spec.targets)
      ? spec.targets.filter((t): t is QueryTarget => !!t && typeof t.tableId === 'string')
      : []
    if (targets.length === 0) return null
    return {
      operation: spec.operation,
      targets,
      aggregate: spec.aggregate ?? null,
      filters: Array.isArray(spec.filters) ? spec.filters : [],
      distinct: spec.distinct === true,
      limit: typeof spec.limit === 'number' ? spec.limit : null,
    }
  } catch (err) {
    console.error('[tableQuery] Planner failed:', err)
    return null
  }
}

// Build a parameterized numeric cast that strips currency/commas/%, yielding NULL for
// non-numeric cells so comparisons/aggregates skip them instead of erroring.
function numericCol(col: string) {
  return sql`(NULLIF(regexp_replace(data ->> ${col}, '[^0-9.\-]', '', 'g'), ''))::numeric`
}

function buildWhere(tableId: string, filters: Filter[], validCols: Set<string>) {
  const conds = [sql`table_id = ${tableId}::uuid`]
  for (const f of filters) {
    if (!validCols.has(f.column) || !OPS.includes(f.op)) continue
    if (f.op === 'contains') {
      conds.push(sql`data ->> ${f.column} ILIKE ${'%' + f.value + '%'}`)
    } else if (NUMERIC_OPS.has(f.op)) {
      const n = Number(String(f.value).replace(/[^0-9.\-]/g, ''))
      if (!Number.isFinite(n)) continue
      const cmp =
        f.op === '>' ? sql`>` : f.op === '<' ? sql`<` : f.op === '>=' ? sql`>=` : sql`<=`
      conds.push(sql`${numericCol(f.column)} ${cmp} ${n}`)
    } else {
      const eq = f.op === '=' ? sql`=` : sql`!=`
      conds.push(sql`data ->> ${f.column} ${eq} ${f.value}`)
    }
  }
  return sql.join(conds, sql` AND `)
}

// Run the operation against ONE table and return a human-readable result line, or null
// if this target can't be executed (bad column, unsupported combination).
async function runTarget(spec: QuerySpec, table: SpaceTable, rawColumn: string | null): Promise<string | null> {
  const validCols = new Set(table.headers)
  const column = rawColumn && validCols.has(rawColumn) ? rawColumn : null
  const where = buildWhere(table.id, spec.filters, validCols)

  if (spec.operation === 'count') {
    const countExpr = spec.distinct && column ? sql`count(DISTINCT data ->> ${column})` : sql`count(*)`
    const res = await db.execute(sql`SELECT ${countExpr} AS n FROM document_rows WHERE ${where}`)
    const n = Number((res as unknown as { n: string }[])[0]?.n ?? 0)
    const label = spec.distinct && column ? `distinct "${column}" values` : 'rows'
    return `Count of ${label}${spec.filters.length ? ' (matching the filters)' : ''}: ${n}`
  }
  if (spec.operation === 'aggregate' && column && spec.aggregate && AGGREGATES.has(spec.aggregate)) {
    const aggFn =
      spec.aggregate === 'sum' ? sql`sum` :
      spec.aggregate === 'avg' ? sql`avg` :
      spec.aggregate === 'min' ? sql`min` : sql`max`
    const res = await db.execute(
      sql`SELECT ${aggFn}(${numericCol(column)}) AS result, count(${numericCol(column)}) AS n FROM document_rows WHERE ${where}`
    )
    const row = (res as unknown as { result: string | null; n: string }[])[0]
    return row?.result === null || row === undefined
      ? `No numeric values found in "${column}".`
      : `${spec.aggregate.toUpperCase()} of "${column}" over ${row.n} numeric rows: ${row.result}`
  }
  if (spec.operation === 'list' && column) {
    const totalRes = await db.execute(
      sql`SELECT count(${spec.distinct ? sql`DISTINCT data ->> ${column}` : sql`*`}) AS n FROM document_rows WHERE ${where}`
    )
    const total = Number((totalRes as unknown as { n: string }[])[0]?.n ?? 0)
    const selectExpr = spec.distinct ? sql`DISTINCT data ->> ${column}` : sql`data ->> ${column}`
    const cap = Math.min(spec.limit ?? LIST_CAP, LIST_CAP)
    const res = await db.execute(
      sql`SELECT ${selectExpr} AS val FROM document_rows WHERE ${where} AND data ->> ${column} <> '' ORDER BY val LIMIT ${cap}`
    )
    const vals = (res as unknown as { val: string }[]).map((r) => r.val)
    const shown = vals.length < total ? ` (showing first ${vals.length})` : ''
    return `Total ${spec.distinct ? 'distinct ' : ''}values in "${column}": ${total}${shown}\n${vals.join(', ')}`
  }
  if (spec.operation === 'sample') {
    const cap = Math.min(spec.limit ?? SAMPLE_CAP, SAMPLE_CAP)
    const res = await db.execute(
      sql`SELECT data FROM document_rows WHERE ${where} ORDER BY row_index LIMIT ${cap}`
    )
    const rows = (res as unknown as { data: Record<string, string> }[]).map((r) => r.data)
    return `${table.rowCount} rows total. Sample:\n` +
      rows.map((r) => table.headers.map((h) => `${h}: ${r[h] ?? ''}`).join(' | ')).join('\n')
  }
  return null
}

/**
 * Detect a tabular question, plan it, run safe parameterized SQL over EVERY candidate table
 * (so a vague "how many unique IDs" reports each matching table instead of silently picking
 * one), and return an authoritative context block for the LLM to phrase — or null to fall
 * back to RAG.
 */
export async function answerTabularQuery(
  query: string,
  spaceIds: string[]
): Promise<TabularResult | null> {
  if (!mightBeTabularQuery(query)) return null

  const tables = await getSpaceTables(spaceIds)
  if (tables.length === 0) return null

  const spec = await plan(query, tables)
  if (!spec) return null

  // De-dupe targets by table so the same sheet isn't reported twice.
  const seen = new Set<string>()
  const blocks: string[] = []
  const citations: { documentId: string; documentName: string }[] = []

  for (const target of spec.targets) {
    if (seen.has(target.tableId)) continue
    const table = tables.find((t) => t.id === target.tableId)
    if (!table) continue
    seen.add(target.tableId)

    try {
      const body = await runTarget(spec, table, target.column)
      if (!body) continue
      blocks.push(`Source: ${table.documentName} — sheet "${table.sheetName}" (${table.rowCount} total rows)\n${body}`)
      if (!citations.some((c) => c.documentId === table.documentId)) {
        citations.push({ documentId: table.documentId, documentName: table.documentName })
      }
    } catch (err) {
      console.error('[tableQuery] Execution failed for table', target.tableId, err)
    }
  }

  if (blocks.length === 0) return null

  // When more than one table answered, the question was ambiguous — present all results and
  // tell the LLM to show each AND offer a soft clarifier so the user can narrow if they want.
  const ambiguityNote = blocks.length > 1
    ? `\n\nNOTE: This question matched ${blocks.length} different tables. Report the figure for EACH source clearly (state which file/sheet each number comes from), then add one short line inviting the user to specify a file if they meant a particular one. Do NOT merge or pick just one.`
    : ''

  const context = `STRUCTURED DATA RESULT (computed directly over the full table(s), authoritative — use these exact figures)\n\n${blocks.join('\n\n')}${ambiguityNote}`
  return { context, citations }
}
