import type { DocumentType } from '@/types'
import { uploadFile } from '@/lib/storage/minio'
import { mapWithConcurrency } from '@/lib/utils/concurrency'
import { extractPdfViaOpenRouter, transcribeImageText } from '@/lib/ai/provider'
import AdmZip from 'adm-zip'

// Splitting a large PDF into page-batches and OCR-ing them concurrently is a real win for
// big scanned documents — OCR time scales with page count, and a 76-page patent run as one
// call is fully serial. It also mitigates OpenRouter's file-parser plugin capping extracted
// images at 8 per request — an N-batch document can surface up to 8×N images instead of a
// hard 8 total. Below the threshold, splitting adds overhead for no benefit.
const PAGES_PER_OCR_BATCH = 8
const MAX_CONCURRENT_OCR_BATCHES = 3

export interface TableSheet {
  sheetName: string
  headers: string[]
  rows: string[][]
}

export interface ParsedImage {
  imageUrl: string   // served path, e.g. /api/documents/{id}/images/{imgId}
  base64: string     // raw image data — passed to the vision model for captioning
  mimeType: string   // image/jpeg, image/png, ...
  ocrText: string    // OCR'd text near the image (context for the caption + fallback search text)
}

export interface ParsedDocument {
  text: string          // prose content (pdf, docx, text paste)
  tables: TableSheet[]  // structured sheets (xlsx, csv)
  images: ParsedImage[] // extracted figures/diagrams (pdf, image uploads)
  fileType: DocumentType
}

export async function parseDocument(
  buffer: Buffer,
  fileType: DocumentType,
  documentId?: string
): Promise<ParsedDocument> {
  switch (fileType) {
    case 'pdf': {
      // OCR path (documentId present) returns both text and extracted image regions
      if (documentId) {
        const { text, images } = await extractPdfOcr(buffer, documentId)
        return { text, tables: [], images, fileType }
      }
      return { text: await extractPdf(buffer), tables: [], images: [], fileType }
    }
    case 'docx': {
      const { text, images } = await extractDocx(buffer, documentId)
      return { text, tables: [], images, fileType }
    }
    case 'xlsx':
      return { text: '', tables: await extractExcelStructured(buffer), images: [], fileType }
    case 'csv':
      return { text: '', tables: [await extractCsvStructured(buffer)], images: [], fileType }
    case 'text':
      return { text: buffer.toString('utf-8'), tables: [], images: [], fileType }
    case 'pptx': {
      const { text, images } = await extractPptx(buffer, documentId)
      return { text, tables: [], images, fileType }
    }
    case 'image': {
      const { text, images } = await extractImageStructured(buffer, documentId)
      return { text, tables: [], images, fileType }
    }
    case 'zip':
      return { text: await extractZip(buffer), tables: [], images: [], fileType }
    case 'email':
      return { text: await extractEmail(buffer), tables: [], images: [], fileType }
    case 'cad':
      return { text: await extractCad(buffer), tables: [], images: [], fileType }
    default:
      throw new Error(`Unsupported file type: ${fileType}`)
  }
}

// Legacy flat-text extraction — still used by extractDocumentData() for AI summarisation
export async function extractText(buffer: Buffer, fileType: DocumentType): Promise<string> {
  switch (fileType) {
    case 'pdf':   return extractPdf(buffer)
    case 'docx':  return (await extractDocx(buffer)).text
    case 'xlsx':  return extractExcelFlat(buffer)
    case 'csv':   return buffer.toString('utf-8')
    case 'text':  return buffer.toString('utf-8')
    case 'pptx':  return (await extractPptx(buffer)).text
    case 'image': return extractImage(buffer)
    case 'zip':   return extractZip(buffer)
    case 'email': return extractEmail(buffer)
    case 'cad':   return extractCad(buffer)
    default:      throw new Error(`Unsupported file type: ${fileType}`)
  }
}

