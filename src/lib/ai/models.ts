// ── Available LLM models for user selection ───────────────────────────────────
// Kept separate from provider.ts to avoid pulling server-side dependencies
// (sharp, child_process) into client bundles.

export const LLM_MODELS = [
  { id: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4', provider: 'Anthropic' },
  { id: 'anthropic/claude-haiku-4-5', name: 'Claude Haiku 4', provider: 'Anthropic' },
  { id: 'mistralai/mistral-large', name: 'Mistral Large', provider: 'Mistral' },
  { id: 'google/gemini-2.5-pro-preview', name: 'Gemini 2.5 Pro', provider: 'Google' },
  { id: 'openai/gpt-4o', name: 'GPT-4o', provider: 'OpenAI' },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', provider: 'OpenAI' },
] as const

export type LlmModelId = (typeof LLM_MODELS)[number]['id']
