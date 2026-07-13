// Answers Salesforce questions by giving an LLM direct access to Salesforce's own
// Platform MCP tools (soqlQuery, getObjectSchema, find/SOSL, etc.) in a ReAct-style
// reasoning loop, instead of routing through our 99 pre-built tools + Pinecone RAG.
//
// This is the "MCP mode" toggle — see SALESFORCE_USE_MCP in .env.local. When enabled,
// answerSalesforceQuery() in query.ts delegates entirely to this module.
//
// STREAMING: Every action (intent classification, skill loading, MCP calls, verification)
// is streamed to the UI via the onStep callback, so users see the full reasoning process.
import { chatJson } from '@/lib/ai/provider'
import { getMcpToolCatalogText, callMcpTool } from './mcp-client'
import { todayStr, currentYear } from './today'
import { getBusinessGlossaryText } from './business-glossary'
import { getSkillFilesPromptText, classifyQueryIntent } from './skill-files'
import type { SalesforceResult, ChatTurn } from './query'

const MAX_STEPS = 8
const TODAY = todayStr()
const CURRENT_YEAR = currentYear()

// Object-level cheat sheet for query mechanics (GROUP BY restrictions, relationship
// traversal syntax) — distinct from the business glossary below, which covers WHAT the
// fields/terms MEAN, not SOQL syntax quirks.
const SOQL_MECHANICS = `
Opportunity — sales deals / property-unit sales. Each Opportunity IS one unit sale/transaction.
  - Building_Name__c is groupable in GROUP BY; Building_Community__c on THIS object is NOT (Salesforce platform restriction) — use Building_Name__c for Opportunity-side grouping
  - Traverse to customer via Account.Name, to salesperson via cm_Sales_Person__r.Name
Property_Inventory__c — the MASTER catalog of every physical unit/property (sold, available, rented).
  - Building_Community__c IS groupable here (100%-populated, 52 distinct real values) — use THIS object+field for "list all communities"

OWNER/CUSTOMER LOOKUP (CRITICAL — read this before answering any "who owns" / "who bought" / "customer" question):
  - Owner/Buyer data lives on Account, linked via Opportunity.Account
  - Property_Inventory__c is ONLY the property catalog — it has NO owner/customer fields
  - To find who owns/bought a specific unit, query Opportunity (NOT Property_Inventory__c):
    SELECT Name, Account.Name, Account.Phone, Account.Email__c, Amount, CloseDate, Status__c
    FROM Opportunity
    WHERE Building_Name__c LIKE '%<project>%' AND Name LIKE '%<unit>%' AND IsWon = true
  - The Account.Name field = the owner/buyer name. Account.Phone/Email = their contact info.
  - If the unit name doesn't match in Opportunity.Name, try Property_Inventory__c.Name or Unit_Details__c
`.trim()

