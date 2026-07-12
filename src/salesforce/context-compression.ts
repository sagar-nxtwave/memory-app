// Context compression — summarize/filter long results to fit within token limits.
// Removes redundant information and keeps only the most useful data.

import { chatJson } from '@/lib/ai/provider'

const COMPRESSION_PROMPT = `You are a context compression engine for CRM data.

Given a raw CRM data result, compress it to keep ONLY the most important information.

Rules:
- Keep all key numbers (counts, amounts, percentages)
- Remove redundant/empty fields
- For lists, keep top 5-10 items + summary
- For breakdowns, keep all categories with counts
- For individual records, keep name + key fields only
- Never fabricate data — only compress what's there
- If data is already concise (< 500 chars), return as-is

Format the compressed output as clean, readable text (not raw field names).
Use "AED X" format for currency.
Use "X%" for percentages.
Use natural language labels instead of field names.

Return ONLY the compressed text, no JSON needed.`

const MAX_CHARS = 3000 // Compress if result exceeds this

export async function compressContext(rawContext: string): Promise<string> {
  // Skip compression if already short
  if (rawContext.length <= MAX_CHARS) {
    return rawContext
  }

  try {
    const raw = await chatJson(
      COMPRESSION_PROMPT + '\n\nReturn JSON: {"compressed": "your compressed text here"}',
      rawContext
    )
    const result = raw as { compressed?: string }

    if (result?.compressed && result.compressed.length < rawContext.length) {
      console.log(`[salesforce] context compressed: ${rawContext.length} → ${result.compressed.length} chars`)
      return result.compressed
    }

    return rawContext
  } catch (err) {
    console.warn('[salesforce] context compression failed:', err)
    return rawContext
  }
}

/**
 * Simple rule-based compression for common patterns (no LLM needed).
 */
export function quickCompress(context: string): string {
  let compressed = context

  // Remove empty lines and normalize whitespace
  compressed = compressed.replace(/\n{3,}/g, '\n\n').trim()

  // If still too long, truncate with summary
  if (compressed.length > MAX_CHARS) {
    const lines = compressed.split('\n')
    const kept = lines.slice(0, 20)
    const total = lines.length
    compressed = kept.join('\n') + `\n\n... and ${total - 20} more records`
  }

  return compressed
}
