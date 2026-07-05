import { createHash } from 'crypto'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { documents, documentChunks } from '@/lib/db/schema'
import { parseDocument, extractText, type ParsedImage } from '@/lib/parsers'
import { chunkText, chunkTable } from '@/lib/utils/chunking'
import { sanitizeForPrompt } from '@/lib/utils/sanitize'
import { mapWithConcurrency } from '@/lib/utils/concurrency'
import { mistral, EXTRACT_MODEL, EMBED_MODEL, describeImage, type ImageDescription } from './provider'
import { documentProcessingPrompt } from './prompts'
import type { DocumentType } from '@/types'

// Below this size an "image" is almost always a logo/icon/bullet/spacer, not a real figure —
// skip captioning it entirely (saves vision calls + embeds nothing useless).
const MIN_IMAGE_BYTES = 3000

// Bounds worst-case processing time/cost for pathological documents (e.g. a 76-sheet patent
// with dozens of figures) — beyond this, remaining images are skipped rather than captioned.
// Chosen well above what a normal business document has; only kicks in for outliers.
const MAX_IMAGES_PER_DOCUMENT = 30

// Mistral embed limit is ~16k tokens per batch. 1 token ≈ 4 chars.
function tokenBatches<T extends { content: string } | string>(items: T[], maxTokens = 14000): T[][] {
  const batches: T[][] = []
  let batch: T[] = []
  let batchTokens = 0
  for (const item of items) {
    const text = typeof item === 'string' ? item : item.content
    const tokens = Math.ceil(text.length / 4)
    if (batch.length > 0 && batchTokens + tokens > maxTokens) {
      batches.push(batch)
      batch = []
      batchTokens = 0
    }
    batch.push(item)
    batchTokens += tokens
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

function extractErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  // Mistral SDK errors look like: "API error occurred: Status 400 Body: {...json...}"
  const bodyMatch = msg.match(/Body:\s*(\{[\s\S]+\})/)
  if (bodyMatch) {
    try {
      const parsed = JSON.parse(bodyMatch[1])
      if (parsed.message) return parsed.message
    } catch {}
  }
  return msg.slice(0, 500)
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
    const parsed = await parseDocument(buffer, fileType, documentId)

    // 2. AI extraction always uses flat text (needs prose for JSON summary).
    // Reuse parsed.text (already OCR'd for image-only PDFs) instead of re-parsing —
    // extractText() has no documentId so it can't OCR and would wrongly return empty
    // for scanned/no-text-layer PDFs. Only table types (xlsx/csv) need the fallback,
    // since parsed.text is '' for those (content lives in parsed.tables instead).
    const flatText = parsed.text || await extractText(buffer, fileType)
    const safeFlat = sanitizeForPrompt(flatText)
    if (!safeFlat.trim()) throw new Error('No text could be extracted from document')
    // Don't await yet — this is independent of chunking/image captioning below, so let it
    // run concurrently instead of adding its full latency serially to every upload.
    const extractedPromise = extractDocumentData(doc.name, safeFlat)

    // 3. Build chunks — table path or prose path
    interface ChunkRecord {
      content: string
      chunkType: 'prose' | 'table' | 'financial' | 'image'
      containsNumbers: boolean
      imageUrl?: string
      imageTitle?: string
    }

    const allChunks: ChunkRecord[] = []

    if (parsed.tables.length > 0) {
      // Excel / CSV — use table chunker for each sheet
      for (const sheet of parsed.tables) {
        const tableChunks = chunkTable(doc.name, sheet.sheetName, sheet.headers, sheet.rows)
        for (const tc of tableChunks) {
          allChunks.push({ content: tc.content, chunkType: 'table', containsNumbers: tc.containsNumbers })
        }
      }
    } else {
      // PDF / DOCX / text — use prose chunker.
      // Strip image markdown first: figures get their own dedicated 'image' chunks below,
      // so we never bury (or double-store) them inside a prose chunk.
      const proseSource = (parsed.text || flatText).replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      const safeText = sanitizeForPrompt(proseSource)
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

    // 3b. Image chunks — one per extracted figure. Embedding = vision caption + OCR text,
    // so a visual query ("show the architecture diagram") lands directly on the right image.
    // Skip tiny images (logos/icons/spacers) and dedupe repeated ones (e.g. a logo on every
    // page) so a large image-heavy PDF doesn't fire one vision call per occurrence.
    const captionCache = new Map<string, ImageDescription | null>()
    const allEligible = parsed.images.filter((img) => Buffer.byteLength(img.base64, 'base64') >= MIN_IMAGE_BYTES)
    const eligible = allEligible.slice(0, MAX_IMAGES_PER_DOCUMENT)
    if (allEligible.length > MAX_IMAGES_PER_DOCUMENT) {
      console.warn(`[processing] Document ${documentId} has ${allEligible.length} images — capturing captions for the first ${MAX_IMAGES_PER_DOCUMENT}, skipping ${allEligible.length - MAX_IMAGES_PER_DOCUMENT}`)
    }

    const captioned = await mapWithConcurrency(eligible, 4, async (img: ParsedImage) => {
      const hash = createHash('sha1').update(img.base64).digest('hex')
      let caption = captionCache.get(hash)
      if (caption === undefined) {
        caption = await describeImage(img.base64, img.mimeType, img.ocrText)
        captionCache.set(hash, caption)
      }
      return { img, caption }
    })

    for (const { img, caption } of captioned) {
      const title = caption?.title || 'Document image'
      const searchText = sanitizeForPrompt([title, caption?.description, img.ocrText].filter(Boolean).join('\n')).slice(0, 4000)
      allChunks.push({
        content: searchText || title,
        chunkType: 'image',
        containsNumbers: containsAnyNumbers(searchText),
        imageUrl: img.imageUrl,
        imageTitle: title,
      })
    }

    // 4. Embed in token-aware batches (stays under Mistral's 16k token/batch limit).
    // Batches are independent — run them concurrently instead of one-at-a-time.
    if (allChunks.length > 0) {
      const batchResponses = await Promise.all(
        tokenBatches(allChunks).map((batch) =>
          mistral.embeddings.create({ model: EMBED_MODEL, inputs: batch.map((c) => c.content) })
        )
      )
      const embeddings: number[][] = batchResponses.flatMap((response) => response.data.map((d) => d.embedding ?? []))

      // 5. Store chunks + embeddings
      await db.insert(documentChunks).values(
        allChunks.map((chunk, index) => ({
          documentId,
          content: chunk.content,
          chunkIndex: index,
          chunkType: chunk.chunkType,
          containsNumbers: chunk.containsNumbers,
          imageUrl: chunk.imageUrl ?? null,
          imageTitle: chunk.imageTitle ?? null,
          embedding: embeddings[index] ?? [],
        }))
      )
    }

    // 6. Mark ready with extracted metadata
    const extracted = await extractedPromise
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
      .set({ status: 'failed', failureReason: extractErrorMessage(error), updatedAt: new Date() })
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
      const embeddings: number[][] = []

      for (const batch of tokenBatches(proseChunks.map(c => ({ content: c })))) {
        const response = await mistral.embeddings.create({
          model: EMBED_MODEL,
          inputs: batch.map(c => c.content),
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
      .set({ status: 'failed', failureReason: extractErrorMessage(error), updatedAt: new Date() })
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
