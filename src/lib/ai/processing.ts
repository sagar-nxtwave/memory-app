import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { documents, documentChunks } from '@/lib/db/schema'
import { parseDocument, extractText } from '@/lib/parsers'
import { chunkText, chunkTable } from '@/lib/utils/chunking'
import { sanitizeForPrompt } from '@/lib/utils/sanitize'
import { mistral, EXTRACT_MODEL, EMBED_MODEL } from './provider'
import { documentProcessingPrompt } from './prompts'
import type { DocumentType } from '@/types'

function toUserFriendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes('No text could be extracted') || msg.includes('no extractable text'))
    return 'Scanned PDF — OCR failed, try a clearer scan'
  if (msg.includes('password') || msg.includes('encrypted'))
    return 'Password protected — remove password and re-upload'
  if (msg.includes('token') || msg.includes('rate') || msg.includes('quota'))
    return 'AI quota reached — try again in a few minutes'
  if (msg.includes('timeout') || msg.includes('ETIMEDOUT'))
    return 'Processing timed out — try splitting the document'
  if (msg.includes('corrupt') || msg.includes('invalid') || msg.includes('parse'))
    return 'File corrupted or unsupported format'
  return 'Processing failed — delete and re-upload'
}

interface ExtractedData {
  summary: string
  keyNumbers: string[]
  risks: string[]
  decisions: string[]
  importantDates: string[]
}

// Detect if a prose chunk is financially dense (numbers/currency)
function isFinancialChunk(text: string): boolean {
  const matches = text.match(/[\d,.]+\s*(%|AED|USD|EUR|GBP|SAR|\$|€|£)/g) ?? []
  return matches.length >= 3
}

function containsAnyNumbers(text: string): boolean {
  return /\d{2,}/.test(text)
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

    // 1. Parse document — structured for xlsx/csv, prose for pdf/docx
    const parsed = await parseDocument(buffer, fileType)

    // 2. AI extraction always uses flat text (needs prose for JSON summary)
    const flatText = await extractText(buffer, fileType)
    const safeFlat = sanitizeForPrompt(flatText)
    if (!safeFlat.trim()) throw new Error('No text could be extracted from document')
    const extracted = await extractDocumentData(doc.name, safeFlat)

    // 3. Build chunks — table path or prose path
    interface ChunkRecord {
      content: string
      chunkType: 'prose' | 'table' | 'financial'
      containsNumbers: boolean
    }

    let allChunks: ChunkRecord[] = []

    if (parsed.tables.length > 0) {
      // Excel / CSV — use table chunker for each sheet
      for (const sheet of parsed.tables) {
        const tableChunks = chunkTable(doc.name, sheet.sheetName, sheet.headers, sheet.rows)
        for (const tc of tableChunks) {
          allChunks.push({ content: tc.content, chunkType: 'table', containsNumbers: tc.containsNumbers })
        }
      }
    } else {
      // PDF / DOCX / text — use prose chunker
      const safeText = sanitizeForPrompt(parsed.text || flatText)
      const proseChunks = chunkText(safeText)
      for (const content of proseChunks) {
        const financial = isFinancialChunk(content)
        allChunks.push({
          content,
          chunkType: financial ? 'financial' : 'prose',
          containsNumbers: financial || containsAnyNumbers(content),
        })
      }
    }

    // 4. Embed in batches of 50
    if (allChunks.length > 0) {
      const BATCH_SIZE = 50
      const embeddings: number[][] = []

      for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
        const batch = allChunks.slice(i, i + BATCH_SIZE)
        const response = await mistral.embeddings.create({
          model: EMBED_MODEL,
          inputs: batch.map(c => c.content),
        })
        embeddings.push(...response.data.map((d) => d.embedding ?? []))
      }

      // 5. Store chunks + embeddings
      await db.insert(documentChunks).values(
        allChunks.map((chunk, index) => ({
          documentId,
          content: chunk.content,
          chunkIndex: index,
          chunkType: chunk.chunkType,
          containsNumbers: chunk.containsNumbers,
          embedding: embeddings[index] ?? [],
        }))
      )
    }

    // 6. Mark ready with extracted metadata
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
      .set({ status: 'failed', failureReason: toUserFriendlyError(error), updatedAt: new Date() })
      .where(eq(documents.id, documentId))
    throw error
  }
}

export async function processDocumentFromText(
  documentId: string,
  text: string
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

    const safeText = sanitizeForPrompt(text)
    if (!safeText.trim()) throw new Error('No text provided')

    const extracted = await extractDocumentData(doc.name, safeText)
    const proseChunks = chunkText(safeText)

    if (proseChunks.length > 0) {
      const BATCH_SIZE = 50
      const embeddings: number[][] = []

      for (let i = 0; i < proseChunks.length; i += BATCH_SIZE) {
        const batch = proseChunks.slice(i, i + BATCH_SIZE)
        const response = await mistral.embeddings.create({
          model: EMBED_MODEL,
          inputs: batch,
        })
        embeddings.push(...response.data.map((d) => d.embedding ?? []))
      }

      await db.insert(documentChunks).values(
        proseChunks.map((content, index) => {
          const financial = isFinancialChunk(content)
          return {
            documentId,
            content,
            chunkIndex: index,
            chunkType: (financial ? 'financial' : 'prose') as 'financial' | 'prose',
            containsNumbers: financial || containsAnyNumbers(content),
            embedding: embeddings[index] ?? [],
          }
        })
      )
    }

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
    console.error(`Failed to process text document ${documentId}:`, error)
    await db
      .update(documents)
      .set({ status: 'failed', failureReason: toUserFriendlyError(error), updatedAt: new Date() })
      .where(eq(documents.id, documentId))
    throw error
  }
}

async function extractDocumentData(name: string, text: string): Promise<ExtractedData> {
  const truncated = text.slice(0, 8000)

  const response = await mistral.chat.complete({
    model: EXTRACT_MODEL,
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
