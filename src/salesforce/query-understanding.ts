// Query Understanding — LLM "thinking" layer that processes raw user input
// before routing. Corrects grammar, understands intent, extracts parameters,
// resolves references from conversation history.

import { chatJson } from '@/lib/ai/provider'
import { todayStr, currentYear } from './today'
import { soql } from './client'

export interface UnderstoodQuery {
  // The corrected, clear version of what the user is asking
  clarified: string
  // Primary intent category
  intent: 'sales_summary' | 'comparison' | 'lookup' | 'ranking' | 'breakdown' | 'trend' | 'count' | 'list' | 'financial' | 'meta' | 'off_topic'
  // Extracted time parameters
  dateRange?: { start: string; end: string }
  // Extracted entity references (project, customer, salesperson, etc.)
  entities: { type: string; value: string }[]
  // Key metrics requested
  metrics: string[]
  // Grouping/dimension requested
  groupBy?: string
  // Confidence that we understood correctly
  confidence: 'high' | 'medium' | 'low'
  // If the query needs conversation context to be answerable
  needsContext: boolean
  // If needsContext=true, what specifically is missing
  missingContext?: string
}

const TODAY = todayStr()
const CURRENT_YEAR = currentYear()

// Live-fetched, cached list of real project/community/building names — replaces a
// hand-maintained hardcoded list that went stale (missing real communities like
// "Address Grand Downtown", which caused the LLM to mis-parse or drop them as it had no
// anchor telling it these were real project names). Cached for 1 hour since this rarely
// changes and a live SOQL call on every single question would add unnecessary latency.
let knownProjectsCache: { names: string[]; fetchedAt: number } | null = null
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

async function getKnownProjectsList(): Promise<string> {
  const now = Date.now()
  if (knownProjectsCache && now - knownProjectsCache.fetchedAt < CACHE_TTL_MS) {
    return knownProjectsCache.names.join(', ')
  }

  try {
    const [communities, buildings] = await Promise.all([
      soql(`SELECT Building_Community__c FROM Property_Inventory__c WHERE Building_Community__c != null GROUP BY Building_Community__c`),
      soql(`SELECT Building_Name__c FROM Opportunity WHERE Building_Name__c != null AND Building_Name__c NOT IN ('Master Community', 'All Buildings') GROUP BY Building_Name__c`),
    ])
    const names = new Set<string>()
    for (const r of communities.records) {
      const v = (r as Record<string, unknown>).Building_Community__c
      if (typeof v === 'string') names.add(v)
    }
    for (const r of buildings.records) {
      const v = (r as Record<string, unknown>).Building_Name__c
      if (typeof v === 'string') names.add(v)
    }
    knownProjectsCache = { names: Array.from(names), fetchedAt: now }
    return knownProjectsCache.names.join(', ')
  } catch (err) {
    console.warn('[query-understand] failed to fetch live project list, using stale/empty cache:', err)
    return knownProjectsCache?.names.join(', ') ?? ''
  }
}

function buildQueryUnderstandingPrompt(knownProjects: string): string {
  return `You are a CRM query understanding engine for Nshama, a Dubai real estate developer. Today's date is ${TODAY}. The current year is ${CURRENT_YEAR}.

Your job: Take a raw user question (possibly with typos, grammar errors, vague references, or conversation context) and produce a CLEAR, STRUCTURED understanding of what the user wants.

KNOWN PROJECTS/COMMUNITIES/BUILDINGS at Nshama (live list from Salesforce — this is the authoritative source, not exhaustive naming conventions):
${knownProjects || '(list unavailable — infer from context)'}

RULES:
1. CORRECT typos: "cmpare" → "compare", "20205" → "2025", "sellign" → "selling"
2. UNDERSTAND intent: What is the user really asking for?
3. EXTRACT entities: project names, customer names, dates, salesperson names. A multi-word capitalized phrase (e.g. "Address Grand Downtown") is very likely a full project/community name — extract it as ONE entity, don't split off words like "Address" as unrelated.
4. RESOLVE vague references from conversation history: "this project" → actual project name, "them" → actual entities
5. INFER year: "this year" → ${CURRENT_YEAR}, "last year" → ${CURRENT_YEAR - 1}, "this month" → current month
6. If user explicitly says "2024 and 2025", KEEP those years — don't add 2026
7. If user says "sales this year" → infer ${CURRENT_YEAR}
8. For follow-ups: use conversation history to understand what "it", "them", "that", "this" refers to

INTENT CATEGORIES:
- sales_summary: "how many sales", "total revenue", "sales count"
- comparison: "compare X vs Y", "2024 vs 2025", "which is better"
- lookup: "tell me about customer X", "what units did X buy", "details of deal Y"
- ranking: "top 10 customers", "best salesperson", "most sales"
- breakdown: "sales by community", "breakdown by type", "bedroom wise data"
- trend: "monthly trend", "sales over time", "how have sales changed"
- count: "how many cases", "count of leads", "total tasks"
- list: "list all deals", "show me lost deals", "recent cancellations"
- financial: "deal financials", "payment status", "mortgage details"
- meta: "what data do you have", "what can you tell me"
- off_topic: questions not related to CRM/sales (weather, jokes, etc.)

Respond with ONLY JSON:
{
  "clarified": "<corrected, clear version of the question>",
  "intent": "<intent category>",
  "dateRange": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" } or null,
  "entities": [{ "type": "project|customer|salesperson|building|community|bedroom", "value": "actual name" }],
  "metrics": ["revenue", "count", "amount", etc.],
  "groupBy": "community|project|bedroom|month|quarter|salesperson|channel|type" or null,
  "confidence": "high|medium|low",
  "needsContext": false,
  "missingContext": null
}`
}

