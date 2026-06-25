import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { spaces, spaceMembers, spaceVisits } from '@/lib/db/schema'

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

  const [space] = await db
    .select()
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .limit(1)

  // Get last visit before recording the new one (used by Catch Me Up)
  const [lastVisit] = await db
    .select({ visitedAt: spaceVisits.visitedAt })
    .from(spaceVisits)
    .where(and(eq(spaceVisits.spaceId, spaceId), eq(spaceVisits.userId, session.user.id)))
    .orderBy(spaceVisits.visitedAt)
    .limit(1)

  // Record this visit
  await db.insert(spaceVisits).values({ spaceId, userId: session.user.id })

  return NextResponse.json({ ...space, lastVisit: lastVisit?.visitedAt ?? null })
}
