// Skill Files — free-form instruction documents that get injected into the MCP system
// prompt. Unlike glossary terms (structured term→field mappings), skill files contain
// detailed business rules, query patterns, and domain knowledge that help the LLM
// answer questions correctly. Users add/edit these via Settings UI.
//
// CONDITIONAL LOADING: Instead of injecting ALL skill files into every prompt (wasteful),
// we classify the query intent first, then load only matching skill files. Each skill file
// has triggerWords (comma-separated keywords) that determine when it's relevant.
import { db } from '@/lib/db'
import { skillFiles } from '@/lib/db/schema'
import { eq, asc } from 'drizzle-orm'

export interface SkillFile {
  id: string
  name: string
  category: string
  triggerWords: string
  content: string
  active: boolean
  createdAt: Date
  updatedAt: Date
}

/** Known intent categories — matched against query text and skill file triggerWords */
export const INTENT_CATEGORIES = [
  'ownership',  // who owns, buyer, customer name
  'sales',      // deals, revenue, closed won
  'property',   // units, inventory, available
  'pricing',    // amount, value, AED, cost
  'reporting',  // breakdown, comparison, chart, table
  'pipeline',   // pending, upcoming, lost, all deals
  'case',       // cases, service requests, complaints, violations
] as const

export type IntentCategory = typeof INTENT_CATEGORIES[number]

/**
 * Classify a user query into one or more intent categories.
 * Returns categories sorted by relevance (most relevant first).
 */
export function classifyQueryIntent(query: string): IntentCategory[] {
  const q = query.toLowerCase()
  const scores: Record<string, number> = {}

  for (const cat of INTENT_CATEGORIES) {
    scores[cat] = 0
  }

  // Ownership signals
  if (/\b(who|owner|buyer|customer|purchased|bought)\b/.test(q)) scores.ownership += 3
  if (/\b(unit|property)\s+(owner|buyer)\b/.test(q)) scores.ownership += 2
  if (/\b(account|contact)\s+(name|info)\b/.test(q)) scores.ownership += 1

  // Sales signals
  if (/\b(sale|deal|revenue|closed|won|sold|amount|total)\b/.test(q)) scores.sales += 2
  if (/\b(deal\s+count|number\s+of\s+deals)\b/.test(q)) scores.sales += 2
  if (/\bby\s+year|by\s+month|by\s+quarter/.test(q)) scores.sales += 1

  // Property signals
  if (/\b(property|unit|inventory|available|vacant|building)\b/.test(q)) scores.property += 2
  if (/\b(list|show)\s+(all\s+)?(communities|projects|buildings)\b/.test(q)) scores.property += 2
  if (/\bcommunity|project\b/.test(q)) scores.property += 1

  // Pricing signals
  if (/\b(price|pricing|cost|aed|value|worth)\b/.test(q)) scores.pricing += 2
  if (/\b(average|avg|median|highest|lowest)\s+(price|amount|value)\b/.test(q)) scores.pricing += 2

  // Reporting signals
  if (/\b(breakdown|comparison|compare|chart|table|report|summary|overview)\b/.test(q)) scores.reporting += 2
  if (/\b(v|vs|versus|against)\b/.test(q)) scores.reporting += 2

  // Pipeline signals
  if (/\b(pipeline|pending|upcoming|lost|cancelled|all\s+deals)\b/.test(q)) scores.pipeline += 2
  if (/\b(stage|status|won|lost)\b/.test(q)) scores.pipeline += 1

  // Case / Service Request signals
  if (/\b(case|complaint|enquiry|inquiry|ticket|violation|call\s+inquiry)\b/.test(q)) scores.case += 3
  if (/\b(service\s+request|support\s+ticket|customer\s+request)\b/.test(q)) scores.case += 3
  if (/\b(call\s+history|call\s+enquir|open\s+ticket|pending\s+ticket)\b/.test(q)) scores.case += 2
  if (/\b(issues?|problems?)\s+(for|from|of|related)\b/.test(q)) scores.case += 1

  // Sort by score, return categories with score > 0
  return (Object.entries(scores) as [string, number][])
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([cat]) => cat as IntentCategory)
}

export async function getSkillFiles(): Promise<SkillFile[]> {
  await ensureSeeded()
  return db.select().from(skillFiles).orderBy(asc(skillFiles.createdAt))
}

export async function getActiveSkillFiles(): Promise<SkillFile[]> {
  await ensureSeeded()
  return db.select().from(skillFiles).where(eq(skillFiles.active, true)).orderBy(asc(skillFiles.createdAt))
}

