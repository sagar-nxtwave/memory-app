import { NextRequest, NextResponse, after } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { documents, documentChunks, spaceMembers } from '@/lib/db/schema'
import { getFileBuffer } from '@/lib/storage/minio'
import { processDocumentFromBuffer, processDocumentFromText } from '@/lib/ai/processing'
import type { DocumentType } from '@/types'

export const maxDuration = 60

export async function POST(
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

  if (doc.status === 'processing') {
    return NextResponse.json({ error: 'Already processing' }, { status: 409 })
  }

  // Clear old chunks and reset status
  await db.delete(documentChunks).where(eq(documentChunks.documentId, documentId))
  await db
    .update(documents)
    .set({ status: 'pending', failureReason: null, summary: null, keyNumbers: null, risks: null, decisions: null, importantDates: null, updatedAt: new Date() })
    .where(eq(documents.id, documentId))

  if (doc.fileType === 'text') {
    return NextResponse.json({ error: 'Text entries cannot be retried — please delete and re-paste.' }, { status: 400 })
  }

  after(async () => {
    try {
      const buffer = await getFileBuffer(doc.storageKey)
      await processDocumentFromBuffer(documentId, buffer, doc.fileType as DocumentType)
    } catch (err) {
      console.error('Retry processing error:', err)
      // Mark as failed so user sees it instead of staying stuck at pending
      await db
        .update(documents)
        .set({ status: 'failed', failureReason: 'Could not read file from storage — delete and re-upload.', updatedAt: new Date() })
        .where(eq(documents.id, documentId))
        .catch(() => {})
    }
  })

  return NextResponse.json({ status: 'processing' })
}
