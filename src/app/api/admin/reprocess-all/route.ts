import { NextRequest, NextResponse, after } from 'next/server'
import { eq, inArray, ne } from 'drizzle-orm'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { documents, documentChunks, spaceMembers } from '@/lib/db/schema'
import { getFileBuffer } from '@/lib/storage/minio'
import { processDocumentFromBuffer } from '@/lib/ai/processing'
import type { DocumentType } from '@/types'

export const maxDuration = 60

export async function POST(_req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Get all spaces this user is a member of
  const memberships = await db
    .select({ spaceId: spaceMembers.spaceId })
    .from(spaceMembers)
    .where(eq(spaceMembers.userId, session.user.id))

  const spaceIds = memberships.map(m => m.spaceId)
  if (spaceIds.length === 0) return NextResponse.json({ queued: 0 })

  // Get all reprocessable docs across all spaces
  const allDocs = await db
    .select({ id: documents.id, fileType: documents.fileType, storageKey: documents.storageKey })
    .from(documents)
    .where(inArray(documents.spaceId, spaceIds))

  const reprocessable = allDocs.filter(
    d => d.fileType !== 'text' && d.storageKey && d.storageKey !== 'pending'
  )

  if (reprocessable.length === 0) {
    return NextResponse.json({ queued: 0, message: 'No documents to reprocess' })
  }

  const ids = reprocessable.map(d => d.id)

  await db.delete(documentChunks).where(inArray(documentChunks.documentId, ids))
  await db
    .update(documents)
    .set({
      status: 'pending',
      failureReason: null,
      summary: null,
      keyNumbers: null,
      risks: null,
      decisions: null,
      importantDates: null,
      updatedAt: new Date(),
    })
    .where(inArray(documents.id, ids))

  after(async () => {
    for (const doc of reprocessable) {
      try {
        const buffer = await getFileBuffer(doc.storageKey)
        await processDocumentFromBuffer(doc.id, buffer, doc.fileType as DocumentType)
      } catch (err) {
        console.error(`[reprocess-all] Failed for doc ${doc.id}:`, err)
        await db
          .update(documents)
          .set({ status: 'failed', failureReason: 'Could not read file from storage — delete and re-upload.', updatedAt: new Date() })
          .where(inArray(documents.id, [doc.id]))
          .catch(() => {})
      }
    }
  })

  return NextResponse.json({ queued: reprocessable.length })
}
