import { z } from 'zod'
import { chatJson } from './provider'

/**
 * Structured JSON completion via chatJson + Zod validation.
 * 
 * Calls chatJson() to get raw JSON from the LLM, then validates against the
 * provided Zod schema. Throws with a descriptive error on validation failure.
 */
export async function chatJsonStructured<T>(
  systemPrompt: string,
  userMessage: string,
  schema: { schema: z.ZodType<T>; name: string },
): Promise<T> {
  const raw = await chatJson(systemPrompt, userMessage)
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`Failed to parse JSON from LLM for ${schema.name}: ${raw.slice(0, 200)}`)
  }
  const parsed = schema.schema.safeParse(data)
  if (!parsed.success) {
    throw new Error(`Zod validation failed for ${schema.name}: ${parsed.error.message}`)
  }
  return parsed.data
}
