import { NextRequest, NextResponse } from 'next/server'
import { and, eq, asc } from 'drizzle-orm'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { documents, spaceMembers } from '@/lib/db/schema'

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const spaceId = req.nextUrl.searchParams.get('spaceId')
  if (!spaceId) return NextResponse.json({ error: 'spaceId required' }, { status: 400 })

  const [member] = await db
    .select()
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, session.user.id)))
    .limit(1)

  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })

  const docs = await db
    .select({
      id: documents.id,
      name: documents.name,
      fileType: documents.fileType,
      status: documents.status,
      summary: documents.summary,
      decisions: documents.decisions,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(eq(documents.spaceId, spaceId))
    .orderBy(asc(documents.createdAt))

  const events = docs.map((doc) => ({
    id: doc.id,
    type: 'document',
    title: doc.name,
    subtitle: doc.status === 'ready' && doc.summary ? doc.summary.slice(0, 120) + '…' : `Processing…`,
    decisions: doc.decisions ?? [],
    date: doc.createdAt,
    status: doc.status,
    fileType: doc.fileType,
  }))

  return NextResponse.json(events)
}