/**
 * Understand a raw user query — corrects grammar, extracts intent, resolves references.
 * This is the "thinking" step before routing to tools.
 */
export async function understandQuery(
  rawQuery: string,
  history?: { role: 'user' | 'assistant'; content: string }[]
): Promise<UnderstoodQuery> {
  // Build the input with optional conversation context
  let input = ''
  if (history && history.length > 0) {
    const recent = history.slice(-6) // Last 3 turns
    input = recent.map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content.slice(0, 500)}`).join('\n')
    input += `\nUser: ${rawQuery}`
  } else {
    input = `User: ${rawQuery}`
  }

  try {
    const knownProjects = await getKnownProjectsList()
    const raw = await chatJson(buildQueryUnderstandingPrompt(knownProjects), input)

    // Parse — chatJson returns string, parse it
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw

    const result: UnderstoodQuery = {
      clarified: parsed.clarified || rawQuery,
      intent: parsed.intent || 'sales_summary',
      dateRange: parsed.dateRange || undefined,
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      metrics: Array.isArray(parsed.metrics) ? parsed.metrics : [],
      groupBy: parsed.groupBy || undefined,
      confidence: parsed.confidence || 'medium',
      needsContext: parsed.needsContext || false,
      missingContext: parsed.missingContext || undefined,
    }

    console.log(`[query-understand] intent=${result.intent} confidence=${result.confidence} clarified="${result.clarified}" entities=${result.entities.length} groupBy=${result.groupBy ?? 'none'}`)
    return result

  } catch (err) {
    console.warn('[query-understand] LLM failed, returning raw query:', err)
    return {
      clarified: rawQuery,
      intent: 'sales_summary',
      entities: [],
      metrics: [],
      confidence: 'low',
      needsContext: false,
    }
  }
}

/**
 * Quick heuristic understanding — no LLM call, just regex-based.
 * Used as a fast path for obviously clear queries.
 */
export function quickUnderstand(query: string): UnderstoodQuery {
  const q = query.toLowerCase().trim()

  // Off-topic detection
  if (/\b(weather|joke|news|football|movie|music|recipe|hello|hi|hey)\b/i.test(q)) {
    return { clarified: query, intent: 'off_topic', entities: [], metrics: [], confidence: 'high', needsContext: false }
  }

  // Meta questions
  if (/\b(what (all )?(data|information|objects|fields|can you))\b/i.test(q)) {
    return { clarified: query, intent: 'meta', entities: [], metrics: [], confidence: 'high', needsContext: false }
  }

  // Comparison
  if (/\b(compare|vs|versus|compared to|against)\b/i.test(q)) {
    return { clarified: query, intent: 'comparison', entities: [], metrics: [], confidence: 'medium', needsContext: false }
  }

  // Ranking
  if (/\b(top \d+|highest|best|most|largest|biggest|leading)\b/i.test(q)) {
    return { clarified: query, intent: 'ranking', entities: [], metrics: [], confidence: 'medium', needsContext: false }
  }

  // Breakdown
  if (/\b(breakdown|by (community|project|bedroom|type|channel|month|quarter|year|salesperson|agent))\b/i.test(q)) {
    return { clarified: query, intent: 'breakdown', entities: [], metrics: [], confidence: 'medium', needsContext: false }
  }

  // Trend
  if (/\b(trend|over time|change|growth|evolution)\b/i.test(q)) {
    return { clarified: query, intent: 'trend', entities: [], metrics: [], confidence: 'medium', needsContext: false }
  }

  // Count
  if (/\b(how many|count|total number)\b/i.test(q)) {
    return { clarified: query, intent: 'count', entities: [], metrics: [], confidence: 'medium', needsContext: false }
  }

  // List
  if (/\b(list|show|show me|display|give me)\b/i.test(q)) {
    return { clarified: query, intent: 'list', entities: [], metrics: [], confidence: 'medium', needsContext: false }
  }

  // Vague follow-up — needs context
  if (/^(yes|no|ok|and|what about|how about|and the|and those|them|it|that|those|these)\b/i.test(q)) {
    return { clarified: query, intent: 'sales_summary', entities: [], metrics: [], confidence: 'low', needsContext: true, missingContext: 'This is a follow-up question that needs conversation history to understand.' }
  }

  return { clarified: query, intent: 'sales_summary', entities: [], metrics: [], confidence: 'medium', needsContext: false }
}
