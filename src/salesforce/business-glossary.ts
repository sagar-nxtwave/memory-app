// Business Glossary — editable business-term-to-schema mappings, backed by the database
// (Vercel's serverless filesystem doesn't persist writes reliably, unlike the JSON-file
// pattern used for synonyms). Injected into the MCP prompt so the LLM understands the
// client's own terminology (e.g. "Customer" -> Account, "Unit" -> Opportunity.Name).
import { db } from '@/lib/db'
import { glossaryTerms } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const LLM_RULES_FILE = join(process.cwd(), 'data', 'llm-rules.json')

interface LlmRuleField {
  fieldApiName: string
  businessMeaning: string
  semanticCategory: string
  llmInterpretationAndUsage: string
  sensitiveClassification: string
  importantRules: string
}

interface LlmRuleObject {
  objectDescription: string
  fieldCount: number
  fields: LlmRuleField[]
}

type LlmRulesFile = Record<string, LlmRuleObject>

let cachedLlmRules: LlmRulesFile | null = null

function loadLlmRules(): LlmRulesFile {
  if (cachedLlmRules) return cachedLlmRules
  if (!existsSync(LLM_RULES_FILE)) {
    cachedLlmRules = {}
    return cachedLlmRules
  }
  try {
    cachedLlmRules = JSON.parse(readFileSync(LLM_RULES_FILE, 'utf-8'))
  } catch {
    cachedLlmRules = {}
  }
  return cachedLlmRules!
}

export interface GlossaryTerm {
  id: string
  term: string
  mapsTo: string
  explanation: string
}

// Seed glossary — the cross-object business-term mappings that caused real client
// confusion (e.g. "who is customer of Safi v-6" failing because the LLM searched
// Property_Inventory__c instead of Opportunity). Seeded into the DB once on first use;
// editable via Settings → Business Glossary afterward.
const SEED_TERMS: Omit<GlossaryTerm, 'id'>[] = [
  {
    term: 'Customer',
    mapsTo: 'Account (via Opportunity.Account.Name) or Contact',
    explanation: 'When asked "who is the customer of unit/deal X", the customer is found by looking up the Opportunity for that unit and reading Account.Name — NOT by searching Property_Inventory__c or Account directly by unit code (Property_Inventory__c has no customer link; the sale/Opportunity is what links a unit to its buyer).',
  },
  {
    term: 'Unit / Property code (e.g. "Safi V-6", "TS SAF TH-V-6")',
    mapsTo: 'Opportunity.Name (the deal/transaction code), fuzzy-matched',
    explanation: 'Unit codes as typed by users rarely match Property_Inventory__c.Name exactly (spacing, casing, abbreviations differ). ALWAYS search Opportunity.Name with LIKE (e.g. "%SAF%V-6%" or "%SAF TH-V-6%") FIRST when the question is about a specific unit\'s sale/customer — Opportunity.Name contains the actual unit code as part of the deal code. Only fall back to Property_Inventory__c if the question is purely about physical unit attributes (size, status, price) with no customer/sale context.',
  },
  {
    term: 'Sales / Sold',
    mapsTo: 'Opportunity where IsWon = true',
    explanation: 'Unless the user explicitly asks about "pipeline", "lost deals", or "all deals", "sales" means Closed Won Opportunities only.',
  },
  {
    term: 'Community / Project',
    mapsTo: 'Property_Inventory__c.Building_Community__c (for listing/counting communities) or Opportunity.Building_Name__c (for sales grouped by project)',
    explanation: 'Property_Inventory__c.Building_Community__c is the reliable, 100%-populated field for "list all communities" questions. For sales/revenue GROUP BY questions, use Opportunity.Building_Name__c instead (Building_Community__c cannot be grouped on Opportunity due to a Salesforce platform restriction on that object).',
  },
  {
    term: 'Company background / "who are they" / external info',
    mapsTo: 'NOT in Salesforce — this requires web search',
    explanation: 'Questions asking what a company DOES, its industry, website, or general business background (as opposed to their deals/transactions IN our CRM) are NOT answerable from Salesforce data — Account records only store transactional/contact fields, not company profile information. Say so plainly and suggest the user ask with web search enabled, rather than implying the data might exist somewhere else in the CRM.',
  },
]

