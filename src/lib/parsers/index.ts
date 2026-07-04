import type { DocumentType } from '@/types'
import { Mistral } from '@mistralai/mistralai'
import { uploadFile } from '@/lib/storage/minio'
import AdmZip from 'adm-zip'

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
      if (documentId && process.env.MISTRAL_API_KEY) {
        const { text, images } = await extractPdfOcr(buffer, documentId)
        return { text, tables: [], images, fileType }
      }
      return { text: await extractPdf(buffer), tables: [], images: [], fileType }
    }
    case 'docx':
      return { text: await extractDocx(buffer), tables: [], images: [], fileType }
    case 'xlsx':
      return { text: '', tables: await extractExcelStructured(buffer), images: [], fileType }
    case 'csv':
      return { text: '', tables: [await extractCsvStructured(buffer)], images: [], fileType }
    case 'text':
      return { text: buffer.toString('utf-8'), tables: [], images: [], fileType }
    case 'pptx':
      return { text: await extractPptx(buffer), tables: [], images: [], fileType }
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
    case 'docx':  return extractDocx(buffer)
    case 'xlsx':  return extractExcelFlat(buffer)
    case 'csv':   return buffer.toString('utf-8')
    case 'text':  return buffer.toString('utf-8')
    case 'pptx':  return extractPptx(buffer)
    case 'image': return extractImage(buffer)
    case 'zip':   return extractZip(buffer)
    case 'email': return extractEmail(buffer)
    case 'cad':   return extractCad(buffer)
    default:      throw new Error(`Unsupported file type: ${fileType}`)
  }
}

// Flat-text PDF extraction — used by extractText() for AI summarisation (no image handling).
async function extractPdf(buffer: Buffer, documentId?: string): Promise<string> {
  if (documentId && process.env.MISTRAL_API_KEY) {
    return (await extractPdfOcr(buffer, documentId)).text
  }
  const pdfParse = (await import('pdf-parse')).default
  const result = await pdfParse(buffer)
  return result.text?.trim() ?? ''
}

// Strip markdown image refs from a string (used to keep image data out of prose).
function stripImageMarkdown(md: string): string {
  return md.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim()
}

async function extractPdfOcr(
  buffer: Buffer,
  documentId?: string
): Promise<{ text: string; images: ParsedImage[] }> {
  const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY! })

  // Upload the PDF file
  const blob = new Blob([new Uint8Array(buffer)], { type: 'application/pdf' })
  const file = new File([blob], 'document.pdf', { type: 'application/pdf' })
  const uploaded = await mistral.files.upload({ file, purpose: 'ocr' })

  // Get signed URL and run OCR with image extraction enabled
  const signedUrl = await mistral.files.getSignedUrl({ fileId: uploaded.id })
  const result = await mistral.ocr.process({
    model: 'mistral-ocr-latest',
    document: { type: 'document_url', documentUrl: signedUrl.url },
    includeImageBase64: true,
  })

  const images: ParsedImage[] = []
  const imageUrlMap = new Map<string, string>()
  const pages = result.pages ?? []

  // A full-page-sized "figure" is ambiguous: it could be a photographed/scanned TEXT page
  // (patent claims, a document screenshot — not a real figure), or it could be a genuine
  // full-page diagram (architectural floor plans, blueprints legitimately fill the page).
  // Area alone can't tell these apart — a floor plan is just as page-sized as a scanned page.
  // The real signal is text DENSITY: a scanned text page OCRs into dense paragraphs; a floor
  // plan OCRs into sparse labels/dimensions even though the image itself is full-page.
  const FULL_PAGE_AREA_RATIO = 0.85
  const DENSE_TEXT_WORD_COUNT = 150

  // Upload each page image + collect it as a ParsedImage (base64 kept for captioning)
  if (documentId) {
    for (const page of pages) {
      const pageText = stripImageMarkdown((page as { markdown?: string }).markdown ?? '')
      const pageWordCount = pageText.split(/\s+/).filter(Boolean).length
      const dims = (page as { dimensions?: { width: number; height: number } | null }).dimensions
      const pageArea = dims ? dims.width * dims.height : 0

      type OcrImg = { id: string; imageBase64?: string | null; topLeftX?: number | null; topLeftY?: number | null; bottomRightX?: number | null; bottomRightY?: number | null }
      for (const img of ((page as { images?: OcrImg[] }).images ?? [])) {
        if (!img.imageBase64) continue

        if (pageArea > 0 && img.topLeftX != null && img.topLeftY != null && img.bottomRightX != null && img.bottomRightY != null) {
          const imgArea = Math.max(0, img.bottomRightX - img.topLeftX) * Math.max(0, img.bottomRightY - img.topLeftY)
          const isFullPage = imgArea / pageArea >= FULL_PAGE_AREA_RATIO
          // Only skip when it's BOTH full-page AND text-dense — a full-page floor plan
          // with sparse labels is kept; a full-page scanned paragraph is dropped.
          if (isFullPage && pageWordCount >= DENSE_TEXT_WORD_COUNT) continue
        }

        // Mistral sometimes returns a data-URL prefix — strip it to raw base64
        const rawBase64 = img.imageBase64.replace(/^data:[^;]+;base64,/, '')
        const ext = (img.id.split('.').pop() ?? 'jpeg').toLowerCase()
        const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`
        try {
          const imgBuffer = Buffer.from(rawBase64, 'base64')
          const key = `documents/${documentId}/images/${img.id}`
          await uploadFile(key, imgBuffer, mimeType)
          const url = `/api/documents/${documentId}/images/${encodeURIComponent(img.id)}`
          imageUrlMap.set(img.id, url)
          images.push({ imageUrl: url, base64: rawBase64, mimeType, ocrText: pageText })
        } catch (imgErr) {
          console.error(`[OCR] Failed to upload image ${img.id}:`, imgErr)
        }
      }
    }
  }

  // Concatenate all pages, replacing local image refs with real served URLs
  const text = pages.map((p: { markdown?: string }) => {
    let md = p.markdown ?? ''
    md = md.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, src) => {
      const url = imageUrlMap.get(src)
      return url ? `![${alt}](${url})` : `![${alt}](${src})`
    })
    return md
  }).join('\n\n')

  // Clean up uploaded file
  await mistral.files.delete({ fileId: uploaded.id }).catch(() => {})

  return { text, images }
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ buffer })
  return result.value
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
async function extractPptx(buffer: Buffer): Promise<string> {
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
  return slides.map((s, i) => `[Slide ${i + 1}]\n${s}`).join('\n\n')
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
  if (!process.env.MISTRAL_API_KEY) return { text: '[Image file — no OCR API key configured]', images: [] }

  const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY! })
  const base64 = buffer.toString('base64')

  try {
    const result = await mistral.ocr.process({
      model: 'mistral-ocr-latest',
      document: { type: 'image_url', imageUrl: `data:image/jpeg;base64,${base64}` } as Parameters<typeof mistral.ocr.process>[0]['document'],
    })

    const pages = result.pages ?? []
    const ocrText = pages.map((p: { markdown?: string }) => stripImageMarkdown(p.markdown ?? '')).join('\n\n')
    let text = pages.map((p: { markdown?: string }) => p.markdown ?? '').join('\n\n')
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
