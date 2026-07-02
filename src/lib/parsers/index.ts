import type { DocumentType } from '@/types'
import { Mistral } from '@mistralai/mistralai'
import { uploadFile } from '@/lib/storage/minio'

export interface TableSheet {
  sheetName: string
  headers: string[]
  rows: string[][]
}

export interface ParsedDocument {
  text: string          // prose content (pdf, docx, text paste)
  tables: TableSheet[]  // structured sheets (xlsx, csv)
  fileType: DocumentType
}

export async function parseDocument(
  buffer: Buffer,
  fileType: DocumentType,
  documentId?: string
): Promise<ParsedDocument> {
  switch (fileType) {
    case 'pdf':
      return { text: await extractPdf(buffer, documentId), tables: [], fileType }
    case 'docx':
      return { text: await extractDocx(buffer), tables: [], fileType }
    case 'xlsx':
      return { text: '', tables: await extractExcelStructured(buffer), fileType }
    case 'csv':
      return { text: '', tables: [await extractCsvStructured(buffer)], fileType }
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
    default:      throw new Error(`Unsupported file type: ${fileType}`)
  }
}

async function extractPdf(buffer: Buffer, documentId?: string): Promise<string> {
  const pdfParse = (await import('pdf-parse')).default
  const result = await pdfParse(buffer)
  const text = result.text?.trim() ?? ''
  // Fall back to OCR if text extraction yields nothing meaningful
  if (text.length < 100 && process.env.MISTRAL_API_KEY) {
    return extractPdfOcr(buffer, documentId)
  }
  return text
}

async function extractPdfOcr(buffer: Buffer, documentId?: string): Promise<string> {
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

  // Build a map of image id → MinIO URL (upload each page image)
  const imageUrlMap = new Map<string, string>()
  if (documentId) {
    for (const page of result.pages ?? []) {
      for (const img of (page as { images?: { id: string; imageBase64?: string }[] }).images ?? []) {
        if (!img.imageBase64) continue
        try {
          const imgBuffer = Buffer.from(img.imageBase64, 'base64')
          const ext = img.id.split('.').pop() ?? 'jpeg'
          const key = `documents/${documentId}/images/${img.id}`
          await uploadFile(key, imgBuffer, `image/${ext}`)
          // Build a public-ish path — served via /api/documents/[id]/images/[imgId]
          imageUrlMap.set(img.id, `/api/documents/${documentId}/images/${encodeURIComponent(img.id)}`)
        } catch {
          // Non-fatal — image won't render but text still works
        }
      }
    }
  }

  // Concatenate all pages, replacing local image refs with real URLs
  const pages = result.pages ?? []
  const text = pages.map((p: { markdown?: string }) => {
    let md = p.markdown ?? ''
    // Replace ![alt](img-0.jpeg) style refs with actual served URLs
    md = md.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, src) => {
      const url = imageUrlMap.get(src)
      return url ? `![${alt}](${url})` : `![${alt}](${src})`
    })
    return md
  }).join('\n\n')

  // Clean up uploaded file
  await mistral.files.delete({ fileId: uploaded.id }).catch(() => {})

  return text
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

export function detectFileType(filename: string): DocumentType {
  const ext = filename.split('.').pop()?.toLowerCase()
  const map: Record<string, DocumentType> = {
    pdf: 'pdf',
    docx: 'docx',
    doc: 'docx',
    xlsx: 'xlsx',
    xls: 'xlsx',
    csv: 'csv',
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
]

export const MAX_FILE_SIZE = 500 * 1024 * 1024 // 500MB
