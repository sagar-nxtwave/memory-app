import type { DocumentType } from '@/types'

export async function extractText(
  buffer: Buffer,
  fileType: DocumentType
): Promise<string> {
  switch (fileType) {
    case 'pdf':
      return extractPdf(buffer)
    case 'docx':
      return extractDocx(buffer)
    case 'xlsx':
      return extractExcel(buffer)
    case 'csv':
      return extractCsv(buffer)
    default:
      throw new Error(`Unsupported file type: ${fileType}`)
  }
}

async function extractPdf(buffer: Buffer): Promise<string> {
  const pdfParse = (await import('pdf-parse')).default
  const result = await pdfParse(buffer)
  return result.text
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ buffer })
  return result.value
}

async function extractExcel(buffer: Buffer): Promise<string> {
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

async function extractCsv(buffer: Buffer): Promise<string> {
  return buffer.toString('utf-8')
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

export const MAX_FILE_SIZE = 50 * 1024 * 1024 // 50MB
