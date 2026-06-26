import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { documents, spaceMembers } from '@/lib/db/schema'
import { getFileBuffer } from '@/lib/storage/minio'

const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv',
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ documentId: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { documentId } = await params

  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1)
  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [member] = await db
    .select()
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, doc.spaceId), eq(spaceMembers.userId, session.user.id)))
    .limit(1)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })

  if (doc.fileType === 'text' || doc.storageKey === 'text-entry') {
    return NextResponse.json({ error: 'Text entries have no file to view' }, { status: 400 })
  }

  const buffer = await getFileBuffer(doc.storageKey)
  const contentType = CONTENT_TYPES[doc.fileType] ?? 'application/octet-stream'
  const disposition = doc.fileType === 'pdf' ? 'inline' : `attachment; filename="${encodeURIComponent(doc.name)}"`

  return new NextResponse(buffer, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': disposition,
      'Content-Length': String(buffer.length),
      'Cache-Control': 'private, max-age=300',
    },
  })
}
