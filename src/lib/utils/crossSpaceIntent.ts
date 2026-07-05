/**
 * Detects when a question asked inside one space's chat actually wants content from
 * ANOTHER space or another space's document ("compare this to Space B", "how does this
 * differ from the Sea Gardens vendor doc"). Lets per-space chat pull in the other space's
 * documents and answer inline, instead of forcing the user to go to Ask All Spaces.
 */

const COMPARE_INTENT = /\b(compare|comparison|compared to|vs\.?|versus|difference between|differs? from|different from|against each other|relative to|how does .* (compare|differ))\b/i

export function hasCrossSpaceIntent(query: string): boolean {
  return COMPARE_INTENT.test(query)
}

export interface SpaceCandidate { type: 'space'; id: string; name: string }
export interface DocCandidate { type: 'doc'; id: string; name: string; spaceId: string; spaceName: string }
export type CrossSpaceCandidate = SpaceCandidate | DocCandidate

function normalizeWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/([a-z])(\d)/g, '$1 $2') // "plot77" -> "plot 77" (handles no-space typing like "@plot77")
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

// Users say "plot 77" when the actual space is named "Plot 77 NSH" — shorthand, not the
// full name. Matching only "does the query contain the full name" misses this entirely.
// Fix: also match when a 2+-word phrase from the query is a PREFIX of the name's words
// (handles the common "Plot 77" / "Plot 77 NSH" pattern) — a single-word overlap like just
// "plot" is intentionally NOT enough, or "Plot 77" would collide with "Plot 84 NSH" too.
function fuzzyNameMatch(queryWords: string[], name: string): boolean {
  const nameWords = normalizeWords(name)
  if (nameWords.length === 0) return false
  const nameNorm = nameWords.join(' ')
  if (nameNorm.length < 3) return false

  const queryNorm = queryWords.join(' ')
  if (queryNorm.includes(nameNorm)) return true // full name present verbatim in the query

  for (let start = 0; start < queryWords.length; start++) {
    for (let len = 2; len <= Math.min(nameWords.length, queryWords.length - start); len++) {
      const phrase = queryWords.slice(start, start + len).join(' ')
      if (nameNorm === phrase || nameNorm.startsWith(`${phrase} `)) return true
    }
  }
  return false
}

// Matches other spaces mentioned by name (full or shorthand-prefix) in free text.
export function findMentionedSpaces(
  query: string,
  spaces: { id: string; name: string }[],
  excludeSpaceId: string
): SpaceCandidate[] {
  const queryWords = normalizeWords(query)
  return spaces
    .filter((s) => s.id !== excludeSpaceId && fuzzyNameMatch(queryWords, s.name))
    .map((s) => ({ type: 'space' as const, id: s.id, name: s.name }))
}

// Matches documents mentioned by name (full or shorthand-prefix). Pass excludeSpaceId to
// only match OTHER spaces' docs (cross-space detection); omit it to match docs in any
// space (used for same-space "tell me about [exact filename]" detection too).
export function findMentionedDocs(
  query: string,
  docs: { id: string; name: string; spaceId: string; spaceName: string }[],
  excludeSpaceId?: string
): DocCandidate[] {
  const queryWords = normalizeWords(query)
  return docs
    .filter((d) => d.spaceId !== excludeSpaceId && fuzzyNameMatch(queryWords, d.name))
    .map((d) => ({ type: 'doc' as const, id: d.id, name: d.name, spaceId: d.spaceId, spaceName: d.spaceName }))
}

export function formatCandidate(c: CrossSpaceCandidate): string {
  return c.type === 'space' ? `"${c.name}" (a project)` : `"${c.name}" (a document in "${c.spaceName}")`
}