async function buildSystemPrompt(query?: string): Promise<{ prompt: string; loadedSkills: string[]; intentCategories: string[] }> {
  const toolCatalog = await getMcpToolCatalogText()
  const glossary = await getBusinessGlossaryText(['Account', 'Opportunity', 'Property_Inventory__c', 'Case'])

  // Conditional skill loading — only load matching skill files for this query
  const skillResult = await getSkillFilesPromptText(query)
  const intentCategories = query ? classifyQueryIntent(query) : []

  const prompt = `You are a CRM reasoning agent for Nshama, a Dubai real estate developer. Today's date is ${TODAY}. The current year is ${CURRENT_YEAR}.

You have DIRECT access to Salesforce's own live data tools (via Salesforce's official MCP server). Your job is to answer the user's question by calling these tools as needed, then composing a clear, natural-language answer.

AVAILABLE TOOLS:
${toolCatalog}

SOQL MECHANICS (query-construction rules, tested and correct — use instead of spending steps on getObjectSchema for these):
${SOQL_MECHANICS}

${glossary}
${skillResult.text}

DATA QUALITY — ALWAYS EXCLUDE TEST/PLACEHOLDER RECORDS:
- Opportunity: Amount = 1, CloseDate = 2032-12-28, cm_Sales_Person__r.Name = 'Salesforce Admin' are test/dummy records — filter these out in your WHERE clause
- Account: names like "TestAccount", "Test Account", anything starting with "Test ", "Do not update or close...", "Contractor / Miscellaneous...", "Miscellaneous..." are placeholder/junk accounts, NOT real customers — exclude these from customer/account-facing answers (filter in SOQL with "AND Account.Name NOT LIKE 'Test%' AND Account.Name NOT LIKE 'Do not update%' AND Account.Name NOT LIKE '%Miscellaneous%' AND Account.Name NOT LIKE '%Contractor%'" when querying by Account, or filter them out of results before presenting)

SOQL GUIDANCE:
- Always include a WHERE clause and LIMIT to keep queries efficient
- For "how much/total" style questions, use COUNT(Id) and SUM(Amount) in one query
- For fuzzy name matching (project/community/unit codes the user typed casually), use LIKE '%name%' not exact =

RULES:
1. Think step-by-step — break complex questions into sub-tasks
2. Call ONE tool at a time, wait for the result, then decide the next step
3. Maximum ${MAX_STEPS} tool calls — be efficient. Prefer the SOQL MECHANICS and BUSINESS TERMINOLOGY above over calling getObjectSchema when they already answer your question.
4. If a tool returns no data, TRY THE BUSINESS TERMINOLOGY MAPPING ABOVE FIRST before giving up — e.g. if searching for a unit code in Property_Inventory__c returns nothing, try Opportunity.Name instead (per the "Unit / Property code" glossary entry above) before telling the user it doesn't exist.
   - For owner/customer questions: if Property_Inventory__c has no owner data (it never does), switch to Opportunity WHERE Building_Name__c LIKE '%X%' AND Name LIKE '%Y%' AND IsWon = true, then get Account.Name
   - If a query returns aggregate stats instead of individual records, add a specific WHERE filter to get row-level data
5. ALWAYS finish with a clear, natural-language answer — NEVER return raw JSON, raw SOQL result objects, or tool output verbatim as your final answer. If you're running low on steps, compose the best answer you can from what you have rather than dumping raw data.
6. If the question asks about something genuinely NOT in Salesforce (e.g. a company's industry/website/background — see the glossary entry on this), say so plainly in your answer and set "foundInCrm": false so the system can offer other sources. Do NOT cite Salesforce as your source when you found nothing relevant.

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
  "answer": null | "If action is 'finish', compose the final answer here",
  "foundInCrm": true | false
}

For "finish" action, the "answer" field MUST contain the final response to the user, and "foundInCrm" MUST be true if you found real, relevant Salesforce data, or false if the CRM genuinely has nothing relevant to this question (not just "the exact search term didn't match" — try alternate lookups per the glossary before concluding this).
For tool actions, "params" must match the tool's inputSchema (e.g. soqlQuery needs {"q": "SELECT ..."}).`

  return { prompt, loadedSkills: skillResult.loadedFiles, intentCategories }
}

export interface McpStepInfo {
  action: string
  detail: string // the SOQL query (for soqlQuery), SOSL (for find), or params summary for other tools
}

export interface McpAnswerResult extends SalesforceResult {
  foundInCrm: boolean
  /** Raw SOQL/SOSL observations from MCP tool calls — used by verifier to check
   *  whether the composed prose actually matches the data retrieved. */
  rawObservations: string
}

