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
import { buildMetadataGraph, findPaths, type RelationshipField } from './metadata-graph'
import type { SalesforceResult, ChatTurn } from './query'

const MAX_STEPS = 8
const TODAY = todayStr()
const CURRENT_YEAR = currentYear()

// Key objects for relationship graph — these are the main objects the LLM queries.
const GRAPH_OBJECTS = ['Case', 'Opportunity', 'Property_Inventory__c', 'Account', 'Contact', 'Case_Units__c', 'Opportunity_Property__c']

// Module-level graph cache — rebuilt when MCP session expires.
let metadataGraph: Map<string, RelationshipField[]> | null = null

/** Object name aliases for detecting query context (lowercase). */
const OBJECT_ALIASES: Record<string, string[]> = {
  Case: ['case', 'cases', 'service request', 'complaint', 'violation', 'ticket', 'enquiry', 'inquiry'],
  Opportunity: ['opportunity', 'opportunities', 'deal', 'deals', 'sale', 'sales', 'sold', 'booking'],
  Property_Inventory__c: ['property', 'unit', 'units', 'inventory', 'community', 'communities', 'building', 'villa', 'apartment', 'townhouse'],
  Account: ['account', 'accounts', 'customer', 'customers', 'client', 'clients', 'owner', 'owners'],
  Contact: ['contact', 'contacts'],
  Case_Units__c: ['case unit', 'case units'],
  Opportunity_Property__c: ['opportunity property', 'opportunity properties'],
}

/** Detect which objects the query is likely about. */
function detectQueryObjects(query: string): string[] {
  const q = query.toLowerCase()
  const detected: string[] = []
  for (const [obj, aliases] of Object.entries(OBJECT_ALIASES)) {
    if (aliases.some((a) => q.includes(a))) detected.push(obj)
  }
  // If no specific object detected, include common ones
  if (detected.length === 0) detected.push('Opportunity', 'Property_Inventory__c', 'Account')
  return detected
}

/** Build relationship paths text for the prompt, based on query context. */
function buildRelationshipPathsText(query: string): string {
  if (!metadataGraph) return ''

  const detectedObjects = detectQueryObjects(query)
  const sections: string[] = []

  // Relationship paths — guides navigation between objects
  const targets = ['Property_Inventory__c', 'Opportunity', 'Account']
  const pathLines: string[] = ['\n[OBJECT RELATIONSHIPS — AUTO-DISCOVERED]\nWhen navigating between objects, use these pre-discovered paths:']
  let pathCount = 0

  for (const fromObj of detectedObjects) {
    for (const toObj of targets) {
      if (fromObj === toObj) continue
      const paths = findPaths(metadataGraph, fromObj, toObj)
      if (paths.length === 0) continue

      pathLines.push(`\n${fromObj} → ${toObj}:`)
      paths.slice(0, 2).forEach((path, idx) => {
        const label = idx === 0 ? 'RECOMMENDED' : `alternative ${idx + 1}`
        const joinParts = path.steps.map((s) => `${s.viaField} → ${s.to}`)
        pathLines.push(`  ${idx + 1}. (${label}) ${joinParts.join(' → ')}`)
        pathCount++
      })
    }
  }

  if (pathCount > 0) {
    pathLines.push('\nWhen the primary path returns empty results, ALWAYS try the next path before giving up.')
    pathLines.push('When relationship paths conflict with business rules, prefer relationship paths for object traversal.')
    sections.push(pathLines.join('\n'))
  }

  return sections.join('\n')
}

/**
 * Flatten nested objects in a JSON string so the LLM doesn't have to parse nested JSON.
 * e.g. {"Account":{"Name":"John"}} → {"Account.Name":"John"}
 * e.g. [{"Account":{"Name":"John"},"Name":"OPP-001"}] → [{"Account.Name":"John","Name":"OPP-001"}]
 */
function flattenNestedJson(json: string): string {
  try {
    const parsed = JSON.parse(json)
    const flatten = (obj: Record<string, unknown>): Record<string, unknown> => {
      const result: Record<string, unknown> = {}
      for (const [key, val] of Object.entries(obj)) {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          const nested = flatten(val as Record<string, unknown>)
          for (const [nk, nv] of Object.entries(nested)) {
            result[`${key}.${nk}`] = nv
          }
        } else {
          result[key] = val
        }
      }
      return result
    }
    if (Array.isArray(parsed)) {
      return JSON.stringify(parsed.map(item => typeof item === 'object' && item !== null ? flatten(item) : item), null, 2)
    }
    if (typeof parsed === 'object' && parsed !== null) {
      return JSON.stringify(flatten(parsed), null, 2)
    }
    return json
  } catch {
    return json
  }
}

