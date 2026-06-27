import { NextRequest, NextResponse } from 'next/server'
import { eq, sql } from 'drizzle-orm'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { spaces, spaceMembers, documents } from '@/lib/db/schema'

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const userSpaces = await db
    .select({
      id: spaces.id,
      name: spaces.name,
      description: spaces.description,
      createdAt: spaces.createdAt,
      documentCount: sql<number>`cast(count(${documents.id}) filter (where ${documents.status} = 'ready') as int)`,
      lastActivityAt: sql<string | null>`max(${documents.createdAt})`,
    })
    .from(spaces)
    .innerJoin(spaceMembers, eq(spaceMembers.spaceId, spaces.id))
    .leftJoin(documents, eq(documents.spaceId, spaces.id))
    .where(eq(spaceMembers.userId, session.user.id))
    .groupBy(spaces.id, spaces.name, spaces.description, spaces.createdAt)
    .orderBy(sql`max(${documents.createdAt}) desc nulls last, ${spaces.createdAt} desc`)

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
