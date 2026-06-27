import { NextRequest, NextResponse } from 'next/server'
import { and, desc, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { spaces, spaceMembers, spaceVisits, documents } from '@/lib/db/schema'
import { deleteFile } from '@/lib/storage/minio'

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ spaceId: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { spaceId } = await params

  // Only the owner can delete a space
  const [member] = await db
    .select()
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, session.user.id)))
    .limit(1)

  if (!member || member.role !== 'owner') return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })

  // Fetch all document storage keys before the cascade delete wipes them
  const docs = await db
    .select({ storageKey: documents.storageKey, fileType: documents.fileType })
    .from(documents)
    .where(eq(documents.spaceId, spaceId))

  // Delete physical files from MinIO (skip text entries — they have no real file)
  await Promise.allSettled(
    docs
      .filter((d) => d.fileType !== 'text')
      .map((d) => deleteFile(d.storageKey))
  )

  // Delete space — cascade handles documents, chunks, embeddings, messages, visits
  await db.delete(spaces).where(eq(spaces.id, spaceId))

  return NextResponse.json({ success: true })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ spaceId: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { spaceId } = await params
  const { name } = await req.json()
  if (!name?.trim()) return NextResponse.json({ error: 'Name is required' }, { status: 400 })

  const [member] = await db
    .select()
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, session.user.id)))
    .limit(1)

  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })

  const [updated] = await db
    .update(spaces)
    .set({ name: name.trim(), updatedAt: new Date() })
    .where(eq(spaces.id, spaceId))
    .returning()

  return NextResponse.json(updated)
}

export async function GET(
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

  if (!member) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Fetch space details and last visit in parallel — they're independent queries
  const [[space], [lastVisit]] = await Promise.all([
    db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1),
    db
      .select({ visitedAt: spaceVisits.visitedAt })
      .from(spaceVisits)
      .where(and(eq(spaceVisits.spaceId, spaceId), eq(spaceVisits.userId, session.user.id)))
      .orderBy(desc(spaceVisits.visitedAt))
      .limit(1),
  ])

  // Record this visit (fire-and-forget — don't block the response)
  db.insert(spaceVisits).values({ spaceId, userId: session.user.id }).catch(() => {})

  return NextResponse.json({ ...space, lastVisit: lastVisit?.visitedAt ?? null })
}
