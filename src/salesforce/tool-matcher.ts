import { TOOL_CATALOG, type ToolDefinition } from './tools'
import { validateToolMatch, type ValidatedToolMatch, ToolMatchSchema } from './schemas'
import { chatJsonStructured } from '@/lib/ai/structured'
import { todayStr, dateContext } from './today'

// Build the tool catalog description for the LLM
function buildToolCatalogText(): string {
  return TOOL_CATALOG.map(tool => {
    const params = tool.params.map(p =>
      `  - ${p.name} (${p.type}${p.required ? ', required' : ', optional'}): ${p.description}${p.examples ? ` Examples: ${p.examples.join(', ')}` : ''}`
    ).join('\n')
    return `${tool.name}: ${tool.description}\n${params}`
  }).join('\n\n')
}

const TOOL_MATCHER_PROMPT = `You are a CRM tool matcher. ${dateContext()} Given a user's question, pick the BEST pre-built tool to answer it. You must ALWAYS pick a tool — never ask for clarification. Pick the closest match even if it's not perfect.

Available tools:
${buildToolCatalogText()}

Rules:
1. Pick the ONE tool that best answers the question. ALWAYS pick one — never set tool to null.
2. Extract the required and optional parameters from the user's question.
3. For time periods:
   - Relative forms: "this month", "last month", "this quarter", "last quarter", "this year", "last year", "last 7 days", "last 30 days", "last 90 days".
   - Absolute years: "in 2026" → pass period as "2026". "in 2025" → "2025".
   - Absolute month+year: "in jan 2026" → pass period as "jan 2026". "january 2025" → "january 2025".
   - IMPORTANT: When user says "in 2026" or "for 2026", pass the bare year string "2026" as the period value.
4. For stage filters: "won" = Closed Won, "lost" = Closed Lost, "all" = all stages.
5. For "top N" queries, extract the number N as the "limit" parameter.
6. For case/support/service questions:
   - "types of cases" → get-case-breakdown-by-type
   - "open/closed cases" or "case status" → get-case-breakdown-by-status
   - "case priority" or "escalated" → get-case-breakdown-by-priority
   - "how many cases" → get-case-count
   - "cases by channel" or "phone/email cases" → get-case-breakdown-by-origin
   - "service categories" or "registration cases" or "transfer cases" → get-case-count-by-eservice
   - "contact centre cases" or "case classification" → get-case-count-by-record-type
7. For lead questions:
   - "how many leads" → get-leads-summary
   - "leads by source" → get-leads-by-source
   - "lead conversion rate" or "unconverted leads" → get-leads-conversion
8. For account/customer questions:
   - "how many customers" → get-accounts-summary
   - "top customers" or "revenue by customer" → get-sales-by-account
   - "customers with most transactions" or "repeat buyers" → get-top-customers-by-transaction
   - "individual vs corporate" or "customer type" → get-account-by-type
9. For task/activity questions:
   - "how many tasks" or "task count" → get-tasks-summary
   - "open tasks" or "pending tasks" → get-tasks-open
   - "overdue tasks" or "past due tasks" → get-tasks-overdue
   - "tasks by status" or "completed vs pending" → get-tasks-by-status
   - "tasks by owner" or "who has most tasks" → get-tasks-by-owner
   - "tasks by priority" or "high priority tasks" → get-tasks-by-priority
   - "tasks for customer X" → get-tasks-by-account
   - "tasks for case X" → get-tasks-by-case
10. For contact questions:
    - "contacts for customer X" → get-contact-by-account
    - "find contact" or "lookup contact" → get-contact-by-name
    - "how many contacts" → get-contacts-summary
11. For lead questions (enhanced):
    - "leads by status" or "lead pipeline" → get-lead-by-status
    - "leads for customer X" or "converted leads for" → get-lead-by-account
    - "find lead" or "lookup lead" → get-lead-by-name
10. For "average deal size" → get-avg-deal-value.
11. For "sales by bedroom" or "unit type breakdown" → get-sales-by-bedroom.
12. For "property inventory by community" → get-property-by-community.
13. For "inventory status" or "available/sold units" → get-property-status-breakdown.
14. For "how many villas/apartments" or "property type" → get-property-by-type.
15. For "average price" or "price per sq ft" → get-inventory-pricing.
16. For "monthly sales" or "sales by month" → get-sales-by-month.
17. For "win rate" or "won vs lost" → get-win-rate.
18. For "sales by source" or "referral performance" → get-sales-by-source.
19. For "mortgage status" or "how many mortgaged" → get-mortgage-status.
20. For "handover status" or "milestone status" → get-milestone-status.
21. For "sales by agency" → get-sales-by-agency.
22. For "sales by agent" (external broker) → get-sales-by-agent.
23. For "booking trend" or "bookings by month" → get-booking-trend.
24. For "cancellations by community" → get-cancellations-by-community.
25. For "compare years" or "year over year" or "2024 vs 2025" → compare-years.
26. For "cases for deal X" or "support tickets for deal" → get-cases-for-deal.
27. For "tasks for deal X" or "activities for deal" → get-tasks-for-deal.
28. For "payment details", "financial breakdown", "DLD fees", "deposit status" → get-deal-financials.
29. For "lead conversion time", "days to convert leads", "conversion rate by source" → get-lead-conversion-timeline.
30. For "deals with filter", "search deals in community", "find deals with bedroom" → get-deals-filtered.
31. For "advisor performance", "salesperson ranking", "best advisor", "leaderboard" → get-advisor-performance.
32. For "timeline for deal", "key dates", "booking to handover" → get-deal-timeline.
33. For "payment history for deal X", "receipts", "payments received" → get-payment-history.
34. For "mortgage for deal X", "financing details", "bank loan" → get-mortgage-details.
35. For "lease for deal X", "rental status", "tenant lease" → get-lease-status.
36. For "quote for deal X", "price quote", "how much quoted" → get-quote-details.
37. For "how long from booking to close", "deal cycle time", "average time to close" → get-booking-to-close.
38. For "related deals", "linked deals", "old opportunity", "new opportunity", "deal linked to" → get-related-deals.
39. For "project details", "building info", "what projects", "project list", "developments" → get-project-details.
40. For "deal unit details", "unit attributes", "deal parking", "deal areas", "property for deal" → get-deal-property-details.
41. NEVER ask for clarification — always try to answer with the best available tool.

Respond with ONLY JSON:
{
  "tool": "<tool name>",
  "confidence": "high" | "medium" | "low",
  "params": { "<param name>": "<value>" },
  "clarify": null
}
No markdown.`

