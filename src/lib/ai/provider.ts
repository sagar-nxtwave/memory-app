// ── OpenRouter (paid key) — chat, rerank, vision, and embeddings all route through here.
// Mistral's own API is used ONLY for OCR (src/lib/parsers/index.ts) — that's a dedicated
// product with no OpenRouter equivalent. Everything else that could hit the Mistral account
// directly (chat, extraction, embeddings) has been moved to OpenRouter specifically to avoid
// depending on that account's (free-tier) rate limits.
if (!process.env.OPENROUTER_API_KEY) {
  console.warn('[provider] OPENROUTER_API_KEY is not set — LLM calls will fail at runtime')
}

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'

function openRouterHeaders() {
  return {
    'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
    'X-Title': 'Memory',
  }
}

// ── Embeddings ───────────────────────────────────────────────────────────────
// pgvector is fixed at 1024 dimensions (mistral-embed's output size). Routed through
// OpenRouter now, but it's still the same underlying Mistral model/weights — output vectors
// are unchanged, so this is safe alongside anything already embedded via the old direct path.
// Changing to a DIFFERENT model (not just a different proxy for the same one) still requires
// re-embedding every document in the DB.
export const EMBED_MODEL = process.env.OPENROUTER_EMBED_MODEL ?? 'mistralai/mistral-embed-2312'
export const EMBED_DIMENSIONS = 1024

// Mistral's embed API (via OpenRouter) silently DROPS inputs beyond a per-request array-size
// limit — it returns fewer embeddings than sent, with no error. Observed live: 1138 inputs →
// 1042 embeddings. tokenBatches() upstream caps by tokens only, so a spreadsheet of many tiny
// row-chunks can pack hundreds of inputs into one request and trip this. Cap request size by
// COUNT here as the real fix; the alignment/retry logic below is the safety net.
const MAX_EMBED_INPUTS_PER_REQUEST = 64

async function fetchEmbeddingsRaw(inputs: string[]): Promise<(number[] | undefined)[]> {
  const res = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: 'POST',
    headers: openRouterHeaders(),
    body: JSON.stringify({ model: EMBED_MODEL, input: inputs }),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText)
    throw new Error(`OpenRouter embeddings error ${res.status}: ${err}`)
  }
  const data = await res.json()
  const rows: { embedding: number[]; index: number }[] = data.data ?? []
  // Place each returned embedding at its ORIGINAL input position via the `index` field —
  // never .sort().map(), which silently collapses/misaligns when rows are missing.
  const out: (number[] | undefined)[] = new Array(inputs.length).fill(undefined)
  for (const r of rows) {
    if (r.index >= 0 && r.index < inputs.length) out[r.index] = r.embedding
  }
  return out
}

async function fetchEmbeddings(inputs: string[]): Promise<number[][]> {
  const result: (number[] | undefined)[] = new Array(inputs.length).fill(undefined)

  // First pass: request in count-capped sub-batches.
  for (let i = 0; i < inputs.length; i += MAX_EMBED_INPUTS_PER_REQUEST) {
    const slice = inputs.slice(i, i + MAX_EMBED_INPUTS_PER_REQUEST)
    const embeddings = await fetchEmbeddingsRaw(slice)
    for (let j = 0; j < slice.length; j++) result[i + j] = embeddings[j]
  }

  // Safety net: retry any positions the provider still dropped, one at a time so a single
  // problematic input can't take down its neighbours. Give each a couple of attempts.
  for (let attempt = 0; attempt < 2; attempt++) {
    const missing = result.flatMap((e, idx) => (e === undefined ? [idx] : []))
    if (missing.length === 0) break
    for (const idx of missing) {
      const [embedding] = await fetchEmbeddingsRaw([inputs[idx]])
      if (embedding) result[idx] = embedding
    }
  }

  const stillMissing = result.filter((e) => e === undefined).length
  if (stillMissing > 0) {
    throw new Error(`Embedding provider dropped ${stillMissing}/${inputs.length} inputs after retries`)
  }
  return result as number[][]
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const [embedding] = await fetchEmbeddings([text])
  return embedding ?? []
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  return fetchEmbeddings(texts)
}

export const RERANK_MODEL = process.env.OPENROUTER_RERANK_MODEL ?? 'cohere/rerank-v3.5'

/**
 * Rerank chunks via OpenRouter's /rerank endpoint.
 * Falls back to hybrid score order silently if the API call fails.
 */
