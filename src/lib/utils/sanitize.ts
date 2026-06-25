// Prevent prompt injection from document content
const INJECTION_PATTERNS = [
  /ignore (previous|all|above) instructions/gi,
  /system prompt/gi,
  /you are now/gi,
  /forget everything/gi,
  /new instructions/gi,
  /\[INST\]/gi,
  /<<SYS>>/gi,
]

export function sanitizeForPrompt(text: string): string {
  let sanitized = text
  for (const pattern of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]')
  }
  return sanitized
}

export function truncateToTokenLimit(text: string, maxChars = 12000): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + '...[truncated]'
}
