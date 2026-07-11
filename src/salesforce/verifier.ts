import { chatJson } from '@/lib/ai/provider'
import { recordMetric } from './observability'

// Real-time answer verification layer — runs BEFORE returning to user.
// Checks: (1) does the data answer the question? (2) is it complete? (3) any anomalies?

export interface VerificationResult {
  confidence: 'high' | 'medium' | 'low'
  score: number // 0-100
  issues: string[]
  recommendation: 'return' | 'clarify' | 'retry'
  refinedAnswer?: string
}

const VERIFICATION_PROMPT = `You are a CRM answer quality verifier. A user asked a question about their Salesforce CRM, and the system fetched data. Your job is to evaluate whether the returned data ACTUALLY answers the user's question correctly and completely.

You will receive:
1. The original user question
2. The SOQL query that was executed
3. The raw data returned

Evaluate on these criteria:
- RELEVANCE: Does the data relate to what was asked? (0-30 points)
- COMPLETENESS: Does the data fully answer the question, or is it partial? (0-30 points)
- ACCURACY: Does the data make logical sense? Any obvious errors? (0-20 points)
- CLARITY: Is the data formatted clearly enough to understand? (0-20 points)

Return ONLY JSON:
{
  "score": <0-100>,
  "confidence": "high" | "medium" | "low",
  "issues": ["list of any issues found"],
  "recommendation": "return" | "clarify" | "retry",
  "refinedAnswer": null | "<if recommendation is 'clarify', suggest what to ask the user>"
}

Rules:
- Score >= 70: confidence = "high", recommendation = "return"
- Score 40-69: confidence = "medium", recommendation = "return" (but note issues)
- Score < 40: confidence = "low", recommendation = "clarify" or "retry"
- If the question asks for a COUNT but data shows raw records (not aggregated), that's an issue
- If the question asks about a specific person/community but data shows all records, that's an issue
- If data is empty (0 records) but the question implies there should be data, that's an issue
- If the SOQL query doesn't match the question intent, that's a critical issue`

export async function verifyAnswer(
  question: string,
  soqlQuery: string | null,
  rawContext: string,
  method: string,
): Promise<VerificationResult> {
  try {
    const input = `User Question: ${question}\nSOQL Executed: ${soqlQuery || 'N/A (used pre-built tool)'}\nMethod: ${method}\nRaw Data Returned:\n${rawContext.slice(0, 3000)}`

    const raw = await chatJson(VERIFICATION_PROMPT, input)
    let result: Record<string, unknown> = {}
    try {
      result = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>)
    } catch {
      console.warn('[verifier] Failed to parse verification response')
      return { confidence: 'medium', score: 50, issues: ['Failed to parse verification response'], recommendation: 'return' }
    }

    if (result && typeof result.score === 'number') {
      const score = Math.min(100, Math.max(0, result.score as number))
      const confidence = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low'
      const recommendation = score >= 40 ? 'return' : ((result.issues as string[])?.length > 0 ? 'clarify' : 'retry')

      return {
        confidence,
        score,
        issues: (result.issues as string[]) || [],
        recommendation,
        refinedAnswer: (result.refinedAnswer as string) || undefined,
      }
    }

    // Fallback: if verification fails, still return the data (don't block valid answers)
    console.warn('[verifier] Verification returned invalid result, defaulting to medium confidence')
    return { confidence: 'medium', score: 50, issues: ['Verification returned invalid result'], recommendation: 'return' }
  } catch (err) {
    console.error('[verifier] Verification failed:', err)
    // Don't block answers if verification fails — just log and return medium confidence
    return { confidence: 'medium', score: 50, issues: ['Verification failed'], recommendation: 'return' }
  }
}

// Quick heuristic check (no LLM call) — fast pre-filter before full verification
export function quickCheck(
  question: string,
  context: string,
  method: string,
): { ok: boolean; issue?: string } {
  const q = question.toLowerCase()

  // Check 1: If question asks for count, verify response has a number
  if (q.includes('how many') || q.includes('count') || q.includes('total')) {
    if (!/\d+/.test(context)) {
      return { ok: false, issue: 'Question asks for count but response has no numbers' }
    }
  }

  // Check 2: If question asks about a specific person/community, verify it's filtered
  const namePatterns = [
    /(?:about|for|named?|called?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/,
    /(?:salesperson|agent|person)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/,
  ]
  for (const pattern of namePatterns) {
    const match = q.match(pattern)
    if (match && match[1]) {
      const name = match[1].toLowerCase()
      // Check if the name appears in the context (it should be filtered)
      if (context.toLowerCase().includes('record(s) matched') && !context.toLowerCase().includes(name)) {
        return { ok: false, issue: `Question asks about "${match[1]}" but results don't seem filtered` }
      }
    }
  }

  // Check 3: If method is catch-all, flag as lower confidence
  if (method === 'catch-all' || method === 'fallback') {
    return { ok: true, issue: 'Used catch-all fallback — answer may be less precise' }
  }

  // Check 4: Empty results
  if (context.includes('0 record(s) matched') || context.includes('No matching records')) {
    return { ok: true, issue: 'No records found — this may be correct or may indicate a query issue' }
  }

  return { ok: true }
}
