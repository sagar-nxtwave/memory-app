import { NextRequest, NextResponse, after } from 'next/server'
import { and, eq, inArray } from 'drizzle-orm'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { documents, documentChunks, spaceMembers } from '@/lib/db/schema'
import { getFileBuffer } from '@/lib/storage/minio'
import { processDocumentFromBuffer } from '@/lib/ai/processing'
import type { DocumentType } from '@/types'

export const maxDuration = 60

/**
 * POST /api/spaces/[spaceId]/reprocess
 *
 * Re-chunks and re-embeds every non-text document in the space using the
 * latest chunking strategy. Useful after chunking algorithm updates.
 * Text entries (paste) are skipped — they have no stored file to re-read.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ spaceId: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { spaceId } = await params

  const [member] = await db
    .select()
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, session.user.id)))
    .limit(1)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })

  // Fetch all file-based docs (skip text entries — no stored file)
  const allDocs = await db
    .select({ id: documents.id, fileType: documents.fileType, storageKey: documents.storageKey, status: documents.status })
    .from(documents)
    .where(and(eq(documents.spaceId, spaceId)))

  const reprocessable = allDocs.filter(d => d.fileType !== 'text' && d.status !== 'processing')

  if (reprocessable.length === 0) {
    return NextResponse.json({ queued: 0, message: 'No documents to reprocess' })
  }

  const ids = reprocessable.map(d => d.id)

  // Clear chunks and reset status for all at once
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

  // Process sequentially in background to avoid rate-limit spikes
  after(async () => {
    for (const doc of reprocessable) {
      try {
        const buffer = await getFileBuffer(doc.storageKey)
        await processDocumentFromBuffer(doc.id, buffer, doc.fileType as DocumentType)
      } catch (err) {
        console.error(`[reprocess] Failed for doc ${doc.id}:`, err)
      }
    }
  })

  return NextResponse.json({ queued: reprocessable.length })
}