// Object-level cheat sheet for query mechanics (GROUP BY restrictions, relationship
// traversal syntax) — distinct from the business glossary below, which covers WHAT the
// fields/terms MEAN, not SOQL syntax quirks.
const SOQL_MECHANICS = `
Opportunity — sales deals / property-unit sales. Each Opportunity IS one unit sale/transaction.
  - Building_Name__c is groupable in GROUP BY; Building_Community__c on THIS object is NOT (Salesforce platform restriction) — use Building_Name__c for Opportunity-side grouping
  - Traverse to customer via Account.Name, to salesperson via cm_Sales_Person__r.Name
Property_Inventory__c — the MASTER catalog of every physical unit/property (sold, available, rented).
  - Building_Community__c IS groupable here (100%-populated, 52 distinct real values) — use THIS object+field for "list all communities"

Case — service requests, complaints, violations. Links to units through:
  - Case_Units__c junction (RECOMMENDED): links Case to Property_Inventory__c via Property_Inventory__c field — ALWAYS try this first
  - Case.Unit__c — TEXT field (may be stale/wrong; only use as last resort if Case_Units__c returns nothing)
  - Case.Opportunity_Name__c — LOOKUP to Opportunity (fallback path via Opportunity → Opportunity_Property__c)
  - To get unit details for a case: query Case_Units__c WHERE Case__c = '<case_id>' → get Property_Inventory__r.Name, Property_Inventory__r.Building_Community__c, etc.
  - Key Case fields: eService_Name_Formula__c (case type), Origin, Status, CaseNumber, AccountId, ContactId, ParentId
  - DLP sub-category fields ON Case (do NOT query separate objects — they don't exist):
    Civil_Sub_Category__c, Carpentry_Sub_category__c, Painting_Sub_Category__c,
    Mechanical_Sub_category__c, Electrical_Sub_Category__c, Plumbing_Sub_Category__c
  - To find DLP cases: WHERE Subject LIKE '%DLP%' AND <SubCategoryField> != null
  - To find DLP cases with electrical issues: WHERE Subject LIKE '%DLP%' AND Electrical_Sub_Category__c != null
  - Other Case fields: Violation_Incident_Date__c, Violation_Category__c, Violation_Amount__c, Case_Code__c, Call_Purpose__c, Preferred_Visit_Date__c

OWNER/CUSTOMER LOOKUP (CRITICAL — read this before answering any "who owns" / "who bought" / "customer" question):
  - Owner/Buyer data lives on Account, linked via Opportunity.Account
  - Property_Inventory__c is ONLY the property catalog — it has NO owner/customer fields
  - To find who owns/bought a specific unit, query Opportunity (NOT Property_Inventory__c):
    SELECT Name, Account.Name, Account.Phone, Account.Email__c, Amount, CloseDate, Milestone_Current_Status__c
    FROM Opportunity
    WHERE Building_Name__c LIKE '%<project>%' AND Name LIKE '%<unit>%' AND IsWon = true
  - The Account.Name field = the owner/buyer name. Account.Phone/Email = their contact info.
  - If the unit name doesn't match in Opportunity.Name, try Property_Inventory__c.Name or Unit_Details__c

FUZZY SEARCH (CRITICAL — when user-provided unit code doesn't match exactly):
  - Users often mistype prefixes (e.g. "SAF" when unit is in "HYT"/Hayat)
  - Step 1: Extract the CORE unit code from what the user typed. E.g. from "TS SAF TH-V-6", extract "TH-V-6"
  - Step 2: Search with just the core: WHERE Name LIKE '%TH-V-6%' AND IsWon=true
  - Step 3: If still nothing, use the find tool (SOSL) with searchTerm="TH-V-6"
  - NEVER give up after one failed SOQL — try at least 2 search strategies before saying "not found"
`.trim()

