import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { documents, spaceMembers } from '@/lib/db/schema'
import { uploadFile, generateStorageKey } from '@/lib/storage/minio'
import { detectFileType } from '@/lib/parsers'

const BUCKET = process.env.MINIO_BUCKET ?? 'memory-docs'

export async function PUT(req: NextRequest, { params }: { params: Promise<{ documentId: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { documentId } = await params

  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1)
  if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 })

  const [member] = await db
    .select()
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, doc.spaceId), eq(spaceMembers.userId, session.user.id)))
    .limit(1)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })

  const contentType = req.headers.get('content-type') || 'application/octet-stream'
  const buffer = Buffer.from(await req.arrayBuffer())

  if (buffer.length === 0) return NextResponse.json({ error: 'Empty body' }, { status: 400 })

  const storageKey = doc.storageKey === 'pending'
    ? generateStorageKey(doc.spaceId, doc.id, doc.name)
    : doc.storageKey

  try {
    await uploadFile(storageKey, buffer, contentType)
    await db.update(documents).set({ storageKey, fileSize: buffer.length }).where(eq(documents.id, doc.id))
    return NextResponse.json({ ok: true, storageKey })
  } catch (err) {
    console.error('Proxy upload error:', err)
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
  }
}
