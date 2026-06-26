import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { documents, spaceMembers } from '@/lib/db/schema'
import { deleteFile } from '@/lib/storage/minio'

async function getMemberDoc(documentId: string, userId: string) {
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1)
  if (!doc) return { doc: null, member: null }
  const [member] = await db
    .select()
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, doc.spaceId), eq(spaceMembers.userId, userId)))
    .limit(1)
  return { doc, member }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ documentId: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { documentId } = await params
  const { doc, member } = await getMemberDoc(documentId, session.user.id)

  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })

  return NextResponse.json(doc)
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ documentId: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { documentId } = await params
  const { doc, member } = await getMemberDoc(documentId, session.user.id)

  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })

  const body = await req.json()
  const name = body.name?.trim()
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })

  const [updated] = await db
    .update(documents)
    .set({ name, updatedAt: new Date() })
    .where(eq(documents.id, documentId))
    .returning()

  return NextResponse.json(updated)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ documentId: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { documentId } = await params
  const { doc, member } = await getMemberDoc(documentId, session.user.id)

  if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })

  if (doc.storageKey && doc.storageKey !== 'pending' && doc.storageKey !== 'text-entry') {
    try { await deleteFile(doc.storageKey) } catch {}
  }

  await db.delete(documents).where(eq(documents.id, documentId))

  return NextResponse.json({ success: true })
}
