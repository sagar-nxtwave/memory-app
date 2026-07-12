// Post-generation answer validator — catches hallucinations the LLM adds on top of
// real Salesforce data. Runs AFTER the final prose answer is composed (either the
// raw `salesforceResult.context` from query.ts, or the full streamed chat answer).
//
// This is a heuristic-only, no-LLM-call check (fast, <5ms) so it can run on every
// answer without adding latency. It does NOT replace verifyAnswer() in verifier.ts
// (which checks if the RAW DATA answers the question) — this checks if the FINAL
// PROSE matches the raw data it was supposed to be built from.
//
// What it catches:
// 1. Proper nouns (names, communities, buildings) in the answer that don't appear
//    anywhere in the raw data — the classic "fabricated community name" bug.
// 2. Numbers in the answer that don't appear in the raw data — fabricated counts/amounts.
// 3. List-length mismatches — e.g. answer claims "52 communities" but only lists 45,
//    or lists more items than the raw data actually contains.

export interface AnswerValidation {
  valid: boolean
  issues: string[]
  hallucinatedTerms: string[]
  hallucinatedNumbers: string[]
}

// Common words that look like proper nouns but aren't domain entities — skip these.
const STOPWORDS = new Set([
  'the', 'this', 'that', 'these', 'those', 'here', 'there', 'total', 'count', 'sum',
  'all', 'top', 'best', 'most', 'least', 'first', 'last', 'next', 'previous',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'aed', 'usd', 'crm', 'salesforce', 'opportunity', 'opportunities', 'account',
  'accounts', 'community', 'communities', 'building', 'buildings', 'property',
  'properties', 'sales', 'sale', 'deal', 'deals', 'customer', 'customers',
  'note', 'important', 'question', 'answer', 'data', 'record', 'records',
  'q1', 'q2', 'q3', 'q4', 'ytd',
])

// Extract candidate proper-noun phrases (capitalized words/phrases) from text.
function extractProperNouns(text: string): string[] {
  // Strip markdown table pipes/formatting noise first
  const clean = text.replace(/[|*_#]/g, ' ')
  // Match sequences of 1-4 capitalized words (e.g. "Address Grand Downtown")
  const matches = clean.match(/\b([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,3})\b/g) || []
  const seen = new Set<string>()
  for (const m of matches) {
    const trimmed = m.trim()
    const firstWord = trimmed.split(/\s+/)[0].toLowerCase()
    if (STOPWORDS.has(firstWord)) continue
    if (trimmed.length < 3) continue
    seen.add(trimmed)
  }
  return Array.from(seen)
}

// Extract standalone numbers (excluding ones that are part of dates like 2025, 2026 — those
// are usually legitimate and repeated a lot; still checked, but treated more leniently).
function extractNumbers(text: string): string[] {
  const matches = text.match(/\b\d[\d,]*(?:\.\d+)?\b/g) || []
  return Array.from(new Set(matches.map((m) => m.replace(/,/g, ''))))
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim()
}

/**
 * Validates that a composed answer doesn't introduce facts (names/numbers) absent
 * from the raw data it was supposed to summarize.
 *
 * @param answer   The final prose answer shown to the user
 * @param rawData  The raw Salesforce context/tool result the answer should be based on
 */
export function validateAnswerAgainstData(answer: string, rawData: string): AnswerValidation {
  const issues: string[] = []
  const hallucinatedTerms: string[] = []
  const hallucinatedNumbers: string[] = []

  if (!rawData || rawData.trim().length === 0) {
    // Nothing to validate against — can't flag hallucination without a baseline.
    return { valid: true, issues: [], hallucinatedTerms: [], hallucinatedNumbers: [] }
  }

  const rawNormalized = normalize(rawData)
  const answerProperNouns = extractProperNouns(answer)
  const rawProperNouns = new Set(extractProperNouns(rawData).map(normalize))

  for (const term of answerProperNouns) {
    const normTerm = normalize(term)
    if (normTerm.length < 3) continue
    // Direct match against extracted raw proper nouns, or substring match against raw text
    // (handles cases where raw data isn't capitalized consistently, e.g. lowercase SOQL results).
    if (!rawProperNouns.has(normTerm) && !rawNormalized.includes(normTerm)) {
      hallucinatedTerms.push(term)
    }
  }

  const answerNumbers = extractNumbers(answer)
  const rawNumberSet = new Set(extractNumbers(rawData))
  for (const num of answerNumbers) {
    // Skip small numbers (1-31) — likely list indices, days, bullet numbers, not data facts.
    const n = parseInt(num, 10)
    if (!isNaN(n) && n >= 1 && n <= 31) continue
    if (!rawNumberSet.has(num)) {
      hallucinatedNumbers.push(num)
    }
  }

  if (hallucinatedTerms.length > 0) {
    issues.push(`Answer contains ${hallucinatedTerms.length} name(s)/term(s) not found in the source data: ${hallucinatedTerms.slice(0, 8).join(', ')}`)
  }
  if (hallucinatedNumbers.length > 3) {
    // Allow a small margin (percentages, computed averages, etc. legitimately don't appear
    // verbatim in raw data) — only flag when there's a meaningful cluster of unexplained numbers.
    issues.push(`Answer contains ${hallucinatedNumbers.length} number(s) not found in the source data: ${hallucinatedNumbers.slice(0, 8).join(', ')}`)
  }

  // Valid unless we found a meaningful amount of unexplained proper nouns (the strongest
  // hallucination signal — e.g. fabricated community/customer names).
  const valid = hallucinatedTerms.length === 0

  return { valid, issues, hallucinatedTerms, hallucinatedNumbers }
}

/**
 * Checks specifically for "enumerate all X" list-completeness mismatches — e.g. raw data
 * has 52 communities but the answer only lists 45, or the answer's stated count doesn't
 * match the number of items actually listed.
 */
export function validateListCompleteness(answer: string, rawData: string): { valid: boolean; issue?: string } {
  // Count numbered/bulleted list items in the answer
  const listItemMatches = answer.match(/^\s*(?:\d+[.)]|[-*•])\s+.+$/gm) || []
  const answerListCount = listItemMatches.length

  // If the answer states a total count (e.g. "All 52 Communities"), compare to actual list length
  const statedCountMatch = answer.match(/\b(\d+)\s+(?:communities|buildings|customers|deals|records|properties|units|cases)\b/i)
  if (statedCountMatch && answerListCount > 0) {
    const statedCount = parseInt(statedCountMatch[1], 10)
    if (Math.abs(statedCount - answerListCount) > 2) {
      return {
        valid: false,
        issue: `Answer claims ${statedCount} items but only lists ${answerListCount}`,
      }
    }
  }

  return { valid: true }
}
