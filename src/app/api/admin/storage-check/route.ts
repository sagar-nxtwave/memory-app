import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { documents, spaceMembers } from '@/lib/db/schema'

export async function GET(_req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const memberships = await db
    .select({ spaceId: spaceMembers.spaceId })
    .from(spaceMembers)
    .where(eq(spaceMembers.userId, session.user.id))

  const spaceIds = memberships.map(m => m.spaceId)

  const allDocs = await db
    .select({ id: documents.id, name: documents.name, storageKey: documents.storageKey, status: documents.status, fileType: documents.fileType })
    .from(documents)

  const filtered = allDocs.filter(d => spaceIds.includes((d as any).spaceId) || true)

  return NextResponse.json({
    total: filtered.length,
    pending_storage: filtered.filter(d => d.storageKey === 'pending').map(d => ({ id: d.id, name: d.name, status: d.status, fileType: d.fileType })),
    has_storage: filtered.filter(d => d.storageKey !== 'pending').map(d => ({ id: d.id, name: d.name, storageKey: d.storageKey, status: d.status })),
  })
}
