import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { documents, documentChunks } from '@/lib/db/schema'
import { extractText } from '@/lib/parsers'
import { chunkText } from '@/lib/utils/chunking'
import { sanitizeForPrompt } from '@/lib/utils/sanitize'
import { mistral, CHAT_MODEL, EMBED_MODEL } from './provider'
import { documentProcessingPrompt } from './prompts'
import type { DocumentType } from '@/types'

interface ExtractedData {
  summary: string
  keyNumbers: string[]
  risks: string[]
  decisions: string[]
  importantDates: string[]
}

export async function processDocumentFromBuffer(
  documentId: string,
  buffer: Buffer,
  fileType: DocumentType
): Promise<void> {
  await db
    .update(documents)
    .set({ status: 'processing', updatedAt: new Date() })
    .where(eq(documents.id, documentId))

  try {
    const [doc] = await db
      .select({ name: documents.name })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1)

    if (!doc) throw new Error('Document not found')

    // 1. Extract text from buffer
    const rawText = await extractText(buffer, fileType)
    const safeText = sanitizeForPrompt(rawText)

    if (!safeText.trim()) throw new Error('No text could be extracted from document')

    // 2. AI extraction (summary, risks, decisions, numbers)
    const extracted = await extractDocumentData(doc.name, safeText)

    // 3. Chunk text
    const chunks = chunkText(safeText)

    // 4. Embed chunks in batches of 50 — prevents Mistral rate limits on large documents
    if (chunks.length > 0) {
      const BATCH_SIZE = 50
      const embeddings: number[][] = []

      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE)
        const response = await mistral.embeddings.create({
          model: EMBED_MODEL,
          inputs: batch,
        })
        embeddings.push(...response.data.map((d) => d.embedding ?? []))
      }

      // 5. Store chunks + embeddings
      await db.insert(documentChunks).values(
        chunks.map((content, index) => ({
          documentId,
          content,
          chunkIndex: index,
          embedding: embeddings[index] ?? [],
        }))
      )
    }

    // 6. Update document with extracted data and mark ready
    await db
      .update(documents)
      .set({
        status: 'ready',
        summary: extracted.summary,
        keyNumbers: extracted.keyNumbers,
        risks: extracted.risks,
        decisions: extracted.decisions,
        importantDates: extracted.importantDates,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, documentId))
  } catch (error) {
    console.error(`Failed to process document ${documentId}:`, error)
    await db
      .update(documents)
      .set({ status: 'failed', updatedAt: new Date() })
      .where(eq(documents.id, documentId))
    throw error
  }
}

async function extractDocumentData(name: string, text: string): Promise<ExtractedData> {
  const truncated = text.slice(0, 8000)

  const response = await mistral.chat.complete({
    model: CHAT_MODEL,
    messages: [
      { role: 'system', content: documentProcessingPrompt(name) },
      { role: 'user', content: truncated },
    ],
    responseFormat: { type: 'json_object' },
  })

  const content = response.choices?.[0]?.message?.content as string
  const parsed = JSON.parse(content)

  return {
    summary: parsed.summary ?? '',
    keyNumbers: Array.isArray(parsed.keyNumbers) ? parsed.keyNumbers : [],
    risks: Array.isArray(parsed.risks) ? parsed.risks : [],
    decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
    importantDates: Array.isArray(parsed.importantDates) ? parsed.importantDates : [],
  }
}
