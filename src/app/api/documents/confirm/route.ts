import { NextRequest, NextResponse, after } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { documents, spaceMembers } from '@/lib/db/schema'
import { getFileBuffer } from '@/lib/storage/minio'
import { processDocumentFromBuffer } from '@/lib/ai/processing'
import type { DocumentType } from '@/types'

export const maxDuration = 60

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { documentId } = await req.json()
  if (!documentId) return NextResponse.json({ error: 'documentId required' }, { status: 400 })

  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1)
  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [member] = await db
    .select()
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, doc.spaceId), eq(spaceMembers.userId, session.user.id)))
    .limit(1)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })

  after(async () => {
    try {
      const buffer = await getFileBuffer(doc.storageKey)
      await processDocumentFromBuffer(doc.id, buffer, doc.fileType as DocumentType)
    } catch (err) {
      console.error('[confirm] Processing failed:', err)
      await db
        .update(documents)
        .set({ status: 'failed', failureReason: 'Processing failed — try re-uploading.', updatedAt: new Date() })
        .where(eq(documents.id, doc.id))
        .catch(() => {})
    }
  })

  return NextResponse.json({ status: 'processing' })
}
