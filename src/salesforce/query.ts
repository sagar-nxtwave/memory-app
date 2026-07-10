import { chatJson } from '@/lib/ai/provider'
import { salesforceObjectPrompt, salesforceSoqlPrompt } from '@/lib/ai/prompts'
import { getSalesforceConfig } from './config'
import { soql, describeObject, type SoqlResult, type FieldInfo } from './client'
import { ALLOWED_OBJECTS, FIELD_HINTS } from './schema'
import { SALESFORCE_GLOSSARY, SALESFORCE_ANSWER_NOTE } from './glossary'

// Cheap pre-filter so we only spend LLM planner calls when a question is plausibly about the
// CRM. Internal RAG / web search handle everything else.
const CRM_HINT_RE =
  /\b(salesforce|crm|opportunit(y|ies)|pipeline|deals?|leads?|accounts?|contacts?|tasks?|activit(y|ies)|cases?|closed won|closed lost|stage|stages|sales|revenue|won|lost|quota|prospect|prospects|forecast|community|project|location)\b/i

export function isSalesforceQuery(query: string): boolean {
  return CRM_HINT_RE.test(query)
}

// Short descriptions to help the model pick the right object (step 1). Field-level detail
// comes LIVE from describe() so this never needs updating per-org.
const OBJECT_CATALOG = `
Opportunity — sales deals / property-unit sales: pipeline, stages, amounts, close dates, community/location of the unit.
Account — companies / customers / buyers.
Contact — individual people (usually linked to an Account).
Lead — unconverted prospects.
Task — activities: tasks, calls, meetings, to-dos.
Case — support / service cases.
`.trim()

// Meta/overview questions ("what data do you have", "what can you tell me about the CRM")
// don't fit any single object, so pickObject() correctly returns null for them — but that
// used to mean "no answer" (zero context), which left the model to fabricate a "not connected"
// excuse. Short-circuit these BEFORE the single-object picker with a canned catalog answer,
// since we already know exactly what's connected.
const META_OVERVIEW_RE = /\b(what (all )?(data|information|objects?|fields?)\b.{0,20}\b(crm|salesforce)|what (can|do) you (know|have|see|tell me)\b.{0,20}\b(crm|salesforce)|overview of (the )?(crm|salesforce)|what'?s in (the )?(crm|salesforce))/i

function isMetaOverviewQuery(query: string): boolean {
  return META_OVERVIEW_RE.test(query)
}

function metaOverviewContext(): SalesforceResult {
  const context = `SALESFORCE LIVE CRM DATA — connection is ACTIVE. This is a real-estate developer's CRM. Available objects (ask a specific question about any of these for live numbers):\n${OBJECT_CATALOG}\n\n${SALESFORCE_ANSWER_NOTE}`
  return { context, citation: { documentName: 'Salesforce (live CRM)' } }
}

const MAX_FIELDS_IN_PROMPT = 300
const MAX_ROWS_IN_CONTEXT = 50

export interface SalesforceResult {
  context: string
  citation: { documentName: string }
}

// --- Step 5/6: validate + bound the generated SOQL (whitelist SELECT, single statement,
// known object, enforced LIMIT). The integration user is read-only, but validating is a
// second safety layer per Salesforce guidance.
function sanitizeSoql(raw: string): string | null {
  let q = raw.trim().replace(/;+\s*$/, '')
  if (!/^select\s+/i.test(q)) return null
  if (q.includes(';')) return null
  if (/\b(insert|update|delete|upsert|merge)\b/i.test(q)) return null

  const fromMatch = q.match(/\bfrom\s+([a-z0-9_]+)/i)
  if (!fromMatch) return null
  if (!ALLOWED_OBJECTS.some((o) => o.toLowerCase() === fromMatch[1].toLowerCase())) return null

  const hasAggregate = /\b(count|sum|avg|min|max)\s*\(/i.test(q)
  const hasGroupBy = /\bgroup\s+by\b/i.test(q)

  if (hasAggregate && !hasGroupBy) {
    // Overall aggregate (e.g. SELECT SUM(Amount) …) — Salesforce forbids LIMIT here. Strip any.
    q = q.replace(/\s+limit\s+\d+\s*$/i, '')
  } else if (!hasAggregate && !/\blimit\s+\d+/i.test(q)) {
    // Plain row query — bound it.
    q += ' LIMIT 200'
  }
  return q
}

// Step 1: pick the single most relevant object.
async function pickObject(query: string): Promise<string | null> {
  try {
    const raw = await chatJson(salesforceObjectPrompt(OBJECT_CATALOG), query)
    const parsed = JSON.parse(raw) as { object?: string | null }
    if (!parsed.object) return null
    return ALLOWED_OBJECTS.find((o) => o.toLowerCase() === String(parsed.object).toLowerCase()) ?? null
  } catch (err) {
    console.error('[salesforce] object pick failed:', err)
    return null
  }
}

// Auto-correct helper: when Salesforce says "No such column 'X'" (typo'd/hallucinated field —
// e.g. the model "corrects" the org's misspelled Order_Stattus__c to Order_Status__c), find
// the closest real field names so the planner can fix it instead of repeating the same guess.
function suggestFields(badName: string, fieldNames: string[]): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/__c$/, '').replace(/[^a-z0-9]/g, '')
  const b = norm(badName)
  if (!b) return []
  const prefixLen = (x: string, y: string) => { let i = 0; while (i < x.length && i < y.length && x[i] === y[i]) i++; return i }
  return fieldNames
    .map((name) => {
      const n = norm(name)
      const score = prefixLen(b, n) + (n.includes(b) || b.includes(n) ? 5 : 0)
      return { name, score }
    })
    .filter((s) => s.score >= 4)
    .sort((a, z) => z.score - a.score)
    .slice(0, 6)
    .map((s) => s.name)
}

