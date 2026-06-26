import { Mistral } from '@mistralai/mistralai'

if (!process.env.MISTRAL_API_KEY) {
  throw new Error('MISTRAL_API_KEY is not set')
}

export const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY })

export const CHAT_MODEL = 'mistral-small-latest'
export const EMBED_MODEL = 'mistral-embed'
export const EMBED_DIMENSIONS = 1024

export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await mistral.embeddings.create({
    model: EMBED_MODEL,
    inputs: [text],
  })
  return response.data[0].embedding ?? []
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const response = await mistral.embeddings.create({
    model: EMBED_MODEL,
    inputs: texts,
  })
  return response.data.map((d) => d.embedding ?? [])
}

export async function chat(
  systemPrompt: string,
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[] = []
): Promise<string> {
  const response = await mistral.chat.complete({
    model: CHAT_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: userMessage },
    ],
  })
  return response.choices?.[0]?.message?.content as string ?? ''
}

export async function* chatStream(
  systemPrompt: string,
  userMessage: string,
  history: { role: 'user' | 'assistant'; content: string }[] = []
): AsyncGenerator<string> {
  const stream = await mistral.chat.stream({
    model: CHAT_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: userMessage },
    ],
  })
  for await (const event of stream) {
    const delta = event.data?.choices?.[0]?.delta?.content
    if (typeof delta === 'string' && delta) yield delta
  }
}
