import { Mistral } from '@mistralai/mistralai'

// ── Embeddings: Mistral only ────────────────────────────────────────────────
// pgvector is fixed at 1024 dimensions (mistral-embed).
// Changing this model requires re-embedding every document in the DB.
if (!process.env.MISTRAL_API_KEY) throw new Error('MISTRAL_API_KEY is not set')

export const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY })
export const EMBED_MODEL = 'mistral-embed'
export const EMBED_DIMENSIONS = 1024
// Used only for document extraction (JSON mode) — not for chat
export const EXTRACT_MODEL = 'mistral-small-latest'

export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await mistral.embeddings.create({ model: EMBED_MODEL, inputs: [text] })
  return response.data[0].embedding ?? []
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const response = await mistral.embeddings.create({ model: EMBED_MODEL, inputs: texts })
  return response.data.map((d) => d.embedding ?? [])
}

export const RERANK_MODEL = 'mistral-rerank-latest'

/**
 * Rerank chunks by relevance to the query using Mistral's cross-encoder.
 * Returns chunks sorted by rerank score descending, limited to topN.
 * Falls back to original order silently if rerank API fails.
 */
export async function rerankChunks<T extends { content: string }>(
  query: string,
  chunks: T[],
  topN: number
): Promise<T[]> {
  if (chunks.length === 0) return []
  if (chunks.length <= 1) return chunks.slice(0, topN)

  try {
    const response = await fetch('https://api.mistral.ai/v1/rerank', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: RERANK_MODEL,
        query,
        documents: chunks.map(c => c.content),
        top_n: topN,
      }),
    })

    if (!response.ok) {
      console.error('[rerank] API error:', response.status, await response.text().catch(() => ''))
      return chunks.slice(0, topN)
    }

    const data = await response.json()
    const results: { index: number; relevance_score: number }[] = data.results ?? []

    return results.map(r => chunks[r.index]).filter(Boolean)
  } catch (err) {
    console.error('[rerank] Failed, falling back to vector order:', err)
    return chunks.slice(0, topN)
  }
}

// ── Chat: OpenRouter ────────────────────────────────────────────────────────
// Switch models by setting OPENROUTER_CHAT_MODEL in .env.local.
// Recommended: anthropic/claude-haiku-4-5 (fast + cheap + follows instructions well)
//              anthropic/claude-sonnet-4-6 (best quality)
//              mistralai/mistral-large     (cheaper, good quality)
if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set')

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'
export const CHAT_MODEL = process.env.OPENROUTER_CHAT_MODEL ?? 'anthropic/claude-haiku-4-5'

function openRouterHeaders() {
  return {
    'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
    'X-Title': 'Memory',
  }
}

export async function chat(
  systemPrompt: string,
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[] = []
): Promise<string> {
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: openRouterHeaders(),
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: userMessage },
      ],
    }),
  })

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText)
    throw new Error(`OpenRouter error ${res.status}: ${err}`)
  }

  const data = await res.json()
  return data.choices?.[0]?.message?.content ?? ''
}

export async function* chatStream(
  systemPrompt: string,
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[] = []
): AsyncGenerator<string> {
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: openRouterHeaders(),
    body: JSON.stringify({
      model: CHAT_MODEL,
      stream: true,
      messages: [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: userMessage },
      ],
    }),
  })

  if (!res.ok || !res.body) {
    const err = await res.text().catch(() => res.statusText)
    throw new Error(`OpenRouter stream error ${res.status}: ${err}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6).trim()
      if (payload === '[DONE]') return
      try {
        const event = JSON.parse(payload)
        const delta = event.choices?.[0]?.delta?.content
        if (typeof delta === 'string' && delta) yield delta
      } catch {}
    }
  }
}
