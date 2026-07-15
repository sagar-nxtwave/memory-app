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

// ─── SKILL FILES ──────────────────────────────────────────────────────────────
// No built-in seed defaults. All skills are user-managed via the Settings UI.
// The DB is the single source of truth — no auto-update, no overwriting.

let seeded = false

/**
 * Deletes ALL skill files from the database.
 * Used during deployment to ensure a clean slate.
 */
export async function deleteAllSkillFiles(): Promise<void> {
  await db.delete(skillFiles)
  seeded = false
  console.log('[skill-files] Deleted all skill files from DB')
}

async function ensureSeeded(): Promise<void> {
  if (seeded) return
  seeded = true
  // Delete all existing skills on startup to ensure clean slate
  const existing = await db.select().from(skillFiles)
  if (existing.length > 0) {
    await db.delete(skillFiles)
    console.log(`[skill-files] Cleared ${existing.length} stale skills from DB on startup`)
  }
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
