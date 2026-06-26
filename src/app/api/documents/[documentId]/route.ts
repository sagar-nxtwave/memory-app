import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { documents, spaceMembers } from '@/lib/db/schema'
import { deleteFile } from '@/lib/storage/minio'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ documentId: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { documentId } = await params

  const [doc] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1)

  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [member] = await db
    .select()
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, doc.spaceId), eq(spaceMembers.userId, session.user.id)))
    .limit(1)

  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })

  return NextResponse.json(doc)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ documentId: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { documentId } = await params

  const [doc] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1)

  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [member] = await db
    .select()
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, doc.spaceId), eq(spaceMembers.userId, session.user.id)))
    .limit(1)

  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })

  if (doc.storageKey && doc.storageKey !== 'pending') {
    try { await deleteFile(doc.storageKey) } catch {}
  }

  await db.delete(documents).where(eq(documents.id, documentId))

  return NextResponse.json({ success: true })
}