export async function rerankChunks<T extends { content: string }>(
  query: string,
  chunks: T[],
  topN: number
): Promise<T[]> {
  if (chunks.length === 0) return []
  if (chunks.length <= 1) return chunks.slice(0, topN)

  try {
    const response = await fetch('https://openrouter.ai/api/v1/rerank', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
        'X-Title': 'Memory',
      },
      body: JSON.stringify({
        model: RERANK_MODEL,
        query,
        documents: chunks.map(c => c.content),
        top_n: topN,
      }),
    })

    if (!response.ok) {
      return chunks.slice(0, topN)
    }

    const data = await response.json()
    const results: { index: number; relevance_score: number }[] = data.results ?? []
    if (results.length === 0) return chunks.slice(0, topN)
    return results.map(r => chunks[r.index]).filter(Boolean)
  } catch {
    return chunks.slice(0, topN)
  }
}

/**
 * Like rerankChunks but returns the relevance score alongside each item, so callers can
 * threshold out weakly-relevant results (e.g. don't cite an internal doc that has nothing to
 * do with the question). Fails open: on error, returns items with score Infinity so they pass
 * any threshold rather than being wrongly dropped.
 */
export async function rerankWithScores<T extends { content: string }>(
  query: string,
  chunks: T[],
  topN: number
): Promise<{ item: T; score: number }[]> {
  if (chunks.length === 0) return []

  try {
    const response = await fetch('https://openrouter.ai/api/v1/rerank', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
        'X-Title': 'Memory',
      },
      body: JSON.stringify({ model: RERANK_MODEL, query, documents: chunks.map(c => c.content), top_n: topN }),
    })
    if (!response.ok) return chunks.slice(0, topN).map(item => ({ item, score: Infinity }))
    const data = await response.json()
    const results: { index: number; relevance_score: number }[] = data.results ?? []
    if (results.length === 0) return chunks.slice(0, topN).map(item => ({ item, score: Infinity }))
    return results.map(r => ({ item: chunks[r.index], score: r.relevance_score })).filter(r => r.item)
  } catch {
    return chunks.slice(0, topN).map(item => ({ item, score: Infinity }))
  }
}

// ── Chat: OpenRouter ────────────────────────────────────────────────────────
// Switch models by setting OPENROUTER_CHAT_MODEL in .env.local.
// Recommended: anthropic/claude-sonnet-4-6 (best quality)
//              anthropic/claude-haiku-4-5 (fast + cheap + follows instructions well)
//              mistralai/mistral-large     (cheaper, good quality)
export const CHAT_MODEL = process.env.OPENROUTER_CHAT_MODEL ?? 'anthropic/claude-sonnet-4-6'

// ── PDF/OCR parsing via OpenRouter's file-parser plugin ─────────────────────
// No direct Mistral API key used anywhere in this file — OpenRouter's "mistral-ocr" engine
// is OpenRouter's own backend relationship, billed to the OpenRouter (paid) account, not ours.
// Trade-off vs the old direct-Mistral-OCR integration (accepted deliberately): no per-page
// boundaries, no bounding-box/page-dimension data, and the plugin caps extracted images at
// 8 per REQUEST — mitigated by feeding it page-batches (see splitPdfIntoBatches in parsers)
// so an N-batch document can still surface up to 8×N images instead of a hard 8 total.
export const OCR_MODEL = process.env.OPENROUTER_OCR_MODEL ?? CHAT_MODEL

export interface OpenRouterOcrResult {
  text: string
  images: { base64: string; mimeType: string }[]
}

export async function extractPdfViaOpenRouter(base64Pdf: string): Promise<OpenRouterOcrResult> {
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: openRouterHeaders(),
    body: JSON.stringify({
      model: OCR_MODEL,
      plugins: [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Reply with only the word "OK" — do not describe or summarize the attached file.' },
            { type: 'file', file: { filename: 'document.pdf', file_data: `data:application/pdf;base64,${base64Pdf}` } },
          ],
        },
      ],
    }),
  })

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText)
    throw new Error(`OpenRouter PDF parse error ${res.status}: ${err}`)
  }

  const data = await res.json()
  type FileContentItem = { type: string; text?: string; image_url?: { url: string } }
  const annotations: { type: string; file?: { content?: FileContentItem[] } }[] = data.choices?.[0]?.message?.annotations ?? []
  const items = annotations.find((a) => a.type === 'file')?.file?.content ?? []

  const text = items.filter((i) => i.type === 'text').map((i) => i.text ?? '').join('\n\n')
  const images = items
    .filter((i): i is FileContentItem & { image_url: { url: string } } => i.type === 'image_url' && !!i.image_url?.url)
    .map((i) => {
      const match = i.image_url.url.match(/^data:([^;]+);base64,(.+)$/)
      return match ? { mimeType: match[1], base64: match[2] } : null
    })
    .filter((x): x is { mimeType: string; base64: string } => x !== null)

  return { text, images }
}