/**
 * Get skill files matching the query intent. Matches against:
 * 1. triggerWords (comma-separated keywords in the skill file)
 * 2. category (exact match to intent category)
 * Always includes 'general' category files (universal instructions).
 */
export async function getMatchingSkillFiles(query: string): Promise<SkillFile[]> {
  const allActive = await getActiveSkillFiles()
  const intents = classifyQueryIntent(query)

  if (intents.length === 0) {
    return allActive.filter(f => f.category === 'general')
  }

  const matched = new Map<string, SkillFile>()

  for (const file of allActive) {
    if (file.category === 'general') {
      matched.set(file.id, file)
      continue
    }
    if (intents.includes(file.category as IntentCategory)) {
      matched.set(file.id, file)
      continue
    }
    if (file.triggerWords) {
      const triggers = file.triggerWords.toLowerCase().split(',').map(t => t.trim()).filter(Boolean)
      const qLower = query.toLowerCase()
      const hasTrigger = triggers.some(t => qLower.includes(t))
      if (hasTrigger) {
        matched.set(file.id, file)
      }
    }
  }

  return Array.from(matched.values())
}

export async function addSkillFile(name: string, category: string, triggerWords: string, content: string): Promise<SkillFile> {
  const [row] = await db.insert(skillFiles).values({ name, category, triggerWords, content }).returning()
  return row
}

export async function updateSkillFile(id: string, name: string, category: string, triggerWords: string, content: string, active: boolean): Promise<SkillFile | null> {
  const [row] = await db.update(skillFiles).set({ name, category, triggerWords, content, active, updatedAt: new Date() }).where(eq(skillFiles.id, id)).returning()
  return row || null
}

export async function deleteSkillFile(id: string): Promise<void> {
  await db.delete(skillFiles).where(eq(skillFiles.id, id))
}

// ─── BUILT-IN SEED DEFAULTS ──────────────────────────────────────────────────
// When the DB has zero skill files, auto-seed these. Users can edit/delete them
// via Settings UI — the seeds only fire once on first load.

