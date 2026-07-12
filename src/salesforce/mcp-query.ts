// Answers Salesforce questions by giving an LLM direct access to Salesforce's own
// Platform MCP tools (soqlQuery, getObjectSchema, find/SOSL, etc.) in a ReAct-style
// reasoning loop, instead of routing through our 99 pre-built tools + Pinecone RAG.
//
// This is the "MCP mode" toggle — see SALESFORCE_USE_MCP in .env.local. When enabled,
// answerSalesforceQuery() in query.ts delegates entirely to this module.
import { chatJson } from '@/lib/ai/provider'
import { getMcpToolCatalogText, callMcpTool } from './mcp-client'
import { todayStr, currentYear } from './today'
import type { SalesforceResult, ChatTurn } from './query'

const MAX_STEPS = 8
const TODAY = todayStr()
const CURRENT_YEAR = currentYear()

const KNOWN_OBJECTS = `
Opportunity — sales deals / property-unit sales: pipeline, stages, amounts, close dates. Each Opportunity IS one unit sale/transaction.
  - Building_Name__c: the project/building name for THIS object (groupable in GROUP BY)
  - Building_Community__c: also exists on Opportunity but is LESS reliably populated and CANNOT be used in GROUP BY (Salesforce platform restriction on this object) — prefer Building_Name__c for Opportunity queries/grouping
  - Account.Name: the customer/buyer name (traverse via relationship, e.g. SELECT Account.Name FROM Opportunity)
  - cm_Sales_Person__r.Name: the salesperson
  - IsWon, IsClosed, StageName: deal status fields ("sales" = IsWon = true, unless asked about pipeline/lost/all)
Property_Inventory__c — the MASTER catalog of every physical unit/property (sold, available, rented) — ~17,000+ records.
  - Building_Community__c: THIS is the reliable, 100%-populated community/project field (52 distinct real values) — use THIS object+field for "list all communities" style questions, NOT Opportunity
  - Property_Status__c: Available/Sold/Booked/Blocked/Reserved/Leased
  - Selling_Price__c, Selling_Price_Per_Sq_Ft__c: pricing fields
Account — companies / customers / buyers.
Contact — individual people (usually linked to an Account).
Lead — unconverted prospects.
Task — activities: tasks, calls, meetings, to-dos.
Case — support / service cases.
`.trim()

async function buildSystemPrompt(): Promise<string> {
  const toolCatalog = await getMcpToolCatalogText()
  return `You are a CRM reasoning agent for Nshama, a Dubai real estate developer. Today's date is ${TODAY}. The current year is ${CURRENT_YEAR}.

You have DIRECT access to Salesforce's own live data tools (via Salesforce's official MCP server). Your job is to answer the user's question by calling these tools as needed, then composing a clear, natural-language answer.

AVAILABLE TOOLS:
${toolCatalog}

KNOWN OBJECTS AND FIELDS (use this instead of spending steps on getObjectSchema for these — it's already correct and tested):
${KNOWN_OBJECTS}

DATA QUALITY — ALWAYS EXCLUDE TEST/PLACEHOLDER RECORDS:
- Opportunity: Amount = 1, CloseDate = 2032-12-28, cm_Sales_Person__r.Name = 'Salesforce Admin' are test/dummy records — filter these out in your WHERE clause
- Account: names like "TestAccount", "Test Account", anything starting with "Test ", "Do not update or close...", "Contractor / Miscellaneous...", "Miscellaneous..." are placeholder/junk accounts, NOT real customers — exclude these from customer/account-facing answers (filter in SOQL with "AND Account.Name NOT LIKE 'Test%' AND Account.Name NOT LIKE 'Do not update%' AND Account.Name NOT LIKE '%Miscellaneous%' AND Account.Name NOT LIKE '%Contractor%'" when querying by Account, or filter them out of results before presenting)

SOQL GUIDANCE:
- Always include a WHERE clause and LIMIT to keep queries efficient
- For "how much/total" style questions, use COUNT(Id) and SUM(Amount) in one query
- For fuzzy name matching (project/community names the user typed casually), use LIKE '%name%' not exact =

RULES:
1. Think step-by-step — break complex questions into sub-tasks
2. Call ONE tool at a time, wait for the result, then decide the next step
3. Maximum ${MAX_STEPS} tool calls — be efficient. Prefer using the KNOWN OBJECTS info above over calling getObjectSchema when it already answers your question.
4. If a tool returns no data or an error, try a different query/approach before giving up
5. ALWAYS finish with a clear, natural-language answer — NEVER return raw JSON, raw SOQL result objects, or tool output verbatim as your final answer. If you're running low on steps, compose the best answer you can from what you have rather than dumping raw data.

CRITICAL — NEVER HALLUCINATE DATA:
- Reproduce ONLY the exact values returned by tools — names, counts, amounts, dates
- Do NOT add, invent, supplement, or "complete" any list with made-up entries
- If a tool returns 10 items, report exactly those 10 — never pad the list
- If a tool returns 0 items, say "No results found" — do not fabricate entries

RESPONSE FORMAT — respond with ONLY one JSON object per step:
{
  "thought": "What I'm reasoning about and why",
  "action": "<tool-name>" | "finish",
  "params": { "<param-name>": "<value>", ... },
  "answer": null | "If action is 'finish', compose the final answer here"
}

For "finish" action, the "answer" field MUST contain the final response to the user.
For tool actions, "params" must match the tool's inputSchema (e.g. soqlQuery needs {"q": "SELECT ..."}).`
}