// Flat-text PDF extraction — used by extractText() for AI summarisation (no image handling).
async function extractPdf(buffer: Buffer, documentId?: string): Promise<string> {
  if (documentId) {
    return (await extractPdfOcr(buffer, documentId)).text
  }
  const pdfParse = (await import('pdf-parse')).default
  const result = await pdfParse(buffer)
  return result.text?.trim() ?? ''
}

// Splits a PDF into ~PAGES_PER_OCR_BATCH-page chunks via pdf-lib. Returns [original buffer]
// unchanged (no split) if the PDF is small enough, or if splitting fails for any reason
// (encrypted/malformed PDFs, etc.) — OCR always falls back to the whole document as one call.
async function splitPdfIntoBatches(buffer: Buffer): Promise<Buffer[]> {
  try {
    const { PDFDocument } = await import('pdf-lib')
    const src = await PDFDocument.load(buffer, { ignoreEncryption: true })
    const pageCount = src.getPageCount()
    if (pageCount <= PAGES_PER_OCR_BATCH) return [buffer]

    const batches: Buffer[] = []
    for (let start = 0; start < pageCount; start += PAGES_PER_OCR_BATCH) {
      const indices = Array.from(
        { length: Math.min(PAGES_PER_OCR_BATCH, pageCount - start) },
        (_, i) => start + i
      )
      const dst = await PDFDocument.create()
      const copiedPages = await dst.copyPages(src, indices)
      copiedPages.forEach((p) => dst.addPage(p))
      batches.push(Buffer.from(await dst.save()))
    }
    return batches
  } catch (err) {
    console.error('[OCR] PDF split failed — falling back to single-batch OCR:', err)
    return [buffer]
  }
}

// Below this size an "image" is almost always a logo/icon/bullet/spacer, not a real figure.
// This is the ONLY filter available now — OpenRouter's file-parser plugin exposes no
// bounding-box/page-dimension data, so the old whole-page-scan-vs-floor-plan text-density
// filter (which needed that data) can no longer be computed and has been removed.
const MIN_PDF_IMAGE_BYTES = 3000

async function extractPdfOcr(
  buffer: Buffer,
  documentId?: string
): Promise<{ text: string; images: ParsedImage[] }> {
  const batches = await splitPdfIntoBatches(buffer)
  const batchResults = batches.length === 1
    ? [await extractPdfViaOpenRouter(batches[0].toString('base64'))]
    : await mapWithConcurrency(batches, MAX_CONCURRENT_OCR_BATCHES, (b) => extractPdfViaOpenRouter(b.toString('base64')))

  const images: ParsedImage[] = []

  if (documentId) {
    for (let batchIdx = 0; batchIdx < batchResults.length; batchIdx++) {
      const { text: batchText, images: batchImages } = batchResults[batchIdx]
      // No per-page grouping available — use this whole batch's text (≤8 pages) as the
      // closest available context for every image extracted from it.
      for (let imgIdx = 0; imgIdx < batchImages.length; imgIdx++) {
        const img = batchImages[imgIdx]
        if (Buffer.byteLength(img.base64, 'base64') < MIN_PDF_IMAGE_BYTES) continue

        const ext = img.mimeType.split('/').pop() ?? 'jpeg'
        const qualifiedId = `b${batchIdx}-img-${imgIdx}.${ext}`
        try {
          const imgBuffer = Buffer.from(img.base64, 'base64')
          const key = `documents/${documentId}/images/${qualifiedId}`
          await uploadFile(key, imgBuffer, img.mimeType)
          const url = `/api/documents/${documentId}/images/${encodeURIComponent(qualifiedId)}`
          images.push({ imageUrl: url, base64: img.base64, mimeType: img.mimeType, ocrText: batchText })
        } catch (imgErr) {
          console.error(`[OCR] Failed to upload image ${qualifiedId}:`, imgErr)
        }
      }
    }
  }

  const text = batchResults.map((r) => r.text).join('\n\n')
  return { text, images }
}