const SEED_DEFAULTS: Array<{ name: string; category: string; triggerWords: string; content: string }> = [
  {
    name: 'Unit Ownership Lookup Guide',
    category: 'ownership',
    triggerWords: 'who owns, buyer, customer, purchased, bought, owner, customer name, contact, email, phone, account name, linked, related, associated',
    content: `## CRITICAL: How to Look Up Unit Ownership

### Which Object to Query
- **ALWAYS query Opportunity** for ownership/customer questions
- NEVER query Property_Inventory__c for owner data — it has NO owner fields and NO direct link to Opportunity/Account
- Property_Inventory__c is ONLY the property catalog (unit details, pricing, availability)

### Standard Ownership Query Pattern (single-hop)
\`\`\`
SELECT Name, Account.Name, Account.Phone, Account.Email__c, Amount, CloseDate, Milestone_Current_Status__c
FROM Opportunity
WHERE Building_Name__c LIKE '%<project>%' AND Name LIKE '%<unit>%' AND IsWon = true
\`\`\`

### Multi-Hop Pattern (via Opportunity_Property__c bridge)
When querying from Property_Inventory__c (e.g. "show me owners of all units in Safi"):
\`\`\`
-- Step 1: Get unit IDs from Property_Inventory__c
SELECT Id, Name FROM Property_Inventory__c WHERE Building_Community__c = 'Safi'

-- Step 2: Bridge through Opportunity_Property__c to find the linked Opportunity
SELECT cm_Opportunity__r.Name, cm_Opportunity__r.Account.Name,
       cm_Opportunity__r.CloseDate, cm_Opportunity__r.Amount
FROM Opportunity_Property__c
WHERE cm_Property_Inventory__c = '<unit_id>'

-- Or combined: Get all sold units with their buyers
SELECT cm_Property_Inventory__r.Name, cm_Opportunity__r.Name,
       cm_Opportunity__r.Account.Name, cm_Opportunity__r.Amount
FROM Opportunity_Property__c
WHERE cm_Opportunity__r.IsWon = true
  AND cm_Property_Inventory__r.Building_Community__c = 'Safi'
\`\`\`

### Field Mappings for Ownership
| What the user asks | What to query |
|---|---|
| Who owns unit X? | Opportunity.Account.Name WHERE Name LIKE '%X%' AND IsWon=true |
| Buyer/buyer name | Opportunity.Account.Name |
| Customer contact | Opportunity.Account.Phone, Opportunity.Account.Email__c |
| When purchased? | Opportunity.CloseDate |
| Deal amount | Opportunity.Amount (may be null for some won deals) |
| Unit code/name | Opportunity.Name (e.g. "MNT-V-1234") |
| Salesperson | Opportunity.cm_Sales_Person__r.Name |
| Agency | Opportunity.cm_Agency_Name__r.Name |

### Unit Code Patterns
- Format varies: "MNT-V-1234", "SAFI-TH-001", "BRT-A-010", "NSH-V-567", "JLT-V-0123", etc.
- If user says "Villa 6" or "unit 6", search with Name LIKE '%V-6%' or Name LIKE '%-%6'
- If user says "V-401", search with Name LIKE '%V-401%'
- Use LIKE '%...%' for fuzzy matching — never exact match on unit codes

### Fuzzy Search Strategy (CRITICAL — use when exact code doesn't match)
When a user types a unit code like "TS SAF TH-V-6", the prefix may be wrong. Do NOT give up after one failed query.
1. **Extract the core unit code** — strip the project prefix. From "TS SAF TH-V-6", extract "TH-V-6"
2. **Search with just the core code**: SELECT Name, Account.Name, Amount FROM Opportunity WHERE Name LIKE '%TH-V-6%' AND IsWon=true
3. **If still no results, try SOSL**: Use the find tool with searchTerm="TH-V-6" to search across all objects
4. **Never say "no data" until you've tried at least 2 different search strategies**
5. Common prefix mistakes users make: "SAF" for "Safi" but unit is in "HYT" (Hayat), "MNT" for "Mudon", etc.

### Project Name Mapping
- Use Building_Name__c (on Opportunity) — NOT Building_Community__c
- Common aliases: "Safi" = Building_Name__c LIKE '%Safi%', "Barsha" = LIKE '%Barsha%'
- "Safi Townhouse" = Building_Name__c LIKE '%Safi%' (covers "Safi Townhouse V-6" etc.)
- "MNT" or "Mantle" = Building_Name__c LIKE '%MNT%' or LIKE '%Mantle%'
- "NSH" = Building_Name__c LIKE '%NSH%' or LIKE '%Nshama%'

### Transfer / Cancellation Scenarios
- If IsWon=false AND IsClosed=true → deal is Lost (cancellation or rejected)
- To find transfers: use Old_Opportunity__r.Name and New_Opportunity__r.Name to trace transfer chains
- A transfer means the deal moved from one Opportunity to another via these self-referential lookups

### Multi-Step Pattern (if first query returns nothing)
1. First try Opportunity WHERE Name LIKE '%<unit code>%'
2. If no result, try Property_Inventory__c WHERE Name LIKE '%<unit code>%' — this confirms the unit EXISTS but may not be sold
3. Then bridge through Opportunity_Property__c: WHERE cm_Property_Inventory__c = '<property_id>'
4. If still nothing, say "No ownership record found — the unit may not be sold yet"
`,
  },
  {
    name: 'Object Associations & Relationship Traversal',
    category: 'general',
    triggerWords: 'linked, related, associated, connection, bridge, relationship, join, link, connect, cross-object',
    content: `## Salesforce Object Associations (CRITICAL for Cross-Object Queries)

### The Association Graph
\`\`\`
Account ← Opportunity (via AccountId)
Account ← Case (via AccountId)
Account ← Contact (via AccountId, Primary_Contact__r)
Opportunity ← User (via cm_Sales_Person__r — salesperson)
Opportunity ← Agency (via cm_Agency_Name__r)
Opportunity ← Agent (via cm_Agent_Name__r)
Opportunity ← Property__c (via Property__r)
Opportunity ← Self (via Old_Opportunity__r, New_Opportunity__r — transfer chains)
Case ← Account (via AccountId)
Case ← Contact (via ContactId)
Case ← Opportunity (via Opportunity_Name__r — note: field has typo "Opporutniy")
Case ← Self (via New_Opportunity__c)
Lead ← Account (via ConvertedAccountId, after conversion)
Lead ← Opportunity (via ConvertedOpportunityId, after conversion)
Task ← Account/Opportunity/Case (via WhatId — polymorphic)
Task ← Contact/Lead (via WhoId — polymorphic)
Task ← User (via Owner)
\`\`\`

### CRITICAL: Property_Inventory__c Bridge Pattern
Property_Inventory__c has **NO direct link** to Opportunity or Account.
To connect a unit to its buyer, you MUST go through Opportunity_Property__c:

\`\`\`
Property_Inventory__c → Opportunity_Property__c → Opportunity → Account
(unit)                   (bridge record)           (deal)       (buyer)
\`\`\`

**Example: "Who owns all units in Safi?"**
\`\`\`
-- WRONG: Property_Inventory__c has no Account/owner field
SELECT Name, Account__c FROM Property_Inventory__c -- WILL NOT WORK

-- CORRECT: Bridge through Opportunity_Property__c
SELECT cm_Property_Inventory__r.Name, cm_Opportunity__r.Name,
       cm_Opportunity__r.Account.Name, cm_Opportunity__r.Amount
FROM Opportunity_Property__c
WHERE cm_Opportunity__r.IsWon = true
  AND cm_Property_Inventory__r.Building_Community__c = 'Safi'
\`\`\`

### One-Hop Traversal Patterns (field → related field)
| From Object | Traversal | Target |
|---|---|---|
| Opportunity | Account.Name | Buyer/customer name |
| Opportunity | Account.Phone | Customer phone |
| Opportunity | Account.Email__c | Customer email |
| Opportunity | cm_Sales_Person__r.Name | Salesperson name |
| Opportunity | cm_Agency_Name__r.Name | Agency name |
| Opportunity | cm_Agent_Name__r.Name | Agent/broker name |
| Opportunity | Property__r.Name | Property project name |
| Case | Account.Name | Customer who raised case |
| Case | Contact.Name | Contact who raised case |
| Case | Opportunity_Name__r.Name | Linked deal |
| Contact | Account.Name | Parent account |
| Account | Primary_Contact__r.Name | Primary contact person |
| Task | Owner.Name | Task owner |

### Multi-Hop Traversal Patterns
| From | Via | To | Use Case |
|---|---|---|---|
| Property_Inventory__c | Opportunity_Property__c.cm_Opportunity__r | Account.Name | Find buyer of a unit |
| Lead | ConvertedAccountId | Account.Name | Find account from converted lead |
| Lead | ConvertedOpportunityId | Opportunity.Name | Find deal from converted lead |
| Task | WhatId → Account | Account.Name | Find account linked to task |

### Self-Referential (Transfer Chains)
| Field | Meaning |
|---|---|
| Old_Opportunity__r.Name | Previous deal (before transfer) |
| New_Opportunity__r.Name | Replacement deal (after transfer) |
Use these to trace: "This unit was transferred from Deal A to Deal B"

### Polymorphic Fields (WhatId / WhoId)
- Task.WhatId can point to Account, Opportunity, or Case
- Task.WhoId can point to Contact or Lead
- To filter: add \`AND WhatId IN (SELECT Id FROM Account)\` or check the type via \`What.Type\`
\`\`\`
`,
  },
  {
    name: 'Sales & Revenue Calculation Rules',
    category: 'sales',
    triggerWords: 'deals, revenue, closed, won, sold, amount, total sales, deal count, number of deals, total revenue, sales total, average deal, highest deal, biggest deal, how many deals',
    content: `## How to Calculate Sales & Revenue

### Key Date Field
- **CloseDate** = when the deal was signed/closed (use this for year comparisons)
- NEVER use CreatedDate for "by year" sales questions — use CloseDate
- For "this year" filter: CloseDate >= CURRENT_YEAR-01-01 AND CloseDate <= CURRENT_YEAR-12-31

### What Counts as a "Deal" / "Sale"
- Each row in Opportunity = one deal/transaction
- "Closed Won" = IsWon = true (the deal is finalized and revenue)
- "Closed Lost" = IsClosed = true AND IsWon = false (deal fell through)

### Standard Revenue Query
\`\`\`
SELECT COUNT(Id) dealCount, SUM(Amount) totalRevenue
FROM Opportunity
WHERE IsWon = true
  AND CloseDate >= 2024-01-01 AND CloseDate <= 2024-12-31
  AND Amount > 0
  AND cm_Sales_Person__r.Name != 'Salesforce Admin'
  AND Account.Name NOT LIKE 'Test%'
\`\`\`

### Filtering Rules
- ALWAYS exclude test records: Amount = 1, CloseDate = 2032-12-28, cm_Sales_Person__r.Name = 'Salesforce Admin'
- ALWAYS exclude test accounts: Account.Name NOT LIKE 'Test%' AND NOT LIKE 'Do not update%'
- For "total revenue" → SUM(Amount) WHERE Amount > 0 (some won deals have null Amount)
- For "deal count" → COUNT(Id) WHERE IsWon = true

### Aggregate vs Row-Level
- If user asks "total revenue" → use COUNT(Id) + SUM(Amount) in one query
- If user asks "list of deals" → use SELECT Name, Account.Name, Amount, CloseDate LIMIT 200
- If user asks "how many deals in 2024" → use COUNT(Id) with date filter
`,
  },
  {
    name: 'Property & Community Listing Rules',
    category: 'property',
    triggerWords: 'community, communities, project, projects, building, buildings, inventory, available, vacant, list units, show units, unit type, bedroom, property list, building list',
    content: `## How to List Properties & Communities

### Which Object for What
| Data | Object | Key Fields |
|---|---|---|
| Master list of ALL units | Property_Inventory__c | Name, Building_Community__c, Unit_Details__c, Property_Status__c |
| List of communities/projects | Property_Inventory__c | Building_Community__c (groupable here) |
| Sales data per unit | Opportunity | Building_Name__c, Name, Amount, IsWon |
| Unit type (bedroom count) | Opportunity | Sales_Room__c (= bedroom count) |

### List All Communities (DISTINCT)
\`\`\`
SELECT Building_Community__c, COUNT(Id) unitCount
FROM Property_Inventory__c
WHERE Building_Community__c != null
GROUP BY Building_Community__c
ORDER BY COUNT(Id) DESC
LIMIT 200
\`\`\`

### List Units in a Community
\`\`\`
SELECT Name, Unit_Details__c, Property_Status__c, Unit_Type__c
FROM Property_Inventory__c
WHERE Building_Community__c LIKE '%<community>%'
  AND Property_Status__c != 'Draft'
LIMIT 200
\`\`\`

### Count Units by Status
\`\`\`
SELECT Property_Status__c, COUNT(Id) count
FROM Property_Inventory__c
WHERE Building_Community__c LIKE '%<community>%'
GROUP BY Property_Status__c
\`\`\`

### Available/Vacant Units
\`\`\`
SELECT Name, Unit_Details__c, Unit_Type__c, Building_Community__c
FROM Property_Inventory__c
WHERE Property_Status__c = 'Available' OR Property_Status__c LIKE '%Vacant%'
LIMIT 200
\`\`\`

### Important Notes
- Building_Community__c on Property_Inventory__c has 52 distinct real values — use this to list communities
- Building_Community__c on Opportunity is NOT groupable (Salesforce restriction) — use Opportunity.Building_Name__c instead
- Unit_Details__c = type description (e.g. "2 BR Villa", "Studio Apartment")
- Sales_Room__c on Opportunity = bedroom count (NOT on Property_Inventory__c)
`,
  },
  {
    name: 'Reporting & Comparison Rules',
    category: 'reporting',
    triggerWords: 'breakdown, comparison, compare, chart, table, report, summary, overview, vs, versus, against, performance, by year, by month, by quarter, by salesperson, by project, by community, top, best, worst',
    content: `## How to Do Comparisons & Reporting

### By Project/Community
\`\`\`
SELECT Building_Name__c, COUNT(Id) deals, SUM(Amount) revenue
FROM Opportunity
WHERE IsWon = true AND Amount > 0
  AND cm_Sales_Person__r.Name != 'Salesforce Admin'
GROUP BY Building_Name__c
ORDER BY SUM(Amount) DESC
LIMIT 50
\`\`\`

### By Year
\`\`\`
SELECT CALENDAR_YEAR(CloseDate) year, COUNT(Id) deals, SUM(Amount) revenue
FROM Opportunity
WHERE IsWon = true AND Amount > 0
  AND cm_Sales_Person__r.Name != 'Salesforce Admin'
GROUP BY CALENDAR_YEAR(CloseDate)
ORDER BY CALENDAR_YEAR(CloseDate) DESC
LIMIT 50
\`\`\`

### By Salesperson
\`\`\`
SELECT cm_Sales_Person__r.Name, COUNT(Id) deals, SUM(Amount) revenue
FROM Opportunity
WHERE IsWon = true AND Amount > 0
  AND cm_Sales_Person__r.Name != 'Salesforce Admin'
GROUP BY cm_Sales_Person__r.Name
ORDER BY SUM(Amount) DESC
LIMIT 50
\`\`\`

### By Month (Current Year)
\`\`\`
SELECT CALENDAR_MONTH(CloseDate) month, COUNT(Id) deals, SUM(Amount) revenue
FROM Opportunity
WHERE IsWon = true AND Amount > 0
  AND CloseDate >= 2026-01-01 AND CloseDate <= 2026-12-31
  AND cm_Sales_Person__r.Name != 'Salesforce Admin'
GROUP BY CALENDAR_MONTH(CloseDate)
ORDER BY CALENDAR_MONTH(CloseDate) ASC
LIMIT 50
\`\`\`

### By Bedroom Count
\`\`\`
SELECT Sales_Room__c, COUNT(Id) deals, SUM(Amount) revenue
FROM Opportunity
WHERE IsWon = true AND Amount > 0 AND Sales_Room__c != null
  AND cm_Sales_Person__r.Name != 'Salesforce Admin'
GROUP BY Sales_Room__c
ORDER BY Sales_Room__c ASC
\`\`\`

### Comparison Template (Year vs Year)
Run TWO queries:
1. Current year: SUM(Amount) + COUNT(Id) WHERE IsWon=true AND Amount>0
2. Previous year: Same but different date range
Then compute % change in your answer.

### Formatting Guidelines
- Always show AED amounts with comma separators: AED 1,234,567
- Show percentages with 1 decimal: +12.3%
- For tables: use markdown table format
- Include both count AND revenue where possible
- Sort by revenue descending unless user specifies otherwise

### GROUP BY Restrictions
- Opportunity: Building_Name__c OK, Building_Community__c NOT GROUPABLE
- Property_Inventory__c: Building_Community__c OK, Building_Name__c OK
- Sales_Room__c, cm_Sales_Person__r.Name, CALENDAR_YEAR/MONTH all OK
`,
  },
  {
    name: 'General CRM Query Rules',
    category: 'general',
    triggerWords: '',
    content: `## General Nshama CRM Query Rules

### Always Apply These Filters
When querying Opportunity, always add:
- AND cm_Sales_Person__r.Name != 'Salesforce Admin'
- AND Account.Name NOT LIKE 'Test%'
- AND Account.Name NOT LIKE 'Do not update%'
- AND Account.Name NOT LIKE '%Miscellaneous%'
- AND Account.Name NOT LIKE '%Contractor%'

### Date Context
- Today is 2026-07-13
- Current year: 2026
- When user says "this year" → 2026
- When user says "last year" → 2025
- When user says "this month" → July 2026

### Common Acronyms
- MNT = Mantle (project)
- NSH = Nshama (project)
- BRT = Barsha (project)
- SAFI = Safi (project)
- JVC = Jumeirah Village Circle
- JLT = Jumeirah Lake Towers

### Answer Format
- Always respond in natural language, not raw data
- For numbers, use comma separators: AED 1,234,567
- For comparisons, show % change
- For lists, use bullet points or markdown tables
- Always acknowledge the source: "Based on the CRM data..."
`,
  },
  {
    name: 'Salesforce Cases',
    category: 'case',
    triggerWords: 'case, cases, service request, service requests, complaint, complaints, enquiry, enquiries, inquiry, inquiries, issue, issues, ticket, tickets, support, violation, call, call enquiry, call inquiries, support ticket, customer request, customer service',
    content: `# Salesforce Cases (Service Requests / Tickets / Complaints / Enquiries)

This skill defines how to search, filter, display, and summarize Salesforce **Case** records via the connected Salesforce MCP, and how to connect Cases to their related **Opportunity**, **Account**, and **Contact**.

## Terminology mapping

Users rarely say "Case". Treat ALL of the following as the Salesforce Case object:

| User says | Meaning |
|---|---|
| Service Request / Customer Service Request | Case |
| Support Ticket / Ticket | Case |
| Customer Request / Request | Case |
| Complaint | Case |
| Enquiry / Inquiry | Case |
| Issue | Case |
| Call / Call Enquiry | Case with \`Origin = 'Phone'\` |

## Relationship model

Cases connect to Opportunities three ways. When asked for Cases related to an Opportunity (or a booking/unit that maps to an Opportunity), retrieve Cases matching **any** of these, then de-duplicate by Id:

1. **Direct Case→Opportunity lookup**: the custom field \`Opportunity_Name__c\` on Case (the standard Case object has no Opportunity lookup — always use this custom field for the direct relationship).
2. **Via Account**: \`Case.AccountId\` = the Opportunity's \`AccountId\`.
3. **Via Contact**: \`Case.ContactId\` = the Opportunity's primary Contact (e.g., from \`Opportunity.ContactId\` or the primary \`OpportunityContactRole\`).

Example SOQL pattern:

\`\`\`
SELECT Id, CaseNumber, Origin, Status, CreatedDate, eService_Name_Formula__c,
       AccountId, Account.Name, ContactId, Contact.Name,
       Opportunity_Name__c, ParentId
FROM Case
WHERE ParentId = null
  AND (Opportunity_Name__c = :oppId
       OR AccountId = :oppAccountId
       OR ContactId = :oppContactId)
ORDER BY CreatedDate DESC
\`\`\`

When the user gives an Account, Contact, or customer name instead of an Opportunity, resolve the record first (query Account/Contact by name), then filter Cases on \`AccountId\` / \`ContactId\`.

## Search behaviour

Whenever the user asks about cases using ANY of the terms above — even indirectly ("any complaints from this customer?", "issues pending for this booking?") — run the Case search and show the results. Do not ask the user to rephrase into "Cases".

- "this customer / this account" → filter by AccountId (and/or ContactId for a person).
- "this booking / this unit / this opportunity" → resolve the Opportunity, then apply the 3-way relationship logic above.
- "open tickets" → add \`AND IsClosed = false\` (or \`Status != 'Closed'\`).
- "calls" → filter \`Origin = 'Phone'\`.

## Display logic

### Default filter

**Always filter \`ParentId = null\` by default** — show only parent (top-level) Cases. Include child Cases only if the user explicitly asks for them (e.g., "show child cases", "include sub-cases").

### Default fields (every case, every list)

Show these for ALL cases:

| Column | Source |
|---|---|
| Case Number | \`CaseNumber\` |
| Request Type | see per-type rules below (default: \`eService_Name_Formula__c\`) |
| Date | \`CreatedDate\` |
| Origin | \`Origin\` |
| Status | \`Status\` |

### Per-type rules — evaluate in this exact sequence

Check each case against these rules **in order**; the first match determines how it is displayed.

**Sequence 1 — Phone / Call Enquiry** (\`Origin = 'Phone'\`)
- Treat the Case itself as a call. If the user asks about "calls" for a unit/customer, these Cases ARE the calls — present them as calls.
- Request Type = **"Call Enquiry"** (fixed label)
- Status = **"Closed"** (fixed value — always display Closed regardless of the record's Status field)
- Date = \`CreatedDate\`
- Additionally show: \`Description\`, \`Case_Code__c\`, \`Call_Purpose__c\`

**Sequence 2 — Violation penalty** (\`eService_Name_Formula__c = 'Violation penalty'\`)
- Show the default fields only.
- If the user asks for more detail (or asks specifically about the violation), additionally show:
  \`Violation_Incident_Date__c\`, \`Violation_Followup_Date__c\`, \`Violation_Category__c\`, \`Violation_Sub_Category__c\`, \`Violation_Description__c\`, \`Violation_Amount__c\`

**Sequence 3 — NOC for sell** (\`eService_Name_Formula__c LIKE '%NOC for sell%'\`)
- Request Type = the value of \`eService_Name_Formula__c\`
- Additionally show: \`Current_Price__c\`, \`New_Selling_Price_AED__c\`

**Sequence 4 — DLP Maintenance** (\`eService_Name_Formula__c = 'DLP - Maintenance Service'\`)
- Show whichever of these sub-category fields are **not null** (omit null ones):
  \`Civil_Sub_Category__c\`, \`Carpentry_Sub_category__c\`, \`Painting_Sub_Category__c\`, \`Mechanical_Sub_category__c\`, \`Electrical_Sub_Category__c\`, \`Plumbing_Sub_Category__c\`
- Also show: \`Description\`, \`Preferred_Visit_Date__c\`, \`Status\`
- If the user asks for other details, resolve the correct API field by matching the user's wording against Case **field labels** (see "Resolving fields by label" below).

**IMPORTANT — DLP sub-category fields are ON the Case object:**
DLP cases use fields like \`Electrical_Sub_Category__c\`, \`Civil_Sub_Category__c\`, etc. directly on Case. Do NOT query separate objects like \`Case_Issues__c\` or \`Issue__c\` — they do not exist.
- Find DLP cases with electrical issues: \`SELECT ... FROM Case WHERE Subject LIKE '%DLP%' AND Electrical_Sub_Category__c != null AND ParentId = null\`
- Find DLP cases with any specific trade: replace \`Electrical_Sub_Category__c\` with the relevant sub-category field name (\`Civil_Sub_Category__c\`, \`Painting_Sub_Category__c\`, \`Mechanical_Sub_category__c\`, \`Plumbing_Sub_Category__c\`, \`Carpentry_Sub_category__c\`).
- Count DLP cases by trade: \`SELECT Electrical_Sub_Category__c, COUNT(Id) FROM Case WHERE Subject LIKE '%DLP%' AND Electrical_Sub_Category__c != null GROUP BY Electrical_Sub_Category__c\`

**Sequence 5 — All other eService types** (any other \`eService_Name_Formula__c\` value, including blank)
- Show the default fields.
- If the user asks for additional details, resolve fields by label and query them.

### Resolving fields by label

When the user asks for a detail not covered above (e.g., "show the follow-up date", "what's the penalty amount?"):
1. Describe the Case object via the Salesforce MCP (metadata/describe call, or query \`FieldDefinition\`) to list fields with their labels.
2. Match the user's wording to the closest field **label**, prefer exact/near-exact label matches.
3. Query that API field for the relevant cases and display it with its label.
4. If multiple fields plausibly match, show the candidates and ask the user which one they mean.

## Related record details (Opportunity / Account / Contact from a Case)

From any Case, be able to show and summarize its related records:

- **Opportunity**: via \`Opportunity_Name__c\` (query the Opportunity record: Name, StageName, Amount, CloseDate, Account, and any fields the user asks for).
- **Account**: via \`AccountId\` (Name, Phone, and requested details).
- **Contact**: via \`ContactId\` (Name, Email, Phone, and requested details).

If the direct \`Opportunity_Name__c\` lookup is empty, find the Opportunity through the Case's Account or Contact instead, and say which path was used.

## Summarization

When asked to summarize (e.g., "summarize the complaints for this account"):
- Give counts by Status and by Request Type.
- Highlight open/pending cases first, then recently closed ones.
- Call out anything notable (repeated issue types, long-open cases, high violation amounts).
- Keep the per-case display rules above when listing individual cases inside the summary.

## Output format

- Present case lists as a table with the default columns (plus type-specific columns when a single type dominates the list).
- For a single case, show a compact detail view: default fields first, then the type-specific fields for its sequence.
- Use field **labels** as column headers, never raw API names.
- Format dates in a readable form (e.g., 12 Jul 2026) and amounts with AED where the field is an AED amount.
- If a query returns no cases, say so plainly and mention which relationship paths were checked (direct opportunity lookup, account, contact).

## Practical querying notes

- Use the connected Salesforce MCP tools for all data access (SOQL query / record retrieve / describe). Never fabricate case data.
- Always include \`ParentId = null\` in the WHERE clause unless the user asked for child cases.
- De-duplicate cases when combining the three Opportunity-relationship paths.
- Order results by \`CreatedDate DESC\` unless the user asks otherwise.
- If a custom field in this skill doesn't exist in the org (query error), fall back to describing the object and matching by label, and tell the user which field was unavailable.
`,
  },
]

