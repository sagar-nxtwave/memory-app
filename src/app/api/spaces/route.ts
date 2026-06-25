import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { spaces, spaceMembers } from '@/lib/db/schema'

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const userSpaces = await db
    .select({ id: spaces.id, name: spaces.name, description: spaces.description, createdAt: spaces.createdAt })
    .from(spaces)
    .innerJoin(spaceMembers, eq(spaceMembers.spaceId, spaces.id))
    .where(eq(spaceMembers.userId, session.user.id))
    .orderBy(spaces.createdAt)

  return NextResponse.json(userSpaces)
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { name, description } = await req.json()
  if (!name?.trim()) return NextResponse.json({ error: 'Name is required' }, { status: 400 })

  const [space] = await db
    .insert(spaces)
    .values({ name: name.trim(), description: description?.trim() ?? null, createdBy: session.user.id })
    .returning()

  await db.insert(spaceMembers).values({ spaceId: space.id, userId: session.user.id, role: 'owner' })

  return NextResponse.json(space, { status: 201 })
}
