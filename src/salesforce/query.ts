import { chatJson } from '@/lib/ai/provider'
import { salesforceSoqlPrompt } from '@/lib/ai/prompts'
import { getSalesforceConfig } from './config'
import { soql, type SoqlResult } from './client'
import { SALESFORCE_SCHEMA, ALLOWED_OBJECTS } from './schema'

// Cheap pre-filter so we only spend an LLM planner call when a question is plausibly about
// the CRM. Internal RAG / web search handle everything else.
const CRM_HINT_RE =
  /\b(salesforce|crm|opportunit(y|ies)|pipeline|deals?|leads?|accounts?|contacts?|tasks?|activit(y|ies)|cases?|closed won|closed lost|stage|stages|sales|revenue|won|lost|quota|prospect|prospects|forecast)\b/i

export function isSalesforceQuery(query: string): boolean {
  return CRM_HINT_RE.test(query)
}

const MAX_ROWS_IN_CONTEXT = 50

export interface SalesforceResult {
  context: string
  citation: { documentName: string }
}

// Validate + normalize the planner's SOQL. Read-only, single-statement, known object, bounded.
function sanitizeSoql(raw: string): string | null {
  let q = raw.trim().replace(/;+\s*$/, '') // drop trailing semicolons
  if (!/^select\s+/i.test(q)) return null
  if (q.includes(';')) return null // no multiple statements
  if (/\b(insert|update|delete|upsert|merge|__before|__after)\b/i.test(q)) return null

  const fromMatch = q.match(/\bfrom\s+([a-z0-9_]+)/i)
  if (!fromMatch) return null
  const object = fromMatch[1].toLowerCase()
  if (!ALLOWED_OBJECTS.some((o) => o.toLowerCase() === object)) return null

  // Enforce a LIMIT on row-returning queries (aggregates don't need one).
  const isAggregate = /count\s*\(|\bgroup\s+by\b/i.test(q)
  if (!isAggregate && !/\blimit\s+\d+/i.test(q)) q += ' LIMIT 200'
  return q
}

function formatResult(query: string, soqlText: string, result: SoqlResult): string {
  // Pure COUNT() → records empty, answer is totalSize.
  if (result.records.length === 0) {
    if (/count\s*\(\s*\)/i.test(soqlText)) return `Result: ${result.totalSize}`
    return 'No matching records found.'
  }

  const rows = result.records.slice(0, MAX_ROWS_IN_CONTEXT).map((r) => {
    const { attributes, ...fields } = r as Record<string, unknown>
    void attributes
    return Object.entries(fields)
      .map(([k, v]) => `${k}: ${v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(' | ')
  })

  const more = result.records.length > MAX_ROWS_IN_CONTEXT
    ? `\n… (${result.records.length - MAX_ROWS_IN_CONTEXT} more rows not shown)`
    : (!result.done ? '\n… (more rows exist beyond this page)' : '')

  return `${result.totalSize} record(s) matched.\n${rows.join('\n')}${more}`
}

// Generate + validate a SOQL query for the question. `errorHint` (a prior SOQL failure) lets
// the planner self-repair a malformed query on a second attempt.
async function generateSoql(query: string, errorHint?: string): Promise<string | null> {
  const userMessage = errorHint
    ? `Question: ${query}\n\nYour previous SOQL failed with this Salesforce error — fix it and return corrected JSON:\n${errorHint}`
    : query
  try {
    const raw = await chatJson(salesforceSoqlPrompt(SALESFORCE_SCHEMA), userMessage)
    const parsed = JSON.parse(raw) as { soql?: string | null }
    if (!parsed.soql) return null
    return sanitizeSoql(parsed.soql)
  } catch (err) {
    console.error('[salesforce] planning failed:', err)
    return null
  }
}

/**
 * Answer a CRM question against LIVE Salesforce data: plan a SOQL query, validate it, run it,
 * and return an authoritative context block for the LLM to phrase — or null to fall back.
 * Retries once with the Salesforce error fed back to the planner if the first SOQL is malformed.
 */
export async function answerSalesforceQuery(query: string): Promise<SalesforceResult | null> {
  if (!isSalesforceQuery(query)) return null
  if (!getSalesforceConfig().enabled) return null

  let soqlText = await generateSoql(query)
  if (!soqlText) return null

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await soql(soqlText)
      const body = formatResult(query, soqlText, result)
      const context = `SALESFORCE LIVE CRM DATA (queried just now — authoritative, use these exact figures)\nSOQL: ${soqlText}\n\n${body}`
      return { context, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[salesforce] query attempt ${attempt + 1} failed:`, message)
      if (attempt === 0) {
        // Self-repair: feed the error back to the planner for one corrected attempt.
        const repaired = await generateSoql(query, message)
        if (!repaired || repaired === soqlText) return null
        soqlText = repaired
      }
    }
  }
  return null // fail soft — chat continues with internal RAG / web
}
