import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { spaceMembers } from '@/lib/db/schema'

export async function checkSpaceAccess(spaceId: string, userId: string): Promise<boolean> {
  const [member] = await db
    .select({ id: spaceMembers.id })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
    .limit(1)
  return !!member
}
