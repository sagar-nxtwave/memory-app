// RAGAS-style answer evaluation — evaluates answer quality across 4 dimensions:
// 1. Faithfulness: Is the answer grounded in the retrieved data?
// 2. Relevance: Does the answer address the question?
// 3. Context Precision: Is the retrieved context relevant?
// 4. Context Recall: Does the context contain the needed information?

import { chatJson } from '@/lib/ai/provider'

const EVAL_PROMPT = `You are an answer quality evaluator for a CRM assistant.

Evaluate the answer across 4 dimensions (each 0-10):

1. FAITHFULNESS: Is the answer grounded in the provided context?
   - 10: All facts come from context
   - 5: Most facts from context, some inference
   - 0: Answer is fabricated or contradicts context

2. RELEVANCE: Does the answer address the user's question?
   - 10: Directly answers the question
   - 5: Partially relevant
   - 0: Off-topic or wrong question answered

3. CONTEXT PRECISION: Is the retrieved context relevant to the question?
   - 10: Context is highly relevant
   - 5: Context is somewhat relevant
   - 0: Context is irrelevant

4. CONTEXT RECALL: Does the context contain the information needed?
   - 10: Context has all needed info
   - 5: Context has partial info
   - 0: Context has no relevant info

Return JSON:
{
  "faithfulness": <0-10>,
  "relevance": <0-10>,
  "contextPrecision": <0-10>,
  "contextRecall": <0-10>,
  "overall": <0-100 (weighted average)>,
  "issues": ["list of issues if any"]
}

No markdown. Return ONLY valid JSON.`

export interface EvalResult {
  faithfulness: number
  relevance: number
  contextPrecision: number
  contextRecall: number
  overall: number
  issues: string[]
}

export async function evaluateAnswer(
  question: string,
  context: string,
  answer: string
): Promise<EvalResult> {
  const input = `Question: ${question}\n\nContext: ${context.slice(0, 2000)}\n\nAnswer: ${answer.slice(0, 1000)}`

  try {
    const raw = await chatJson(EVAL_PROMPT, input)
    const result = raw as Partial<EvalResult>

    return {
      faithfulness: clamp(result.faithfulness ?? 5),
      relevance: clamp(result.relevance ?? 5),
      contextPrecision: clamp(result.contextPrecision ?? 5),
      contextRecall: clamp(result.contextRecall ?? 5),
      overall: clamp(result.overall ?? 50),
      issues: Array.isArray(result.issues) ? result.issues.slice(0, 5) : [],
    }
  } catch (err) {
    console.warn('[salesforce] answer evaluation failed:', err)
    return {
      faithfulness: 5,
      relevance: 5,
      contextPrecision: 5,
      contextRecall: 5,
      overall: 50,
      issues: ['Evaluation failed'],
    }
  }
}

function clamp(val: number): number {
  return Math.max(0, Math.min(10, Math.round(val)))
}

/**
 * Quick heuristic evaluation (no LLM) for basic quality checks.
 */
export function quickEval(question: string, context: string): { score: number; issues: string[] } {
  const issues: string[] = []
  let score = 10

  // Check if context is empty
  if (!context || context.trim().length === 0) {
    issues.push('No context provided')
    return { score: 0, issues }
  }

  // Check if context contains relevant keywords
  const questionWords = question.toLowerCase().split(/\s+/).filter(w => w.length > 3)
  const contextLower = context.toLowerCase()
  const matches = questionWords.filter(w => contextLower.includes(w))
  const matchRate = questionWords.length > 0 ? matches.length / questionWords.length : 0

  if (matchRate < 0.2) {
    score -= 3
    issues.push('Low keyword overlap between question and context')
  }

  // Check for error patterns
  if (context.includes('error') || context.includes('failed')) {
    score -= 5
    issues.push('Context contains error messages')
  }

  // Check for empty results
  if (context.includes('0 records') || context.includes('No records')) {
    score -= 2
    issues.push('No records found')
  }

  return { score: Math.max(0, score), issues }
}