let seeded = false

async function ensureSeeded(): Promise<void> {
  if (seeded) return
  const existing = await db.select().from(skillFiles).where(eq(skillFiles.active, true))

  if (existing.length > 0) {
    // Auto-update stale built-in skills — compare SEED_DEFAULTS content with DB records.
    // Match by category (handles renamed skills, e.g. old "Case & Service Request Lookup Guide"
    // → new "Salesforce Cases" both have category='case').
    for (const s of SEED_DEFAULTS) {
      const dbRecord = existing.find(e => e.category === s.category)
      if (dbRecord && dbRecord.content !== s.content) {
        await db.update(skillFiles)
          .set({ content: s.content, name: s.name, triggerWords: s.triggerWords })
          .where(eq(skillFiles.id, dbRecord.id))
        console.log(`[skill-files] Updated stale skill: ${s.name} (was "${dbRecord.name}")`)
      }
    }
    seeded = true
    return
  }

  console.log('[skill-files] DB empty — seeding built-in defaults')
  for (const s of SEED_DEFAULTS) {
    await addSkillFile(s.name, s.category, s.triggerWords, s.content)
  }
  seeded = true
}

/**
 * Builds the skill files text block for injection into the MCP system prompt.
 * Uses conditional loading: only includes files matching the query intent.
 * Returns both the text and the list of loaded file names (for streaming to UI).
 */
export async function getSkillFilesPromptText(query?: string): Promise<{ text: string; loadedFiles: string[] }> {
  await ensureSeeded()
  const files = query ? await getMatchingSkillFiles(query) : await getActiveSkillFiles()
  if (files.length === 0) return { text: '', loadedFiles: [] }

  const grouped: Record<string, typeof files> = {}
  for (const f of files) {
    const cat = f.category || 'general'
    if (!grouped[cat]) grouped[cat] = []
    grouped[cat].push(f)
  }

  const sections = Object.entries(grouped).map(([cat, items]) => {
    const header = cat === 'general' ? '' : `[${cat.toUpperCase()}]\n`
    return items.map(f => {
      return `${header}### ${f.name}\n${f.content}`
    }).join('\n\n')
  })

  return {
    text: `\nUSER-DEFINED SKILL FILES (follow these instructions when answering questions):\n\n${sections.join('\n\n---\n\n')}`,
    loadedFiles: files.map(f => f.name),
  }
}