// Parse a Salesforce field/relationship error into an auto-correct hint against real fields.
function fieldErrorHint(message: string, fieldNames: string[]): string {
  const m = message.match(/No such (?:column|relationship) '([^']+)'/i)
  if (!m) return ''
  const suggestions = suggestFields(m[1], fieldNames)
  return suggestions.length
    ? ` The field "${m[1]}" does not exist. Use the correct EXACT field name from this object — closest matches: ${suggestions.join(', ')}.`
    : ` The field "${m[1]}" does not exist. Use only exact field names listed for this object.`
}

// Format the live field list for the SOQL prompt. Groupable fields marked with * so the
// model only GROUP BYs valid dimensions.
function formatFields(fields: FieldInfo[]): string {
  return fields
    .slice(0, MAX_FIELDS_IN_PROMPT)
    .map((f) => `${f.name} (${f.label}) [${f.type}]${f.groupable ? '*' : ''}`)
    .join('\n')
}

interface PlanStep {
  soql: string | null       // validated SOQL, or null
  switchObject: string | null // a different object to try instead
}

// Generate a SOQL plan for the given object. `feedback` (a prior error or empty-result note)
// lets the model self-correct — fix the query or switch to a better object.
async function planStep(objectName: string, hintsText: string, fieldsText: string, query: string, feedback?: string): Promise<PlanStep> {
  try {
    const allObjects = ALLOWED_OBJECTS.join(', ')
    const raw = await chatJson(salesforceSoqlPrompt(objectName, SALESFORCE_GLOSSARY, hintsText, fieldsText, allObjects, feedback), query)
    const parsed = JSON.parse(raw) as { soql?: string | null; switchObject?: string | null }
    const switchObject = parsed.switchObject && ALLOWED_OBJECTS.some((o) => o.toLowerCase() === String(parsed.switchObject).toLowerCase())
      ? ALLOWED_OBJECTS.find((o) => o.toLowerCase() === String(parsed.switchObject).toLowerCase())!
      : null
    return { soql: parsed.soql ? sanitizeSoql(parsed.soql) : null, switchObject }
  } catch (err) {
    console.error('[salesforce] SOQL planning failed:', err)
    return { soql: null, switchObject: null }
  }
}