// DOCX/PPTX are both zipped Office Open XML — embedded pictures live under a fixed media
// folder inside the archive regardless of which text-extraction library reads the prose.
// Vector formats (emf/wmf/svg) are skipped — vision models can't read them as raster input.
const OFFICE_RASTER_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' }
const MIN_OFFICE_IMAGE_BYTES = 3000

async function extractOfficeMedia(zip: AdmZip, mediaPathPrefix: string, documentId?: string): Promise<ParsedImage[]> {
  if (!documentId) return []
  const images: ParsedImage[] = []
  const mediaEntries = zip.getEntries().filter((e) => e.entryName.startsWith(mediaPathPrefix) && !e.isDirectory)

  for (const entry of mediaEntries) {
    const ext = entry.entryName.split('.').pop()?.toLowerCase() ?? ''
    const mimeType = OFFICE_RASTER_EXT[ext]
    if (!mimeType) continue

    const data = entry.getData()
    if (data.byteLength < MIN_OFFICE_IMAGE_BYTES) continue

    try {
      const safeName = entry.entryName.split('/').pop() ?? `image.${ext}`
      const key = `documents/${documentId}/images/${safeName}`
      await uploadFile(key, data, mimeType)
      const url = `/api/documents/${documentId}/images/${encodeURIComponent(safeName)}`
      images.push({ imageUrl: url, base64: data.toString('base64'), mimeType, ocrText: '' })
    } catch (err) {
      console.error(`[Office media] Failed to upload ${entry.entryName}:`, err)
    }
  }
  return images
}

async function extractDocx(buffer: Buffer, documentId?: string): Promise<{ text: string; images: ParsedImage[] }> {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ buffer })
  const images = await extractOfficeMedia(new AdmZip(buffer), 'word/media/', documentId)
  return { text: result.value, images }
}

// Used only for AI extraction summary (needs flat string)
async function extractExcelFlat(buffer: Buffer): Promise<string> {
  const XLSX = await import('xlsx')
  const workbook = XLSX.read(buffer, { type: 'buffer' })
  const lines: string[] = []
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    const csv = XLSX.utils.sheet_to_csv(sheet)
    lines.push(`[Sheet: ${sheetName}]\n${csv}`)
  }
  return lines.join('\n\n')
}

// Structured extraction — returns typed rows per sheet
async function extractExcelStructured(buffer: Buffer): Promise<TableSheet[]> {
  const XLSX = await import('xlsx')
  const workbook = XLSX.read(buffer, { type: 'buffer' })
  const sheets: TableSheet[] = []

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    // sheet_to_json with header:1 gives string[][] where row[0] is headers
    const rawRows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: '' })

    // Skip completely empty sheets
    if (rawRows.length === 0) continue

    // First non-empty row is treated as headers
    const headers = rawRows[0].map(h => String(h ?? '').trim())
    if (headers.every(h => h === '')) continue

    const dataRows = rawRows
      .slice(1)
      .filter(row => row.some(cell => String(cell ?? '').trim() !== ''))
      .map(row => row.map(cell => String(cell ?? '').trim()))

    if (dataRows.length === 0) continue

    sheets.push({ sheetName, headers, rows: dataRows })
  }

  return sheets
}

async function extractCsvStructured(buffer: Buffer): Promise<TableSheet> {
  const text = buffer.toString('utf-8')
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0)

  if (lines.length === 0) return { sheetName: 'Sheet1', headers: [], rows: [] }

  const parseRow = (line: string): string[] =>
    line.split(',').map(cell => cell.replace(/^"|"$/g, '').trim())

  const headers = parseRow(lines[0])
  const rows = lines.slice(1).map(parseRow).filter(row => row.some(c => c !== ''))

  return { sheetName: 'Sheet1', headers, rows }
}