/**
 * Transcribes visible text from a standalone image upload (replaces direct Mistral OCR for
 * the 'image' file type). Returns '' on failure or if there's no legible text.
 */
export async function transcribeImageText(base64: string, mimeType: string): Promise<string> {
  try {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: openRouterHeaders(),
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Transcribe all text visible in this image verbatim, preserving structure/line breaks. If there is no legible text, respond with an empty string — no commentary either way.' },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
            ],
          },
        ],
      }),
    })
    if (!res.ok) return ''
    const data = await res.json()
    return (data.choices?.[0]?.message?.content ?? '').trim()
  } catch {
    return ''
  }
}

// Vision model used for image captioning — deliberately NOT the chat model. Captioning is a
// simple task; a full-size chat-grade model (e.g. Claude) costs far more per image than a
// cheap vision-capable model for "what does this diagram show." Override via env if needed.
export const VISION_MODEL = process.env.OPENROUTER_VISION_MODEL ?? 'google/gemini-2.0-flash-001'

// Vision APIs bill by pixel/tile count, not per-image — a diagram doesn't need full page
// resolution to be captioned accurately. Downscaling before the API call cuts vision cost
// 4-10x with no meaningful caption quality loss.
const MAX_CAPTION_DIMENSION = 1024

export interface ImageDescription {
  title: string        // short, human-readable, unique — e.g. "FIG. 1 — System Architecture"
  description: string  // 1-3 factual sentences for search + LLM reference
}