// A query that returned zero rows AND is an aggregate (COUNT/SUM/…) almost certainly used the
// wrong field/object — worth one self-correcting retry. A filtered list returning zero can be
// legitimate ("opportunities closing today"), so we don't loop forever on those.
function looksWrongOnEmpty(soqlText: string, totalSize: number): boolean {
  return totalSize === 0 && /count\s*\(|sum\s*\(|avg\s*\(|max\s*\(|min\s*\(/i.test(soqlText)
}

// True when an aggregate query came back with NO real value (SUM/etc = null, bare COUNT = 0,
// or a grouped aggregate with no groups). For these, a bare "no value" answer is unhelpful —
// we fetch a breakdown so the response can explain WHAT exists (e.g. in-progress deals).
function isEmptyAggregate(soqlText: string, result: SoqlResult): boolean {
  const hasAgg = /\b(sum|avg|min|max|count)\s*\(/i.test(soqlText)
  if (!hasAgg) return false
  if (/count\s*\(\s*\)/i.test(soqlText)) return (result.totalSize ?? 0) === 0
  if (result.records.length === 0) return true
  if (result.records.length === 1) {
    const { attributes, ...f } = result.records[0] as Record<string, unknown>
    void attributes
    const vals = Object.values(f)
    return vals.length > 0 && vals.every((v) => v === null)
  }
  return false
}

function formatResult(soqlText: string, result: SoqlResult): string {
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

// How many plan→run cycles before giving up. Covers: initial try + error-repair +
// wrong-object/empty-result switch. Bounded so a bad question can't loop indefinitely.
const MAX_ATTEMPTS = 4

/**
 * Answer a CRM question against LIVE Salesforce with a self-correcting loop: pick object →
 * describe (dynamic schema) → generate validated SOQL → run. If Salesforce rejects the query
 * OR an aggregate returns zero rows (usually a wrong field/object), the error/empty signal is
 * fed back and the model revises — including switching to a different object — up to a bound.
 * This removes the need for a developer to hand-tune prompts for each new question type.
 */
export async function answerSalesforceQuery(query: string): Promise<SalesforceResult | null> {
  // Invocation is gated by the semantic intent router upstream; here we only check config.
  if (!getSalesforceConfig().enabled) return null

  if (isMetaOverviewQuery(query)) return metaOverviewContext()

  let objectName = await pickObject(query)
  if (!objectName) return null

  let fieldInfos: FieldInfo[]
  try {
    fieldInfos = await describeObject(objectName)
  } catch (err) {
    console.error('[salesforce] describe failed:', err)
    return null
  }
  let fieldsText = formatFields(fieldInfos)

  let feedback: string | undefined
  let emptyRetried = false
  let lastSoql: string | null = null

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const plan = await planStep(objectName, FIELD_HINTS[objectName] ?? '', fieldsText, query, feedback)

    // No-progress guard: if the model returns the exact same SOQL that just failed, retrying
    // won't help (deterministic Salesforce error) — stop instead of burning more attempts.
    if (plan.soql && plan.soql === lastSoql) return null
    if (plan.soql) lastSoql = plan.soql

    // Model decided a different object fits better — re-describe and continue.
    if (plan.switchObject && plan.switchObject !== objectName) {
      try {
        objectName = plan.switchObject
        fieldInfos = await describeObject(objectName)
        fieldsText = formatFields(fieldInfos)
        feedback = `Switched to ${objectName}; write the query for it now.`
        continue
      } catch {
        return null
      }
    }

    if (!plan.soql) return null

    try {
      const result = await soql(plan.soql)
      if (looksWrongOnEmpty(plan.soql, result.totalSize) && !emptyRetried) {
        // Zero rows on an aggregate → likely wrong field/object. Ask the model to reconsider once.
        emptyRetried = true
        feedback = `The query "${plan.soql}" returned 0 rows. The field, filter, or object is probably wrong for this question — reconsider (you may switch object or use a parent relationship like Account.Name).`
        continue
      }
      // Empty/null aggregate → fetch a breakdown of what DOES exist in the same scope, so the
      // answer explains it (e.g. "0 completed sales; 19 in-progress") instead of "no value".
      let breakdown = ''
      if (isEmptyAggregate(plan.soql, result)) {
        const diagPrompt = `The completed/aggregate result for "${query}" came back empty. Write ONE diagnostic SOQL over ${objectName} for the SAME scope — KEEP the date and other non-status filters from the question, but REMOVE any StageName / Order_Stattus__c filters — that GROUPS BY StageName and Order_Stattus__c with COUNT(Id), so we can show what records exist (e.g. in-progress deals) instead of a bare zero.`
        const diag = await planStep(objectName, FIELD_HINTS[objectName] ?? '', fieldsText, diagPrompt)
        if (diag.soql) {
          try {
            const dr = await soql(diag.soql)
            if (dr.records.length > 0) breakdown = `\n\nBREAKDOWN of records in the same scope (explains why the total is empty):\n${formatResult(diag.soql, dr)}`
          } catch { /* diagnostic is best-effort */ }
        }
      }

      const body = formatResult(plan.soql, result)
      const context = `SALESFORCE LIVE CRM DATA (object: ${objectName}, queried just now — authoritative, use these exact figures)\nSOQL: ${plan.soql}\n\n${body}${breakdown}\n\n${SALESFORCE_ANSWER_NOTE}`
      return { context, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[salesforce] attempt ${attempt + 1} failed:`, message)
      // Add an auto-correct hint (closest real field names) when the error is a bad field.
      feedback = `Salesforce rejected the query with: ${message}${fieldErrorHint(message, fieldInfos.map((f) => f.name))}`
    }
  }
  return null // fail soft after exhausting attempts — chat continues with RAG/web
}
