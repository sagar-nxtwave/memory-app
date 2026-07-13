// Follow-up Suggestions — generates 2-3 natural follow-up questions after each answer.
// Makes the AI feel proactive and guides the user toward deeper exploration.
// Feature-flagged: set NEXT_PUBLIC_FEATURE_FOLLOW_UP_SUGGESTIONS=false to disable.

import { chatJson } from '@/lib/ai/provider'

const SUGGESTIONS_PROMPT = `You are a CRM assistant for Nshama, a Dubai real estate developer. Based on the user's question and the answer provided, suggest 2-3 natural follow-up questions the user might want to ask next.

RULES:
1. Suggestions should be SPECIFIC to the data in the answer (not generic)
2. Each suggestion should be a complete, natural question (not fragments)
3. Focus on: drilling down, comparing, trending, breaking down further
4. Keep each suggestion under 15 words
5. Don't repeat the original question or obvious rephrases

Return ONLY JSON:
{
  "suggestions": ["question 1", "question 2", "question 3"]
}`

export async function generateFollowUpSuggestions(
  question: string,
  answer: string,
): Promise<string[]> {
  try {
    const input = `User asked: ${question}\n\nAnswer provided:\n${answer.slice(0, 2000)}\n\nSuggest 2-3 natural follow-up questions.`
    const raw = await chatJson(SUGGESTIONS_PROMPT, input)
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    const suggestions = Array.isArray(parsed?.suggestions) ? parsed.suggestions : []
    return suggestions
      .filter((s: unknown): s is string => typeof s === 'string' && s.length > 5)
      .slice(0, 3)
  } catch (err) {
    console.warn('[follow-up] Failed to generate suggestions:', err)
    return []
  }
}