// --- PPTX -----------------------------------------------------------------
async function extractPptx(buffer: Buffer, documentId?: string): Promise<{ text: string; images: ParsedImage[] }> {
  const zip = new AdmZip(buffer)
  const slideEntries = zip.getEntries()
    .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => {
      const na = parseInt(a.entryName.match(/(\d+)/)?.[1] ?? '0')
      const nb = parseInt(b.entryName.match(/(\d+)/)?.[1] ?? '0')
      return na - nb
    })

  const slides: string[] = []
  for (const entry of slideEntries) {
    const xml = entry.getData().toString('utf-8')
    const texts = [...xml.matchAll(/<a:t[^>]*>([^<]+)<\/a:t>/g)].map(m => m[1].trim()).filter(Boolean)
    if (texts.length > 0) slides.push(texts.join(' '))
  }
  const text = slides.map((s, i) => `[Slide ${i + 1}]\n${s}`).join('\n\n')
  const images = await extractOfficeMedia(zip, 'ppt/media/', documentId)
  return { text, images }
}

// --- IMAGES ---------------------------------------------------------------
// Legacy flat-text variant — used by extractText()/extractZip() where images aren't tracked.
async function extractImage(buffer: Buffer, documentId?: string): Promise<string> {
  return (await extractImageStructured(buffer, documentId)).text
}

// Structured variant — returns OCR text plus the image itself as a ParsedImage for captioning.
async function extractImageStructured(
  buffer: Buffer,
  documentId?: string
): Promise<{ text: string; images: ParsedImage[] }> {
  const base64 = buffer.toString('base64')

  try {
    const ocrText = await transcribeImageText(base64, 'image/jpeg')
    let text = ocrText
    const images: ParsedImage[] = []

    // Store the original image so it can be displayed + captioned
    if (documentId) {
      try {
        const key = `documents/${documentId}/images/original.jpg`
        await uploadFile(key, buffer, 'image/jpeg')
        const url = `/api/documents/${documentId}/images/original.jpg`
        text = `![Document image](${url})\n\n${text}`
        images.push({ imageUrl: url, base64, mimeType: 'image/jpeg', ocrText })
      } catch {}
    }

    return { text, images }
  } catch {
    return { text: '[Image file — OCR extraction failed]', images: [] }
  }
}

// --- ZIP ------------------------------------------------------------------
async function extractZip(buffer: Buffer): Promise<string> {
  const zip = new AdmZip(buffer)
  const entries = zip.getEntries()
    .filter(e => !e.isDirectory && e.header.size < 50 * 1024 * 1024)
    .slice(0, 20)

  const parts: string[] = []
  for (const entry of entries) {
    let type: DocumentType
    try { type = detectFileType(entry.entryName) } catch { continue }
    try {
      const text = await extractText(entry.getData(), type)
      if (text.trim()) parts.push(`[${entry.entryName}]\n${text.trim()}`)
    } catch { /* skip unextractable */ }
  }
  return parts.join('\n\n---\n\n') || '[Empty or unsupported ZIP contents]'
}

// --- EMAIL (eml + msg) ----------------------------------------------------
async function extractEmail(buffer: Buffer): Promise<string> {
  const raw = buffer.toString('utf-8')

  // MSG files are CFBF binary — detect by magic bytes D0 CF 11 E0
  if (buffer[0] === 0xD0 && buffer[1] === 0xCF && buffer[2] === 0x11 && buffer[3] === 0xE0) {
    return extractMsg(buffer)
  }

  // EML / RFC 822 format
  try {
    const PostalMime = (await import('postal-mime')).default
    const parser = new PostalMime()
    const email = await parser.parse(raw)
    const lines: string[] = []
    if (email.subject) lines.push(`Subject: ${email.subject}`)
    if (email.from?.address) lines.push(`From: ${email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address}`)
    if (email.to?.length) lines.push(`To: ${email.to.map(r => r.address).join(', ')}`)
    if (email.date) lines.push(`Date: ${email.date}`)
    if (email.attachments?.length) lines.push(`Attachments: ${email.attachments.map(a => a.filename ?? 'unnamed').join(', ')}`)
    lines.push('')
    lines.push(email.text ?? (email.html ? email.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : ''))
    return lines.join('\n')
  } catch {
    return raw.slice(0, 10000)
  }
}