async function downscaleForCaptioning(base64: string, mimeType: string): Promise<{ base64: string; mimeType: string }> {
  try {
    const sharp = (await import('sharp')).default
    const input = Buffer.from(base64, 'base64')
    const resized = await sharp(input)
      .resize(MAX_CAPTION_DIMENSION, MAX_CAPTION_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer()
    return { base64: resized.toString('base64'), mimeType: 'image/jpeg' }
  } catch {
    // sharp failed (unsupported format, corrupt image, etc.) — fall back to the original
    return { base64, mimeType }
  }
}

/**
 * Generate a searchable title + description of an image using a vision model.
 * Returns null on any failure (caller falls back to OCR text alone).
 */
export async function describeImage(base64: string, mimeType: string, context = ''): Promise<ImageDescription | null> {
  try {
    const small = await downscaleForCaptioning(base64, mimeType)
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: openRouterHeaders(),
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Look at this image from a business document and respond with EXACTLY two lines, no markdown, no extra text:
TITLE: <a short, unique, human-readable label, max 8 words — e.g. "FIG. 1 — System Architecture Diagram" or "Q3 Revenue Chart". If the image is a figure/exhibit number, lead with that number exactly as shown.>
DESCRIPTION: <1-3 factual sentences: what it is (diagram, chart, floor plan, photo, table, screenshot) and what it depicts — key labels, entities, and values visible.>${context ? `\n\nSurrounding document text for context:\n${context.slice(0, 1000)}` : ''}`,
              },
              { type: 'image_url', image_url: { url: `data:${small.mimeType};base64,${small.base64}` } },
            ],
          },
        ],
      }),
    })
    if (!res.ok) return null
    const data = await res.json()
    const raw = (data.choices?.[0]?.message?.content ?? '').trim()
    const titleMatch = raw.match(/TITLE:\s*(.+)/i)
    const descMatch = raw.match(/DESCRIPTION:\s*([\s\S]+)/i)
    const title = titleMatch?.[1]?.trim().replace(/^\*+|\*+$/g, '') ?? ''
    const description = descMatch?.[1]?.trim() ?? raw
    if (!title && !description) return null
    return { title: title || description.slice(0, 60), description }
  } catch {
    return null
  }
}

// Model used for document extraction (summary/key numbers/risks/decisions JSON). Routed
// through OpenRouter (paid key) — NOT a direct Mistral API call. This used to call
// mistral.chat.complete() directly against the Mistral account, which is the free/limited
// one; that account's rate limit was being hit on every single document upload since this
// extraction runs for every doc. Defaults to the same model as chat; override if desired.
export const EXTRACT_MODEL = process.env.OPENROUTER_EXTRACT_MODEL ?? CHAT_MODEL

/**
 * JSON-mode completion via OpenRouter (paid key) — used for structured extraction where
 * the response must be parseable JSON. Throws on failure or unparseable output.
 *
 * Validates the response is actually parseable JSON before returning. If the model
 * returns invalid JSON (truncated, wrapped in extra text, etc.), retries the request.
 * Also checks finish_reason for truncation ('length').
 */
export async function chatJson(systemPrompt: string, userMessage: string): Promise<string> {
  const maxRetries = 2
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 60000) // 60s timeout for JSON mode
      
      const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: openRouterHeaders(),
        body: JSON.stringify({
          model: EXTRACT_MODEL,
          max_tokens: 4096,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
        }),
        signal: controller.signal
      })
      clearTimeout(timeout)
      
      if (!res.ok) {
        const err = await res.text().catch(() => res.statusText)
        // Retry on rate limit (429) or server errors (5xx)
        if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000
          console.log(`[provider] retry ${attempt + 1}/${maxRetries} after ${delay}ms (status=${res.status})`)
          await new Promise(r => setTimeout(r, delay))
          continue
        }
        throw new Error(`OpenRouter error ${res.status}: ${err}`)
      }
      
      const data = await res.json()
      const raw = data.choices?.[0]?.message?.content ?? ''
      const finishReason = data.choices?.[0]?.finish_reason

      // Check for truncation — model ran out of tokens mid-JSON
      if (finishReason === 'length') {
        console.warn(`[provider] chatJson: response truncated (finish_reason=length, ${raw.length} chars)`)
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000
          await new Promise(r => setTimeout(r, delay))
          continue
        }
      }

      // Strip markdown fences — some models wrap JSON in ```json ... ``` despite response_format
      const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
      const cleaned = fenceMatch ? fenceMatch[1].trim() : raw.trim()

      // Validate the cleaned response is actually parseable JSON
      if (cleaned) {
        try {
          JSON.parse(cleaned)
          return cleaned
        } catch {
          console.warn(`[provider] chatJson: response is not valid JSON (${cleaned.length} chars, starts with: ${cleaned.slice(0, 100)})`)
          if (attempt < maxRetries) {
            const delay = Math.pow(2, attempt) * 1000
            await new Promise(r => setTimeout(r, delay))
            continue
          }
        }
      }

      // All retries exhausted — return whatever we have and let caller handle
      return cleaned
    } catch (err) {
      if (attempt === maxRetries) throw err
      const delay = Math.pow(2, attempt) * 1000
      console.log(`[provider] retry ${attempt + 1}/${maxRetries} after ${delay}ms (error)`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw new Error('chatJson failed after retries')
}

// Whisper transcription via OpenRouter — routed through OUR backend instead of the browser
// calling Google's speech service directly. Fixes voice input failing with "Speech recognition
// needs an internet connection" on networks that block Google's endpoint specifically but allow
// normal HTTPS (which is how every other OpenRouter call in this app already succeeds).
export const TRANSCRIBE_MODEL = process.env.OPENROUTER_TRANSCRIBE_MODEL ?? 'openai/whisper-1'

export async function transcribeAudio(audio: Blob, filename = 'audio.webm'): Promise<string> {
  const form = new FormData()
  form.append('file', audio, filename)
  form.append('model', TRANSCRIBE_MODEL)

  const res = await fetch(`${OPENROUTER_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
      'X-Title': 'Memory',
    },
    body: form,
  })

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText)
    throw new Error(`OpenRouter transcription error ${res.status}: ${err.slice(0, 300)}`)
  }

  const data = await res.json()
  return (data.text ?? '').trim()
}

export async function chat(
  systemPrompt: string,
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[] = []
): Promise<string> {
  const maxRetries = 2
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 60000) // 60s timeout
      
      const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: openRouterHeaders(),
        body: JSON.stringify({
          model: CHAT_MODEL,
          max_tokens: 32768,
          messages: [
            { role: 'system', content: systemPrompt },
            ...history,
            { role: 'user', content: userMessage },
          ],
        }),
        signal: controller.signal
      })
      clearTimeout(timeout)
      
      if (!res.ok) {
        const err = await res.text().catch(() => res.statusText)
        // Retry on rate limit (429) or server errors (5xx)
        if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000
          console.log(`[provider] retry ${attempt + 1}/${maxRetries} after ${delay}ms (status=${res.status})`)
          await new Promise(r => setTimeout(r, delay))
          continue
        }
        throw new Error(`OpenRouter error ${res.status}: ${err}`)
      }
      
      const data = await res.json()
      return data.choices?.[0]?.message?.content ?? ''
    } catch (err) {
      if (attempt === maxRetries) throw err
      const delay = Math.pow(2, attempt) * 1000
      console.log(`[provider] retry ${attempt + 1}/${maxRetries} after ${delay}ms (error)`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw new Error('chat failed after retries')
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
      max_tokens: 32768,
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