/** Seeds the DB with default terms once per serverless instance lifetime (first call only).
 *  After that, user deletions are respected — re-seeding only happens on a fresh cold start. */
let glossarySeeded = false
async function ensureSeeded(): Promise<void> {
  if (glossarySeeded) return
  glossarySeeded = true
  const existing = await db.select({ id: glossaryTerms.id }).from(glossaryTerms).limit(1)
  if (existing.length > 0) return
  await db.insert(glossaryTerms).values(SEED_TERMS)
}

export async function getCustomGlossaryTerms(): Promise<GlossaryTerm[]> {
  await ensureSeeded()
  const rows = await db.select().from(glossaryTerms).orderBy(glossaryTerms.createdAt)
  return rows.map((r) => ({ id: r.id, term: r.term, mapsTo: r.mapsTo, explanation: r.explanation }))
}

export async function addGlossaryTerm(term: string, mapsTo: string, explanation: string): Promise<GlossaryTerm> {
  const [row] = await db.insert(glossaryTerms).values({ term, mapsTo, explanation }).returning()
  return { id: row.id, term: row.term, mapsTo: row.mapsTo, explanation: row.explanation }
}

export async function updateGlossaryTerm(id: string, term: string, mapsTo: string, explanation: string): Promise<GlossaryTerm | null> {
  const [row] = await db
    .update(glossaryTerms)
    .set({ term, mapsTo, explanation, updatedAt: new Date() })
    .where(eq(glossaryTerms.id, id))
    .returning()
  return row ? { id: row.id, term: row.term, mapsTo: row.mapsTo, explanation: row.explanation } : null
}

export async function deleteGlossaryTerm(id: string): Promise<void> {
  await db.delete(glossaryTerms).where(eq(glossaryTerms.id, id))
}

function summarizeLlmRulesForObject(objectName: string, obj: LlmRuleObject): string {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const f of obj.fields) {
    if (!f.businessMeaning && !f.importantRules) continue // skip empty/placeholder rows from extraction
    const key = f.fieldApiName
    if (seen.has(key)) continue // dedupe repeated field entries (extraction artifact)
    seen.add(key)
    const parts = [f.businessMeaning, f.importantRules].filter(Boolean)
    lines.push(`  - ${f.fieldApiName}: ${parts.join(' | ')}`)
  }
  if (lines.length === 0) return ''
  const desc = obj.objectDescription ? obj.objectDescription.split('.')[0] + '.' : ''
  return `${objectName}${desc ? ` — ${desc}` : ''}\n${lines.join('\n')}`
}

/**
 * Returns a compact, prompt-ready business glossary combining the client's own field
 * definitions (llm-rules.json, read-only) with editable cross-object term mappings
 * (from the DB). Used by mcp-query.ts and reusable by the tool-matcher/synonyms layer.
 */
export async function getBusinessGlossaryText(objectFilter?: string[]): Promise<string> {
  const rules = loadLlmRules()
  const customTerms = await getCustomGlossaryTerms()

  const objectSections: string[] = []
  for (const [objectName, obj] of Object.entries(rules)) {
    if (objectFilter && !objectFilter.includes(objectName)) continue
    const summary = summarizeLlmRulesForObject(objectName, obj)
    if (summary) objectSections.push(summary)
  }

  const termSections = customTerms.map((t) => `- "${t.term}" → ${t.mapsTo}\n  ${t.explanation}`)

  const parts: string[] = []
  if (termSections.length > 0) {
    parts.push(`BUSINESS TERMINOLOGY (how casual business terms map to Salesforce schema):\n${termSections.join('\n')}`)
  }
  if (objectSections.length > 0) {
    parts.push(`FIELD-LEVEL BUSINESS DEFINITIONS (from client's own data dictionary):\n${objectSections.join('\n\n')}`)
  }
  return parts.join('\n\n')
}
