// Query expansion — break complex questions into sub-queries for better retrieval.
// Handles: multi-part questions, comparison questions, and compound queries.

import { chatJson } from '@/lib/ai/provider'

const EXPANSION_PROMPT = `You are a query expansion engine for a CRM assistant.

Given a user question, determine if it should be broken into sub-queries.

Rules:
- Only expand if the question has 2+ distinct information needs
- Each sub-query should be answerable by a single tool/SQL query
- Don't expand simple questions (single topic)
- Don't expand follow-up questions (they reference prior context)

Examples of questions that SHOULD be expanded:
- "How many deals did we close this month AND what's the total revenue?" → ["How many deals did we close this month?", "What's the total revenue this month?"]
- "Compare sales in Town Square vs Address Grand Downtown" → ["Sales in Town Square", "Sales in Address Grand Downtown"]
- "What's our win rate and how many cancellations?" → ["What's our win rate?", "How many cancellations?"]
- "Show me deals by Muhammad Amir and Sidharth" → ["Deals by Muhammad Amir", "Deals by Sidharth Mishra"]

Examples of questions that should NOT be expanded:
- "How many deals did we close?" (single query)
- "Who is the top salesperson?" (single query)
- "Tell me about customer Al Futtaim" (single entity)
- "What's the pipeline?" (single topic)

Return JSON:
{
  "expand": true/false,
  "subQueries": ["sub-query 1", "sub-query 2", ...] (only if expand=true)
}

No markdown. Return ONLY valid JSON.`

export interface ExpansionResult {
  expand: boolean
  subQueries: string[]
}

export async function expandQuery(query: string): Promise<ExpansionResult> {
  // Quick heuristic: skip expansion for short queries
  if (query.split(/\s+/).length < 8) {
    return { expand: false, subQueries: [] }
  }

  // Skip expansion for follow-up patterns
  if (/^(and|also|what about|how about|plus|additionally)/i.test(query.trim())) {
    return { expand: false, subQueries: [] }
  }

  try {
    const raw = await chatJson(EXPANSION_PROMPT, query)
    const result = raw as Partial<ExpansionResult>

    if (result.expand && Array.isArray(result.subQueries) && result.subQueries.length >= 2) {
      console.log('[salesforce] query expanded into', result.subQueries.length, 'sub-queries')
      return { expand: true, subQueries: result.subQueries }
    }

    return { expand: false, subQueries: [] }
  } catch (err) {
    console.warn('[salesforce] query expansion failed:', err)
    return { expand: false, subQueries: [] }
  }
}