export async function answerViaMcp(query: string, history?: ChatTurn[]): Promise<SalesforceResult | null> {
  const startTime = Date.now()
  try {
    const systemPrompt = await buildSystemPrompt()

    let context = ''
    if (history && history.length > 0) {
      const recent = history.slice(-6)
      context = recent.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content.slice(0, 300)}`).join('\n')
      context += '\n'
    }
    const fullQuestion = context ? `${context}User: ${query}` : query

    const steps: { thought: string; action: string; observation: string }[] = []
    let input = `Question: ${fullQuestion}\n\nReason about the first step to answer this question.`
    let finalAnswer: string | null = null

    for (let stepNum = 0; stepNum < MAX_STEPS; stepNum++) {
      const raw = await chatJson(systemPrompt, input)
      let decision: Record<string, unknown>
      try {
        decision = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>)
      } catch {
        console.warn(`[mcp-query] step ${stepNum}: failed to parse LLM response`)
        break
      }

      const thought = String(decision.thought || '')
      const action = String(decision.action || 'finish')
      const params = (decision.params as Record<string, unknown>) || {}
      const answer = decision.answer ? String(decision.answer) : null

      console.log(`[mcp-query] step ${stepNum}: action=${action} thought="${thought.slice(0, 100)}"`)

      if (action === 'finish' || answer) {
        finalAnswer = answer || 'No answer composed'
        steps.push({ thought, action, observation: finalAnswer })
        break
      }

      let observation: string
      try {
        const result = await callMcpTool(action, params)
        observation = result.isError ? `Tool error: ${result.content}` : result.content || 'No data returned'
      } catch (err) {
        observation = `Tool call failed: ${err instanceof Error ? err.message : String(err)}`
        console.warn(`[mcp-query] tool call failed:`, err)
      }

      steps.push({ thought, action, observation })
      input = `Question: ${fullQuestion}\n\nSteps so far:\n${steps.map((s, i) => `${i + 1}. Thought: ${s.thought}\n   Action: ${s.action}\n   Observation: ${s.observation.slice(0, 1500)}`).join('\n\n')}\n\nWhat should be the next step? If you have enough data, compose the final answer.`
    }

    if (!finalAnswer) {
      // Ran out of steps without an explicit "finish" — force one more LLM call to compose
      // a clean natural-language answer from what was gathered, instead of returning raw
      // tool output/JSON (which happened before this safety net was added).
      console.log('[mcp-query] max steps reached without finish — forcing final answer composition')
      const composePrompt = `Question: ${fullQuestion}\n\nSteps taken so far:\n${steps.map((s, i) => `${i + 1}. Thought: ${s.thought}\n   Action: ${s.action}\n   Observation: ${s.observation.slice(0, 1500)}`).join('\n\n')}\n\nYou've used all available tool calls. Compose the best possible natural-language answer using ONLY the data already gathered above. Do not call any more tools. Respond with ONLY JSON: {"answer": "<your natural language answer>"}`
      try {
        const raw = await chatJson(systemPrompt, composePrompt)
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
        finalAnswer = String((parsed as { answer?: string }).answer || '') || null
      } catch (err) {
        console.warn('[mcp-query] final answer composition failed:', err)
      }
      if (!finalAnswer) {
        finalAnswer = `I gathered some data but couldn't fully compose an answer to "${query}". Please try rephrasing or asking a more specific question.`
      }
    }

    console.log(`[mcp-query] completed in ${steps.length} steps (${Date.now() - startTime}ms)`)
    return { context: finalAnswer, citation: { documentName: 'Salesforce (live CRM via MCP)' } }
  } catch (err) {
    console.error('[mcp-query] failed:', err)
    return { context: `I encountered an error querying Salesforce via MCP: ${err instanceof Error ? err.message : String(err)}`, citation: { documentName: 'Salesforce (live CRM via MCP)' } }
  }
}