async function buildSystemPrompt(query?: string): Promise<{ prompt: string; loadedSkills: string[]; intentCategories: string[] }> {
  const toolCatalog = await getMcpToolCatalogText()
  const glossary = await getBusinessGlossaryText(['Account', 'Opportunity', 'Property_Inventory__c', 'Case'])

  // Conditional skill loading — only load matching skill files for this query
  const skillResult = await getSkillFilesPromptText(query)
  const intentCategories = query ? classifyQueryIntent(query) : []

  // Build metadata graph (cached) and generate relationship paths for this query
  if (!metadataGraph) {
    try {
      metadataGraph = await buildMetadataGraph(GRAPH_OBJECTS)
    } catch (err) {
      console.warn('[mcp-query] Failed to build metadata graph:', err)
    }
  }
  const relationshipPaths = query ? buildRelationshipPathsText(query) : ''

  const prompt = `You are a CRM reasoning agent for Nshama, a Dubai real estate developer. Today's date is ${TODAY}. The current year is ${CURRENT_YEAR}.

You have DIRECT access to Salesforce's own live data tools (via Salesforce's official MCP server). Your job is to answer the user's question by calling these tools as needed, then composing a clear, natural-language answer.

AVAILABLE TOOLS:
${toolCatalog}

SOQL MECHANICS (query-construction rules, tested and correct — use instead of spending steps on getObjectSchema for these):
${SOQL_MECHANICS}

${glossary}
${skillResult.text}
${relationshipPaths ? '\n' + relationshipPaths + '\n' : ''}

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
4. If a tool returns no data, TRY THE FUZZY SEARCH STRATEGY ABOVE FIRST before giving up:
   - For unit code searches: extract the core code (e.g. "TH-V-6" from "TS SAF TH-V-6") and search with LIKE '%TH-V-6%'
   - If SOQL LIKE fails, use the find tool (SOSL) with the core code as searchTerm
   - For owner/customer questions: if Property_Inventory__c has no owner data (it never does), switch to Opportunity WHERE Name LIKE '%<core code>%' AND IsWon = true, then get Account.Name
   - NEVER say "no data" or "not found" until you've tried at least 2 different search approaches
5. ALWAYS finish with a clear, natural-language answer — NEVER return raw JSON, raw SOQL result objects, or tool output verbatim as your final answer. If you're running low on steps, compose the best answer you can from what you have rather than dumping raw data.
6. If the question asks about something genuinely NOT in Salesforce (e.g. a company's industry/website/background — see the glossary entry on this), say so plainly in your answer and set "foundInCrm": false so the system can offer other sources. Do NOT cite Salesforce as your source when you found nothing relevant.

CRITICAL — NEVER HALLUCINATE DATA:
- Reproduce ONLY the exact values returned by tools — names, counts, amounts, dates
- Do NOT add, invent, supplement, or "complete" any list with made-up entries
- If a tool returns 10 items, report exactly those 10 — never pad the list
- If a tool returns 0 items, say "No results found" — do not fabricate entries

READING TOOL RESULTS (CRITICAL):
- SOQL queries return JSON arrays. Observations have been FLATTENED — nested objects use dot notation.
- Example: if you queried "Account.Name", the result looks like:
  [{"Name":"OPP-001","Account.Name":"John Doe","Account.Phone":"+971501234567","Amount":1500000}]
  The buyer/owner name is directly under "Account.Name" = "John Doe"
- Similarly, cm_Sales_Person__r.Name appears as: {"cm_Sales_Person__r.Name":"Ahmed"}
  The salesperson name is → cm_Sales_Person__r.Name = "Ahmed"
- ALWAYS read dot-notation keys directly — they are already flattened for you
- If the result shows "Account.Name": null, the account link is missing — report "Account not linked"
- If the result shows an empty array [], say "No records found" — do NOT ask follow-up questions

RESPONSE FORMAT — respond with ONLY one JSON object per step:
{
  "thought": "What I'm reasoning about and why",
  "action": "<tool-name>" | "finish",
  "params": { "<param-name>": "<value>", ... },
  "answer": null | "If action is 'finish', compose the final answer here",
  "foundInCrm": true | false
}

For "finish" action:
- The "answer" field MUST reproduce the EXACT data from tool observations — copy values verbatim
- Read dot-notation keys directly from flattened observations (Account.Name, cm_Sales_Person__r.Name, etc.)
- If observations contain rows with these keys, the answer MUST include the specific values (names, amounts, dates)
- NEVER say "I couldn't find" or "No owner information" when the data IS in the observations
- Format numbers with commas: AED 1,234,567
- "foundInCrm" MUST be true if you found real data, false if CRM genuinely has nothing
For tool actions, "params" must match the tool's inputSchema (e.g. soqlQuery needs {"q": "SELECT ..."}).`

  return { prompt, loadedSkills: skillResult.loadedFiles, intentCategories }
}

export interface McpStepInfo {
  action: string
  detail: string // the SOQL query (for soqlQuery), SOSL (for find), or params summary for other tools
  result?: string // truncated observation data (first 500 chars) — shown in UI thinking steps
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

      let observation: string
      try {
        const result = await callMcpTool(action, params)
        observation = result.isError ? `Tool error: ${result.content}` : result.content || 'No data returned'
      } catch (err) {
        observation = `Tool call failed: ${err instanceof Error ? err.message : String(err)}`
        console.warn(`[mcp-query] tool call failed:`, err)
      }

      // Flatten nested JSON so the LLM sees dot-notation keys (Account.Name)
      // instead of nested objects it may fail to parse
      const flatObservation = flattenNestedJson(observation)

      // Send the step with truncated result (first 500 chars) so the UI can show the data
      onStep?.({ action, detail, result: flatObservation?.slice(0, 500) })

      steps.push({ thought, action, observation: flatObservation })
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