async function extractMsg(buffer: Buffer): Promise<string> {
  try {
    const MsgReader = (await import('@kenjiuno/msgreader')).default
    const reader = new MsgReader(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer)
    const data = reader.getFileData()
    const lines: string[] = []
    if (data.subject)      lines.push(`Subject: ${data.subject}`)
    if (data.senderName)   lines.push(`From: ${data.senderName}${data.senderEmail ? ` <${data.senderEmail}>` : ''}`)
    if (data.recipients?.length) lines.push(`To: ${data.recipients.map((r: { name?: string; email?: string }) => r.email ?? r.name ?? '').join(', ')}`)
    if (data.messageDeliveryTime) lines.push(`Date: ${data.messageDeliveryTime}`)
    if (data.attachments?.length) lines.push(`Attachments: ${data.attachments.map((a: { fileName?: string }) => a.fileName ?? 'unnamed').join(', ')}`)
    lines.push('')
    lines.push(data.body ?? '')
    return lines.join('\n')
  } catch {
    return '[MSG file — extraction failed]'
  }
}

// --- CAD (dwg / dxf / skp) -----------------------------------------------
async function extractCad(buffer: Buffer): Promise<string> {
  // DXF is ASCII text — extract TEXT and MTEXT entities
  const text = buffer.toString('utf-8', 0, Math.min(buffer.length, 2 * 1024 * 1024))

  // Check if this looks like a DXF file (starts with group code 0)
  if (text.trimStart().startsWith('  0\r\nSECTION') || text.trimStart().startsWith('  0\nSECTION') ||
      text.trimStart().startsWith('0\r\nSECTION')   || text.trimStart().startsWith('0\nSECTION')) {
    return extractDxfText(text)
  }

  // DWG and SKP are binary — no text extraction possible
  return '[Binary CAD file — drawings should be exported to PDF for full text extraction]'
}

function extractDxfText(dxf: string): string {
  const lines = dxf.split(/\r?\n/)
  const extracted: string[] = []
  for (let i = 0; i < lines.length - 1; i++) {
    const code = lines[i].trim()
    const value = lines[i + 1]?.trim() ?? ''
    // Group code 1 = primary text value (TEXT, MTEXT, ATTDEF)
    // Group code 3 = additional text for long MTEXT
    if ((code === '1' || code === '3') && value && value !== '\\P') {
      const clean = value
        .replace(/\\[pPnNfFlLkKoOcCqQtTaAbBwWiI][^;]*;/g, '') // DXF formatting codes
        .replace(/\\P/g, '\n')
        .trim()
      if (clean) extracted.push(clean)
    }
  }
  return extracted.length > 0
    ? `[DXF Drawing — extracted text content]\n\n${[...new Set(extracted)].join('\n')}`
    : '[DXF Drawing — no text entities found]'
}

export function detectFileType(filename: string): DocumentType {
  const ext = filename.split('.').pop()?.toLowerCase()
  const map: Record<string, DocumentType> = {
    // Documents
    pdf:  'pdf',
    docx: 'docx',
    doc:  'docx',
    xlsx: 'xlsx',
    xls:  'xlsx',
    csv:  'csv',
    pptx: 'pptx',
    ppt:  'pptx',
    txt:  'text',
    // Images
    jpg:  'image',
    jpeg: 'image',
    png:  'image',
    webp: 'image',
    // Archive
    zip:  'zip',
    // Email
    eml:  'email',
    msg:  'email',
    // CAD
    dwg:  'cad',
    dxf:  'cad',
    skp:  'cad',
  }
  const type = map[ext ?? '']
  if (!type) throw new Error(`Unsupported file extension: .${ext}`)
  return type
}

export const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
  'text/plain',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/zip',
  'application/x-zip-compressed',
  'message/rfc822',
  'application/vnd.ms-outlook',
  'application/octet-stream', // browser fallback for dwg/dxf/skp
]

export const MAX_FILE_SIZE = 500 * 1024 * 1024 // 500MB
