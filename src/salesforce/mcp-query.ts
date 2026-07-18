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
import { validateSoql, parseSoqlError } from './soql-validator'
import { buildFromJsonSpec } from './soql-query-builder'
import type { SalesforceResult, ChatTurn } from './query'
import { tryParseJson, isAggregateResult, computeGroupedTotals, computeAggregateTotals } from './format-results'

const MAX_STEPS = 12

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'been', 'were', 'they', 'their', 'what', 'when', 'which', 'will', 'about', 'would', 'could', 'should', 'there', 'these', 'those', 'into', 'than', 'them', 'then', 'also', 'your', 'some', 'each', 'most', 'does', 'only', 'just', 'like', 'over', 'such', 'after', 'before', 'between', 'through', 'during', 'where', 'show', 'list', 'give', 'find', 'get'])
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
 * Robust JSON extraction from LLM responses. Tries multiple strategies when the
 * model returns invalid or malformed JSON:
 * 1. Direct JSON.parse
 * 2. Extract first {...} block via regex
 * 3. Fix truncated JSON (close open braces/brackets)
 * 4. Detect plain-text "finish" answers
 * Returns null if all strategies fail.
 */
export function parseLlmJson(raw: string): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Strategy 1: Direct parse
  try {
    const parsed = JSON.parse(trimmed)
    if (typeof parsed === 'object' && parsed !== null) return parsed
  } catch { /* continue */ }

  // Strategy 2: Extract first {...} block
  const braceStart = trimmed.indexOf('{')
  if (braceStart >= 0) {
    // Find matching closing brace
    let depth = 0
    let inString = false
    let escape = false
    for (let i = braceStart; i < trimmed.length; i++) {
      const ch = trimmed[i]
      if (escape) { escape = false; continue }
      if (ch === '\\') { escape = true; continue }
      if (ch === '"') { inString = !inString; continue }
      if (inString) continue
      if (ch === '{') depth++
      if (ch === '}') {
        depth--
        if (depth === 0) {
          const candidate = trimmed.slice(braceStart, i + 1)
          try {
            return JSON.parse(candidate)
          } catch { /* continue looking */ }
        }
      }
    }

    // Strategy 3: Fix truncated JSON — close open braces/brackets
    if (depth > 0) {
      let fixed = trimmed.slice(braceStart)
      // Remove trailing incomplete string
      if (inString) {
        const lastQuote = fixed.lastIndexOf('"')
        if (lastQuote > 0) fixed = fixed.slice(0, lastQuote + 1)
      }
      // Close open braces and brackets
      for (let d = 0; d < depth; d++) fixed += '}'
      try {
        return JSON.parse(fixed)
      } catch { /* continue */ }
    }
  }

  // Strategy 4: Detect plain-text finish answer — if it contains "answer" and looks like
  // the model tried to answer directly instead of returning structured JSON
  const answerMatch = trimmed.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (answerMatch) {
    const answer = answerMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n')
    return { action: 'finish', answer, thought: '', foundInCrm: true }
  }

  // Strategy 5: If it looks like a plain text response that should have been a finish,
  // treat the whole thing as the answer (only if it's reasonably long — short fragments
  // are more likely broken JSON than intentional answers)
  if (trimmed.length > 50 && !trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    console.warn(`[mcp-query] parseLlmJson: treating plain text as finish answer (${trimmed.length} chars)`)
    return { action: 'finish', answer: trimmed, thought: '', foundInCrm: true }
  }

  return null
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
SOQL SYNTAX RULES (CRITICAL — these are VERIFIED against live CRM data):