export interface ToolMatch {
  tool: string | null
  confidence: 'high' | 'medium' | 'low'
  params: Record<string, string | number | boolean>
  clarify: string | null
}

export async function matchTool(query: string): Promise<ToolMatch> {
  // Guard: empty/whitespace-only queries
  if (!query || !query.trim()) {
    return { tool: null, confidence: 'low', params: {}, clarify: null }
  }

  try {
    // Try structured output with Zod validation
    try {
      const validated = await chatJsonStructured<ValidatedToolMatch>(
        TOOL_MATCHER_PROMPT,
        query,
        { schema: ToolMatchSchema, name: 'ToolMatch' },
      )
      return {
        tool: validated.tool && TOOL_CATALOG.some(t => t.name === validated.tool) ? validated.tool : null,
        confidence: validated.confidence,
        params: (validated.params || {}) as Record<string, string | number | boolean>,
        clarify: validated.clarify || null,
      }
    } catch (structErr) {
      console.warn('[salesforce] Structured output failed, falling back to raw chatJson:', structErr)
    }

    // Fallback: raw chatJson + manual validation
    const { chatJson } = await import('@/lib/ai/provider')
    const raw = await chatJson(TOOL_MATCHER_PROMPT, query)
    const validated = validateToolMatch(raw)
    if (validated) {
      return {
        tool: validated.tool && TOOL_CATALOG.some(t => t.name === validated.tool) ? validated.tool : null,
        confidence: validated.confidence,
        params: (validated.params || {}) as Record<string, string | number | boolean>,
        clarify: validated.clarify || null,
      }
    }

    // Last resort: raw parse
    console.warn('[salesforce] Zod validation failed, falling back to raw parse')
    try {
      const parsed = JSON.parse(raw) as Partial<ToolMatch>
      return {
        tool: parsed.tool && TOOL_CATALOG.some(t => t.name === parsed.tool) ? parsed.tool : null,
        confidence: parsed.confidence || 'low',
        params: parsed.params || {},
        clarify: parsed.clarify || null,
      }
    } catch {
      // LLM returned non-JSON text (e.g. role hijack response) — no tool match
      console.warn('[salesforce] Raw parse failed — LLM returned non-JSON response')
      return { tool: null, confidence: 'low', params: {}, clarify: null }
    }
  } catch (err) {
    console.error('[salesforce] tool matching failed:', err)
    return { tool: null, confidence: 'low', params: {}, clarify: null }
  }
}
