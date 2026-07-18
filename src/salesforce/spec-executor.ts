import { chatJson } from '@/lib/ai/provider'
import { soql, describeObject, type FieldInfo } from './client'
import { ALLOWED_OBJECTS, FIELD_HINTS } from './schema'
import { NON_GROUPABLE_FIELDS } from './soql-query-builder'
import { SALESFORCE_GLOSSARY, SALESFORCE_ANSWER_NOTE } from './glossary'
import type { ToolResult } from './tools'
import { validateAdHocSpec, type ValidatedAdHocSpec } from './schemas'

// Ad-hoc SOQL fallback for questions that don't match any pre-built tool.
// The LLM generates a JSON spec (not raw SOQL), which we validate against describe() output.

const MAX_FIELDS_IN_PROMPT = 300

function formatFields(fields: FieldInfo[]): string {
  return fields
    .slice(0, MAX_FIELDS_IN_PROMPT)
    .map((f) => `${f.name} (${f.label}) [${f.type}]${f.groupable ? '*' : ''}${f.referenceTo.length ? ` -> ${f.referenceTo.join(',')}` : ''}`)
    .join('\n')
}

function sanitizeSoql(raw: string): string | null {
  let q = raw.trim().replace(/;+\s*$/, '')
  if (!/^select\s+/i.test(q)) return null
  if (q.includes(';')) return null
  if (/\b(insert|update|delete|upsert|merge)\b/i.test(q)) return null

  const fromMatch = q.match(/\bfrom\s+([a-z0-9_]+)/i)
  if (!fromMatch) return null
  if (!ALLOWED_OBJECTS.some((o) => o.toLowerCase() === fromMatch[1].toLowerCase())) return null

  const hasAggregate = /\b(count|sum|avg|min|max)\s*\(/i.test(q)

  if (hasAggregate) {
    // Aggregate queries NEVER get LIMIT — fetch all groups for accurate totals
    q = q.replace(/\s+limit\s+\d+\s*$/i, '')
  } else if (!/\blimit\s+\d+/i.test(q)) {
    q += ' LIMIT 200'
  }
  return q
}

function formatResult(result: { records: Record<string, unknown>[]; totalSize: number; done: boolean }): string {
  if (result.records.length === 0) {
    if (/count\s*\(\s*\)/i.test(JSON.stringify(result))) return `Result: ${result.totalSize}`
    return 'No matching records found.'
  }
  const rows = result.records.slice(0, 50).map((r) => {
    const { attributes, ...fields } = r
    void attributes
    return Object.entries(fields)
      .filter(([k]) => k !== 'attributes')
      .map(([k, v]) => {
        const cleanKey = k.replace(/__c$|__r$/, '').replace(/_/g, ' ')
        let val = v
        if (typeof val === 'object' && val !== null) {
          if ((val as Record<string, unknown>).Name) {
            val = (val as Record<string, unknown>).Name
          } else {
            val = JSON.stringify(val)
          }
        }
        return val == null ? '' : `${cleanKey}: ${val}`
      })
      .filter(([, v]) => v !== '')
      .join(' | ')
  })
  return rows.join('\n')
}

const SPEC_EXECUTOR_PROMPT = `You convert a user's question into a JSON specification for a Salesforce query. Do NOT write SOQL directly — write a structured spec.

Available objects: {objects}

The user can ask about ANY of these objects. Pick the RIGHT object for their question:
- Questions about deals, sales, revenue, pipeline → Opportunity
- Questions about cases, support, tickets → Case
- Questions about customers, companies, buyers → Account
- Questions about people, contacts → Contact
- Questions about prospects, leads → Lead
- Questions about tasks, activities, calls → Task
- Questions about properties, units, inventory → Property_Inventory__c

Rules:
- Pick ONE object that best answers the question.
- For "by <something" queries, set "groupBy" to the field name.
- For filters, use "filters" array with { field, op, value }.
- For aggregates, use "aggregate" = "sum" | "count" | "avg".
- For date ranges, use "dateField" and "datePeriod" (e.g., "this month", "last quarter", "2026").
- For customer lookups, use "accountFilter" with the customer name.
- Only use fields that exist on the object. Use the FIELD_HINTS below for common mappings.

FIELD_HINTS:
{hints}

Respond with ONLY JSON:
{
  "object": "<object name>",
  "select": ["<field1>", "<field2>"],
  "groupBy": "<field or null>",
  "aggregate": "sum" | "count" | "avg" | null,
  "filters": [{ "field": "<field>", "op": "=", "value": "<value>" }],
  "dateField": "<field or null>",
  "datePeriod": "<period or null>",
  "accountFilter": "<customer name or null>",
  "limit": <number or null>
}
No markdown.`

export async function executeAdHocSpec(query: string): Promise<ToolResult | null> {
  try {
    // Describe ALL allowed objects so the LLM has field info for any object it picks
    const allHints: string[] = []
    const objectFieldMap = new Map<string, string>()
    for (const obj of ALLOWED_OBJECTS) {
      try {
        const fields = await describeObject(obj)
        objectFieldMap.set(obj, formatFields(fields))
        if (FIELD_HINTS[obj]) allHints.push(`${obj}:\n${FIELD_HINTS[obj]}`)
      } catch {
        // Object might not be accessible — skip it
      }
    }

    const objectsText = ALLOWED_OBJECTS.join(', ')
    const hintsText = allHints.join('\n\n')
    const prompt = SPEC_EXECUTOR_PROMPT
      .replace('{objects}', objectsText)
      .replace('{hints}', hintsText)

    const raw = await chatJson(prompt, query)

    // Zod-validated parsing
    let spec: Record<string, unknown>
    const zodResult = validateAdHocSpec(raw)
    if (zodResult) {
      spec = zodResult as unknown as Record<string, unknown>
    } else {
      // Fallback: raw parse with basic validation
      console.warn('[salesforce] AdHocSpec Zod validation failed, falling back to raw parse')
      spec = JSON.parse(raw) as Record<string, unknown>
    }

    if (!spec.object || !ALLOWED_OBJECTS.some(o => o.toLowerCase() === String(spec.object).toLowerCase())) {
      return null
    }

    // Build SOQL from spec
    const selectFields = Array.isArray(spec.select) ? spec.select.join(', ') : 'Id, Name'
    const objectApi = ALLOWED_OBJECTS.find(o => o.toLowerCase() === String(spec.object).toLowerCase())!
    let soqlQuery = `SELECT ${selectFields} FROM ${objectApi}`

    // Add filters
    const filters: string[] = []
    if (Array.isArray(spec.filters)) {
      for (const f of spec.filters) {
        if (f.field && f.op && f.value !== undefined) {
          filters.push(`${f.field} ${f.op} '${f.value}'`)
        }
      }
    }

    // Add date filter
    if (spec.dateField && spec.datePeriod) {
      const period = String(spec.datePeriod).toLowerCase()
      const dateLiterals: Record<string, string> = {
        'today': 'TODAY', 'yesterday': 'YESTERDAY',
        'this week': 'THIS_WEEK', 'last week': 'LAST_WEEK',
        'this month': 'THIS_MONTH', 'last month': 'LAST_MONTH',
        'this quarter': 'THIS_QUARTER', 'last quarter': 'LAST_QUARTER',
        'this year': 'THIS_YEAR', 'last year': 'LAST_YEAR',
        'last 7 days': 'LAST_N_DAYS:7', 'last 30 days': 'LAST_N_DAYS:30',
        'last 90 days': 'LAST_N_DAYS:90',
      }
      const literal = dateLiterals[period]
      if (literal) {
        filters.push(`${spec.dateField} = ${literal}`)
      } else {
        // Absolute year: "2026" → CloseDate >= 2026-01-01 AND CloseDate <= 2026-12-31
        const yearMatch = period.match(/^(\d{4})$/)
        if (yearMatch) {
          const year = parseInt(yearMatch[1], 10)
          if (year >= 2000 && year <= 2100) {
            filters.push(`${spec.dateField} >= ${year}-01-01 AND ${spec.dateField} <= ${year}-12-31`)
          }
        } else {
          // Absolute month+year: "jan 2026"
          const MONTH_MAP: Record<string, number> = {
            january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3,
            april: 4, apr: 4, may: 5, june: 6, jun: 6,
            july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9,
            october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
          }
          const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
          const myMatch = period.match(/^(\w+)\s*[-–]?\s*(\d{4})$/)
          if (myMatch) {
            const month = MONTH_MAP[myMatch[1]]
            const year = parseInt(myMatch[2], 10)
            if (month && year) {
              const lastDay = month === 2 && (year % 4 === 0 && year % 100 !== 0 || year % 400 === 0) ? 29 : DAYS_IN_MONTH[month]
              filters.push(`${spec.dateField} >= ${year}-${String(month).padStart(2, '0')}-01 AND ${spec.dateField} <= ${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`)
            }
          }
        }
      }
    }

    // Add account filter
    if (spec.accountFilter) {
      filters.push(`Account.Name LIKE '%${spec.accountFilter}%'`)
    }

    if (filters.length > 0) {
      soqlQuery += ` WHERE ${filters.join(' AND ')}`
    }

    // Add GROUP BY
    if (spec.groupBy) {
      soqlQuery += ` GROUP BY ${spec.groupBy}`
    }

    // Add ORDER BY for aggregates
    if (spec.aggregate && spec.groupBy) {
      const aggFunc = spec.aggregate === 'count' ? 'COUNT(Id)' : `${String(spec.aggregate).toUpperCase()}(${selectFields.split(',')[0]})`
      soqlQuery += ` ORDER BY ${aggFunc} DESC`
    }

    // Add LIMIT — NEVER for aggregate queries (fetch all groups for accurate totals)
    if (!spec.aggregate && spec.limit) {
      soqlQuery += ` LIMIT ${spec.limit}`
    } else if (!spec.aggregate && !soqlQuery.match(/LIMIT/i)) {
      soqlQuery += ' LIMIT 200'
    }

    // Validate
    const validated = sanitizeSoql(soqlQuery)
    if (!validated) return null

    const result = await soql(validated)
    const body = formatResult(result)
    const context = `SALESFORCE LIVE CRM DATA (object: ${objectApi}, queried just now)\nSOQL: ${validated}\n\n${body}\n\n${SALESFORCE_ANSWER_NOTE}`
    return { context, citation: { documentName: 'Salesforce (live CRM)' } }
  } catch (err) {
    console.error('[salesforce] ad-hoc spec execution failed:', err)
    return null
  }
}