1. NOT LIKE requires parentheses:
   ✅ WHERE (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%')
   ❌ WHERE NOT Name LIKE '%Miscellaneous%' AND NOT Name LIKE '%RTL%'
   ❌ WHERE Name NOT LIKE '%Miscellaneous%'

2. LIMIT RULE (aggregate queries):
   - LIMIT is FORBIDDEN on any query with aggregate functions (COUNT, SUM, AVG, MIN, MAX), EVEN WITH GROUP BY. Fetch ALL groups so totals are complete.
   - Only use LIMIT when the user explicitly asks for a subset: "top 5", "top 10", "first 3".
   - ✅ SELECT Building_Name__c, COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE ... GROUP BY Building_Name__c ORDER BY SUM(Net_Amount__c) DESC
   - ❌ SELECT Building_Name__c, COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE ... GROUP BY Building_Name__c LIMIT 10
   - ✅ SELECT Building_Name__c, COUNT(Id) cnt FROM Opportunity WHERE ... GROUP BY Building_Name__c ORDER BY COUNT(Id) DESC LIMIT 5  (user asked "top 5 buildings")

3. No stray WHERE/AND:
   ✅ WHERE field1 = 'value1' AND field2 = 'value2'
   ❌ WHERE AND field1 = 'value1'
   ❌ WHERE WHERE field1 = 'value1'

4. Date literals are UNQUOTED:
   ✅ WHERE Order_Date__c >= 2026-01-01
   ❌ WHERE Order_Date__c >= '2026-01-01'

5. Building_Community__c is NOT groupable on Opportunity (platform restriction):
   ✅ SELECT Building_Name__c, COUNT(Id) cnt FROM Opportunity GROUP BY Building_Name__c
   ❌ SELECT Building_Community__c, COUNT(Id) cnt FROM Opportunity GROUP BY Building_Community__c
   (Use Property_Inventory__c for community-level GROUP BY instead)

6. NON-GROUPABLE FIELDS — some fields cannot be used in GROUP BY on Opportunity:
   ❌ Country_of_Residence_Billing_country__c (NOT groupable in SOQL)
   ❌ Building_Community__c (NOT groupable in SOQL)
   For these: fetch ALL rows with SELECT field, WHERE field != null, then count/sum in your reasoning.
   Example: SELECT Account.Country_of_Residence_Billing_country__c FROM Opportunity WHERE Account.Country_of_Residence_Billing_country__c != null AND ... LIMIT 200
   Then tally the results yourself: count how many rows mention each country.

7. COUNTRY FIELD MAPPING (CRITICAL — use the correct field for each question type):
   - Individual buyer nationality → Account.cm_Nationality__pc (groupable in SOQL)
     Use when question asks about: buyer nationality, customer nationality, where buyers are from
   - Corporate buyer country → Account.cm_Country_Of_Incorporation__c (groupable in SOQL)
     Use when question asks about: company country, corporate buyer origin
   - Explicit residence/country of residence → Account.Country_of_Residence_Billing_country__c (NOT groupable — fetch all rows and group in-app)
     Use when question explicitly says: "country of residence", "residence country", "where do they reside"
   - Billing country (Account standard field) → Account.BillingCountry (groupable)
     Use for general Account-level country queries

8. UI DISPLAY LIMITS — when presenting results to the user:
   - If user asks "top N" or "show N", LIMIT the ORDER BY query to N rows
   - ALWAYS compute totals, percentages, and rankings from the FULL query result (before any display limit), NOT from the displayed subset
   - Example: if query returned 50 rows and you show top 10, the total should be sum of all 50 rows, not just the 10 shown

VERIFIED QUERY PATTERNS (copy these exactly for similar questions):

-- "Total sales in 2026" / "How much did we sell this year?"
SELECT COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' AND Order_Date__c >= 2026-01-01 AND Order_Date__c <= 2026-12-31 AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND (NOT Name LIKE '%PK%') AND (NOT Name LIKE '%Plot%') AND (NOT Building_Name__c LIKE '%Al Qudra%') AND (NOT Building_Name__c LIKE '%Alqudra%') AND (NOT Building_Name__c LIKE '%ALQDR%') AND (NOT Building_Name__c LIKE '%parking%') AND Amount != 1 AND CloseDate != 2032-12-28

-- "Sales by building" / "Which project sold the most?"
SELECT Building_Name__c, COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND (NOT Name LIKE '%PK%') AND (NOT Name LIKE '%Plot%') AND (NOT Building_Name__c LIKE '%Al Qudra%') AND (NOT Building_Name__c LIKE '%parking%') AND Amount != 1 AND CloseDate != 2032-12-28 AND Building_Name__c != null GROUP BY Building_Name__c ORDER BY SUM(Net_Amount__c) DESC

-- "Sales by salesperson" / "Top agents"
SELECT cm_Sales_Person__r.Name, COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND (NOT Name LIKE '%PK%') AND (NOT Name LIKE '%Plot%') AND (NOT Building_Name__c LIKE '%Al Qudra%') AND (NOT Building_Name__c LIKE '%parking%') AND Amount != 1 AND CloseDate != 2032-12-28 AND cm_Sales_Person__r.Name != null GROUP BY cm_Sales_Person__r.Name ORDER BY SUM(Net_Amount__c) DESC

-- "Sales by broker" / "Which broker generated most sales?" / "broker ranking"
-- NOTE: cm_Agent_Name__r.Name = external broker/agent (NOT internal salesperson)
SELECT cm_Agent_Name__r.Name brokerName, COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND (NOT Name LIKE '%PK%') AND (NOT Name LIKE '%Plot%') AND (NOT Building_Name__c LIKE '%Al Qudra%') AND (NOT Building_Name__c LIKE '%parking%') AND Amount != 1 AND CloseDate != 2032-12-28 AND cm_Agent_Name__r.Name != null GROUP BY cm_Agent_Name__r.Name ORDER BY SUM(Net_Amount__c) DESC

-- "Who owns unit TH-V-6?" / "Customer lookup"
SELECT Name, Account.Name, Account.Phone, Account.Email__c, Net_Amount__c, Order_Date__c, Milestone_Current_Status__c FROM Opportunity WHERE Building_Name__c LIKE '%Tower%' AND Name LIKE '%TH-V-6%' AND IsWon = true

-- "Monthly sales trend in 2026"
SELECT CALENDAR_MONTH(Order_Date__c) month, COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' AND CALENDAR_YEAR(Order_Date__c) = 2026 AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND (NOT Name LIKE '%PK%') AND (NOT Name LIKE '%Plot%') AND (NOT Building_Name__c LIKE '%Al Qudra%') AND (NOT Building_Name__c LIKE '%parking%') AND Amount != 1 AND CloseDate != 2032-12-28 GROUP BY CALENDAR_MONTH(Order_Date__c) ORDER BY CALENDAR_MONTH(Order_Date__c)

-- "How many cancellations?" / "Transfer count"
SELECT COUNT(Id) cnt FROM Opportunity WHERE Order_Stattus__c IN ('SMT_CANCELLED', 'PMT_CANCELLED', 'BOOKED_CANCELLED', 'RESERVED_CANCELLED', 'CANCELLED') AND Sold_By_Nshama__c = 'NEW SALE' AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%')

-- "List all communities" (use Property_Inventory__c, NOT Opportunity)
SELECT Building_Community__c, COUNT(Id) cnt FROM Property_Inventory__c WHERE Building_Community__c != null GROUP BY Building_Community__c ORDER BY COUNT(Id) DESC

-- "How many cases?" / "Cases by type"
SELECT Type, COUNT(Id) cnt FROM Case WHERE Type != null GROUP BY Type ORDER BY COUNT(Id) DESC

-- "DLP cases with electrical issues"
SELECT COUNT(Id) cnt FROM Case WHERE Subject LIKE '%DLP%' AND Electrical_Sub_Category__c != null

-- "Sales by bedroom type"
SELECT Sales_Room__c, COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' AND Sales_Room__c != null AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND Amount != 1 AND CloseDate != 2032-12-28 GROUP BY Sales_Room__c ORDER BY SUM(Net_Amount__c) DESC

-- "Which buildings have sold more than 5 units?"
SELECT Building_Name__c, COUNT(Id) cnt FROM Opportunity WHERE (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND (NOT Building_Name__c LIKE '%Al Qudra%') AND Building_Name__c != null GROUP BY Building_Name__c HAVING COUNT(Id) > 5 ORDER BY COUNT(Id) DESC

-- "Recent 10 call inquiries" / "recent phone calls" / "recent cases"
SELECT CaseNumber, Subject, Status, Origin, RecordType.Name, Call_Purpose__c, Account.Name, CreatedDate FROM Case WHERE Origin = 'Phone' ORDER BY CreatedDate DESC LIMIT 10

-- "Recent cases" (any type, most recent first)
SELECT CaseNumber, Subject, Status, Origin, RecordType.Name, Account.Name, CreatedDate FROM Case ORDER BY CreatedDate DESC LIMIT 10

-- "Cases by record type"
SELECT RecordType.Name, COUNT(Id) cnt FROM Case WHERE RecordType.Name != null GROUP BY RecordType.Name ORDER BY COUNT(Id) DESC

-- "2024 vs 2025 monthly sales comparison"
SELECT CALENDAR_MONTH(Order_Date__c) month, CALENDAR_YEAR(Order_Date__c) year, COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE Sold_By_Nshama__c = 'NEW SALE' AND CALENDAR_YEAR(Order_Date__c) IN (2024, 2025) AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND Amount != 1 AND CloseDate != 2032-12-28 GROUP BY CALENDAR_YEAR(Order_Date__c), CALENDAR_MONTH(Order_Date__c) ORDER BY CALENDAR_YEAR(Order_Date__c), CALENDAR_MONTH(Order_Date__c)

Opportunity — sales deals / property-unit sales. Each Opportunity IS one unit sale/transaction.
  SALES VALUE: Use Net_Amount__c (NOT Amount) as the default sales value for all totals/reports.
  DEFAULT DATE: Use Order_Date__c (NOT CloseDate) for default sales summaries — it's the date Nshama originally sold the unit.
  DEFAULT FILTER: Apply Sold_By_Nshama__c = 'NEW SALE' for general sales reports. Do NOT additionally filter by StageName or IsWon unless explicitly asked.
  GROUP BY: Building_Name__c is groupable; Building_Community__c is NOT groupable on Opportunity (platform restriction) — use Building_Name__c for Opportunity-side grouping, or filter with WHERE Building_Community__c = 'X' instead of GROUP BY.
  MANDATORY EXCLUSIONS (apply to EVERY query, even "all" or "everything"):
    - Exclude Opportunity.Name containing "Miscellaneous", "RTL", "PK", or "Plot"
    - Exclude Building_Name__c or Building_Community__c identifying "Al Qudra" (also "Alqudra", "ALQDR")
    - Exclude Building_Name__c identifying a parking record
  TRANSFER RULES:
    - New/current customer: StageName = 'Closed Won' OR IsWon = true, Order_Stattus__c = 'TRANSFERED'
    - Original customer (pre-handover): StageName = 'Closed Lost', Order_Stattus__c = 'PMT_CANCELLED', Sold_By_Nshama__c = 'NEW SALE'
    - Original customer (post-handover): StageName = 'Closed Lost', Order_Stattus__c = 'SMT_CANCELLED', Sold_By_Nshama__c = 'NEW SALE'
    - Original customer's Closed Lost + new customer's TRANSFERED = same physical unit. Do NOT count as two sales.
  CANCELLATION STATUSES: SMT_CANCELLED, PMT_CANCELLED, BOOKED_CANCELLED, RESERVED_CANCELLED, CANCELLED. TRANSFERED is NOT a cancellation.
  Traverse to customer via Account.Name, to salesperson via cm_Sales_Person__r.Name.
  External broker/agent → cm_Agent_Name__r.Name (NOT cm_Sales_Person__r which is internal).
  Agency → cm_Agency_Name__r.Name.
  When querying multiple __r.Name fields in aggregate, ALWAYS add explicit aliases to avoid duplicate alias errors:
    ✅ SELECT cm_Agent_Name__r.Name brokerName, cm_Agency_Name__r.Name agencyName, COUNT(Id) cnt ...
    ❌ SELECT cm_Agent_Name__r.Name, cm_Agency_Name__r.Name, COUNT(Id) cnt ...
  Sales_Room__c = bedroom count/configuration (Studio, 1 Bedroom, 2 Bedrooms, etc.).
  Property_Booked_Date__c = actual booking date (more accurate than CloseDate for booking trends).

Property_Inventory__c — the MASTER catalog of every physical unit/property (sold, available, rented).
  - Building_Community__c IS groupable here (100%-populated, 52 distinct real values) — use THIS object+field for "list all communities"
  - Property_Status__c: Available, Reserved, Booked, Sold, Blocked, Leased, Online Blocked

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
  - "Call inquiries" / "phone calls" = Case WHERE Origin = 'Phone'. "Recent call inquiries" = ORDER BY CreatedDate DESC LIMIT 10
  - RecordType names: "Call Center", "Property Manager", "FM 0001 Move-in Approval" — do NOT assume which record type; query by Origin = 'Phone' first

OWNER/CUSTOMER LOOKUP (CRITICAL — read this before answering any "who owns" / "who bought" / "customer" question):
  - Owner/Buyer data lives on Account, linked via Opportunity.Account
  - Property_Inventory__c is ONLY the property catalog — it has NO owner/customer fields
  - To find who owns/bought a specific unit, query Opportunity (NOT Property_Inventory__c):
    SELECT Name, Account.Name, Account.Phone, Account.Email__c, Net_Amount__c, Order_Date__c, Milestone_Current_Status__c
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

async function buildSystemPrompt(query?: string): Promise<{ prompt: string; loadedSkills: string[]; intentCategories: string[]; fileRules: Record<string, string[]> }> {
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

You have DIRECT access to the CRM's live data tools. Your job is to answer the user's question by calling these tools as needed, then composing a clear, natural-language answer.

AVAILABLE TOOLS:
${toolCatalog}

SOQL MECHANICS (query-construction rules, tested and correct — use instead of spending steps on getObjectSchema for these):
${SOQL_MECHANICS}

${glossary}
${skillResult.text}
${relationshipPaths ? '\n' + relationshipPaths + '\n' : ''}

DATA QUALITY — ALWAYS EXCLUDE TEST/PLACEHOLDER RECORDS:
- Opportunity: Amount = 1, CloseDate = 2032-12-28, cm_Sales_Person__r.Name = 'Salesforce Admin' are test/dummy records — filter these out in your WHERE clause
- Account: names like "TestAccount", "Test Account", anything starting with "Test ", "Do not update or close...", "Contractor / Miscellaneous...", "Miscellaneous..." are placeholder/junk accounts, NOT real customers — exclude from customer/account-facing answers (use "AND (NOT Account.Name LIKE 'Test%') AND (NOT Account.Name LIKE 'Do not update%') AND (NOT Account.Name LIKE '%Miscellaneous%') AND (NOT Account.Name LIKE '%Contractor%')")

VERIFIED ACCOUNT QUERY (tested against live CRM):
SELECT COUNT(Id) cnt FROM Account WHERE (NOT Name LIKE 'Test%') AND (NOT Name LIKE 'Do not update%') AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%Contractor%')

SOQL GUIDANCE:
- Always include a WHERE clause to keep queries efficient
- For aggregate queries (COUNT, SUM, AVG), NEVER add LIMIT — fetch all groups for accurate totals
- Only add LIMIT when the user explicitly asks for a subset ("top N", "show N")
- For "how much/total" style questions, use COUNT(Id) and SUM(Net_Amount__c) in one query
- For fuzzy name matching (project/community/unit codes the user typed casually), use LIKE '%name%' not exact =
- Default sales value = Net_Amount__c (NOT Amount); default date = Order_Date__c (NOT CloseDate)

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
6. If the question asks about something genuinely NOT in the CRM (e.g. a company's industry/website/background — see the glossary entry on this), say so plainly in your answer and set "foundInCrm": false so the system can offer other sources. Do NOT cite the CRM as your source when you found nothing relevant.
7. NEVER use technical jargon in your answer. Do NOT mention: SOQL, queries, CRM, database, API, MCP, or any implementation details. The user doesn't know about databases — speak in plain business language. Instead of "I queried the CRM", say "Based on the data" or "Looking at the records". Instead of "The SOQL query returned", say "The data shows".
8. If your first query returns relevant results, present them immediately — don't waste steps searching for alternative record types or interpretations.

CRITICAL — NEVER HALLUCINATE DATA:
- Reproduce ONLY the exact values returned by tools — names, counts, amounts, dates
- Do NOT add, invent, supplement, or "complete" any list with made-up entries
- If a tool returns 10 items, report exactly those 10 — never pad the list
- If a tool returns 0 items, say "No results found" — do not fabricate entries

ARITHMETIC RULE (CRITICAL — prevents wrong totals):
- If an observation contains a [PRE-COMPUTED TOTALS] section, use those exact numbers for totals/subtotals. Do NOT re-add rows yourself — you will make arithmetic errors.
- For per-row breakdowns (monthly, yearly, by community), copy individual row values verbatim.
- Only use pre-computed totals for summary statements like "2023 total was AED X" or "across all years, Y units were sold".

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
For tool actions, "params" must match the tool's inputSchema (e.g. soqlQuery needs {"q": "SELECT ..."}).

CONVERSATIONAL CORRECTIONS (when the user corrects or refines a previous answer):
- If the user says "but these are X", "that's wrong", "I meant Y", "no, not Z" — they are CORRECTING your previous interpretation
- Use conversation history to understand what the user is correcting
- Modify your SOQL filters to match the correction, not the original interpretation
- Example: if you showed all sales but user says "but these are indirect sales", add a filter for indirect channel (NOT cm_Lead_Channel__c = 'Direct Sale')

ALTERNATIVE: STRUCTURED QUERY BUILDER (use for complex queries):
Instead of raw SOQL, you can pass a structured spec that the system converts to correct SOQL:
{
  "action": "soqlQuery",
  "params": {
    "spec": {
      "object": "Opportunity",
      "fields": ["Name", "Account.Name"],
      "aggregations": [{ "function": "COUNT", "field": "Id", "alias": "cnt" }, { "function": "SUM", "field": "Net_Amount__c", "alias": "total" }],
      "filters": [{ "field": "Sold_By_Nshama__c", "op": "=", "value": "NEW SALE" }, { "field": "Name", "op": "NOT LIKE", "value": "%Miscellaneous%" }],
      "groupBy": ["Building_Name__c"],
      "orderBy": { "field": "cnt", "direction": "DESC" },
      "limit": 50
    }
  }
}
The builder handles correct NOT LIKE syntax automatically. Use this for queries with many filters or aggregations.`

  return { prompt, loadedSkills: skillResult.loadedFiles, intentCategories, fileRules: skillResult.fileRules }
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
  /** The SOQL query that was executed — passed to verifier so it can reason
   *  about whether the query was correct vs. data genuinely missing. */
  soqlQuery?: string
}

export async function answerViaMcp(
  query: string,
  history?: ChatTurn[],
  onStep?: (step: McpStepInfo) => void
): Promise<McpAnswerResult | null> {
  const startTime = Date.now()

  // Stream: classify intent
  const intents = classifyQueryIntent(query)
  onStep?.({ action: 'classifyIntent', detail: intents.length > 0 ? `Detected intent: ${intents.join(', ')}` : 'No specific intent detected' })

  try {
    // Build system prompt with conditional skill loading
    const { prompt: systemPrompt, loadedSkills, intentCategories, fileRules } = await buildSystemPrompt(query)

    // Stream: loaded skills — always show, even when none matched
    onStep?.({ action: 'loadSkills', detail: loadedSkills.length > 0 ? `Loaded ${loadedSkills.length} skill file(s): ${loadedSkills.join(', ')}` : 'No matching skill files loaded' })
    if (intentCategories.length > 0) {
      onStep?.({ action: 'classifyIntent', detail: `Matched categories: ${intentCategories.join(', ')}` })
    }

    // Skill rule matching — show which specific rules apply to the query
    const qLower = query.toLowerCase()
    for (const [fileName, rules] of Object.entries(fileRules)) {
      for (const rule of rules) {
        // Extract keywords from the rule (skip short/common words)
        const ruleLower = rule.toLowerCase()
        const ruleWords = ruleLower.split(/\s+/).filter(w => w.length > 3 && !STOP_WORDS.has(w))
        const matchCount = ruleWords.filter(w => qLower.includes(w)).length
        const matchRatio = ruleWords.length > 0 ? matchCount / ruleWords.length : 0

        // Match if >30% of meaningful rule words appear in the query, or query contains a key term
        if (matchRatio >= 0.3 || matchCount >= 2) {
          onStep?.({ action: 'skillApplied', detail: `Skill applied: "${rule.slice(0, 80)}" (${fileName})` })
        }
      }
    }

    let context = ''
    if (history && history.length > 0) {
      const recent = history.slice(-6)
      context = recent.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content.slice(0, 300)}`).join('\n')
      context += '\n'
    }
    const fullQuestion = context ? `${context}User: ${query}` : query

    const steps: { thought: string; action: string; observation: string; detail?: string }[] = []
    let input = `Question: ${fullQuestion}\n\nReason about the first step to answer this question.`
    let finalAnswer: string | null = null
    let foundInCrm = true // default optimistic — only set false when the LLM explicitly says so

    for (let stepNum = 0; stepNum < MAX_STEPS; stepNum++) {
      const raw = await chatJson(systemPrompt, input)
      const decision = parseLlmJson(raw)
      if (!decision) {
        console.warn(`[mcp-query] step ${stepNum}: failed to parse LLM response (${raw.length} chars, starts with: ${raw.slice(0, 150)})`)
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
        // Layer 3: Handle structured spec → SOQL conversion
        if (action === 'soqlQuery' && params.spec && typeof params.spec === 'object') {
          const specResult = buildFromJsonSpec(params.spec as Record<string, unknown>)
          if (specResult.error) {
            observation = `Query spec error: ${specResult.error}\n\nPlease fix the spec and try again.`
            onStep?.({ action, detail, result: observation })
            steps.push({ thought, action, observation })
            input = `Question: ${fullQuestion}\n\nSteps so far:\n${steps.map((s, i) => `${i + 1}. Thought: ${s.thought}\n   Action: ${s.action}\n   Observation: ${s.observation}`).join('\n\n')}\n\nWhat should be the next step? If you have enough data, compose the final answer.`
            continue // Skip tool call, go to next step
          }
          params.q = specResult.soql
          delete params.spec // Remove spec from params before sending to MCP
        }

        // Layer 2: Validate and auto-fix SOQL before sending to Salesforce
        if (action === 'soqlQuery' && typeof params.q === 'string') {
          const validation = validateSoql(params.q)
          if (validation.wasFixed) {
            console.warn(`[mcp-query] step ${stepNum}: auto-fixed SOQL:`, validation.fixes)
            params.q = validation.query
          }
          if (!validation.valid) {
            observation = `SOQL validation error: ${validation.error}\n\nYour query was:\n${String(params.q).slice(0, 300)}\n\nFix the syntax error and try again. Common issues:\n- NOT LIKE requires parentheses: (NOT Name LIKE '%value%')\n- Remove LIMIT from aggregate queries without GROUP BY\n- Remove duplicate WHERE/AND clauses`
            onStep?.({ action, detail, result: observation })
            steps.push({ thought, action, observation })
            input = `Question: ${fullQuestion}\n\nSteps so far:\n${steps.map((s, i) => `${i + 1}. Thought: ${s.thought}\n   Action: ${s.action}\n   Observation: ${s.observation}`).join('\n\n')}\n\nWhat should be the next step? If you have enough data, compose the final answer.`
            continue // Skip tool call, go to next step
          }
        }

        const result = await callMcpTool(action, params)

        // Layer 4: Enhanced error feedback for MALFORMED_QUERY
        if (result.isError && result.content.includes('MALFORMED_QUERY')) {
          const errorContext = parseSoqlError(result.content)
          observation = `SOQL Syntax Error: ${errorContext.message}\n\n${errorContext.suggestions.join('\n')}\n\n${errorContext.problemArea ? `Problem area: "...${errorContext.problemArea}..."` : ''}\n\nFix the syntax and try again.`
        } else {
          observation = result.isError ? `Tool error: ${result.content}` : result.content || 'No data returned'
        }
      } catch (err) {
        observation = `Tool call failed: ${err instanceof Error ? err.message : String(err)}`
        console.warn(`[mcp-query] tool call failed:`, err)
      }

      // Flatten nested JSON so the LLM sees dot-notation keys (Account.Name)
      // instead of nested objects it may fail to parse
      let flatObservation = flattenNestedJson(observation)

      // ── PRE-COMPUTE TOTALS for GROUP BY aggregate results ──────────────
      // LLMs are unreliable at summing many rows. Detect aggregate results
      // (multiple rows with count/sum columns) and inject server-computed
      // totals so the LLM copies correct numbers instead of adding wrong.
      try {
        const rows = tryParseJson(flatObservation)
        if (rows && isAggregateResult(rows)) {
          const totals = computeGroupedTotals(rows, 'year') || computeAggregateTotals(rows)
          if (totals) flatObservation += '\n\n' + totals
        }
      } catch { /* non-JSON observation or parse error — skip */ }

      // Send the step with full result so the UI can show the data
      onStep?.({ action, detail, result: flatObservation })

      steps.push({ thought, action, observation: flatObservation, detail })
      input = `Question: ${fullQuestion}\n\nSteps so far:\n${steps.map((s, i) => `${i + 1}. Thought: ${s.thought}\n   Action: ${s.action}\n   Observation: ${s.observation}`).join('\n\n')}\n\nWhat should be the next step? If you have enough data, compose the final answer.`
    }

    if (!finalAnswer) {
      // Ran out of steps without an explicit "finish" — force one more LLM call to compose
      // a clean natural-language answer from what was gathered, instead of returning raw
      // tool output/JSON (which happened before this safety net was added).
      console.log('[mcp-query] max steps reached without finish — forcing final answer composition')
          onStep?.({ action: 'composeAnswer', detail: 'Composing final answer from gathered data...' })
      const composePrompt = `Question: ${fullQuestion}\n\nSteps taken so far:\n${steps.map((s, i) => `${i + 1}. Thought: ${s.thought}\n   Action: ${s.action}\n   Observation: ${s.observation}`).join('\n\n')}\n\nYou've used all available tool calls. Compose the best possible natural-language answer using ONLY the data already gathered above. Do not call any more tools. IMPORTANT: Do NOT use technical jargon — no SOQL, no "query", no "CRM", no "database". Speak in plain business language like "Based on the data..." or "The records show...". Respond with ONLY JSON: {"answer": "<your natural language answer>", "foundInCrm": true|false}\n\nARITHMETIC RULE (CRITICAL):\n- If observations contain a [PRE-COMPUTED TOTALS] section, use those exact numbers for totals and subtotals. Do NOT re-compute totals from individual rows — you will get the math wrong.\n- For per-row breakdowns (monthly, yearly, by community), copy the individual row values verbatim — do not add them up yourself.\n- Only use the pre-computed totals for summary/aggregate statements like "2023 total was AED X" or "across all years, Y units".`
      try {
        const raw = await chatJson(systemPrompt, composePrompt)
        const parsed = parseLlmJson(raw)
        if (parsed) {
          finalAnswer = String(parsed.answer || '') || null
          if (typeof parsed.foundInCrm === 'boolean') {
            foundInCrm = parsed.foundInCrm
          }
        } else {
          // Raw response couldn't be parsed — use it as plain text answer if it's long enough
          if (raw.length > 20) {
            finalAnswer = raw
          }
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
    // Extract the SOQL query that was executed — the detail field contains the SOQL
    // for soqlQuery actions, or the params JSON for other tool calls
    const soqlStep = steps.find(s => s.action === 'soqlQuery' && s.detail)
    const soqlQuery = soqlStep?.detail || undefined
    console.log(`[mcp-query] completed in ${steps.length} steps (${Date.now() - startTime}ms), foundInCrm=${foundInCrm}`)
    return { context: finalAnswer, citation: { documentName: 'CRM (live data)' }, foundInCrm, rawObservations, soqlQuery }
  } catch (err) {
    console.error('[mcp-query] failed:', err)
    return { context: `I encountered an error querying the CRM: ${err instanceof Error ? err.message : String(err)}`, citation: { documentName: 'CRM (live data)' }, foundInCrm: false, rawObservations: '' }
  }
}