export async function answerViaMcp(
  query: string,
  history?: ChatTurn[],
  onStep?: (step: McpStepInfo) => void
): Promise<McpAnswerResult | null> {
  const startTime = Date.now()

  // Stream: classify intent
  const intents = classifyQueryIntent(query)
  if (intents.length > 0) {
    onStep?.({ action: 'classifyIntent', detail: `Detected intent: ${intents.join(', ')}` })
  }

  try {
    // Build system prompt with conditional skill loading
    const { prompt: systemPrompt, loadedSkills, intentCategories } = await buildSystemPrompt(query)

    // Stream: loaded skills
    if (loadedSkills.length > 0) {
      onStep?.({ action: 'loadSkills', detail: `Loaded ${loadedSkills.length} skill file(s): ${loadedSkills.join(', ')}` })
    }
    if (intentCategories.length > 0) {
      onStep?.({ action: 'classifyIntent', detail: `Matched categories: ${intentCategories.join(', ')}` })
    }

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
    let foundInCrm = true // default optimistic — only set false when the LLM explicitly says so

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
        if (typeof decision.foundInCrm === 'boolean') foundInCrm = decision.foundInCrm
        steps.push({ thought, action, observation: finalAnswer })

        // Stream: composing answer
        onStep?.({ action: 'composeAnswer', detail: 'Composing final answer...' })
        break
      }

      // Surface the exact tool call (and SOQL/SOSL text if present) to the caller so it can
      // be shown in the UI's "thinking process" — this is what makes MCP's reasoning
      // transparent/auditable instead of a black box.
      const detail = typeof params.q === 'string' ? params.q : JSON.stringify(params)
      onStep?.({ action, detail })

      let observation: string
      try {
        const result = await callMcpTool(action, params)
        observation = result.isError ? `Tool error: ${result.content}` : result.content || 'No data returned'
      } catch (err) {
        observation = `Tool call failed: ${err instanceof Error ? err.message : String(err)}`
        console.warn(`[mcp-query] tool call failed:`, err)
      }

      steps.push({ thought, action, observation })
      input = `Question: ${fullQuestion}\n\nSteps so far:\n${steps.map((s, i) => `${i + 1}. Thought: ${s.thought}\n   Action: ${s.action}\n   Observation: ${s.observation}`).join('\n\n')}\n\nWhat should be the next step? If you have enough data, compose the final answer.`
    }

    if (!finalAnswer) {
      // Ran out of steps without an explicit "finish" — force one more LLM call to compose
      // a clean natural-language answer from what was gathered, instead of returning raw
      // tool output/JSON (which happened before this safety net was added).
      console.log('[mcp-query] max steps reached without finish — forcing final answer composition')
      onStep?.({ action: 'composeAnswer', detail: 'Forcing answer composition (max steps reached)...' })
      const composePrompt = `Question: ${fullQuestion}\n\nSteps taken so far:\n${steps.map((s, i) => `${i + 1}. Thought: ${s.thought}\n   Action: ${s.action}\n   Observation: ${s.observation}`).join('\n\n')}\n\nYou've used all available tool calls. Compose the best possible natural-language answer using ONLY the data already gathered above. Do not call any more tools. Respond with ONLY JSON: {"answer": "<your natural language answer>", "foundInCrm": true|false}`
      try {
        const raw = await chatJson(systemPrompt, composePrompt)
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
        finalAnswer = String((parsed as { answer?: string }).answer || '') || null
        if (typeof (parsed as { foundInCrm?: boolean }).foundInCrm === 'boolean') {
          foundInCrm = (parsed as { foundInCrm: boolean }).foundInCrm
        }
      } catch (err) {
        console.warn('[mcp-query] final answer composition failed:', err)
      }
      if (!finalAnswer) {
        finalAnswer = `I gathered some data but couldn't fully compose an answer to "${query}". Please try rephrasing or asking a more specific question.`
        foundInCrm = false
      }
    }

    const rawObservations = steps.map(s => s.observation).join('\n\n')
    console.log(`[mcp-query] completed in ${steps.length} steps (${Date.now() - startTime}ms), foundInCrm=${foundInCrm}`)
    return { context: finalAnswer, citation: { documentName: 'Salesforce (live CRM via MCP)' }, foundInCrm, rawObservations }
  } catch (err) {
    console.error('[mcp-query] failed:', err)
    return { context: `I encountered an error querying Salesforce via MCP: ${err instanceof Error ? err.message : String(err)}`, citation: { documentName: 'Salesforce (live CRM via MCP)' }, foundInCrm: false, rawObservations: '' }
  }
}
