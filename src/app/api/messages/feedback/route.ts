import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { messageFeedback } from '@/lib/db/schema'

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { messageId, vote } = await req.json()
  if (!messageId || !['up', 'down'].includes(vote)) {
    return NextResponse.json({ error: 'messageId and vote (up|down) required' }, { status: 400 })
  }

  // Upsert: replace existing vote for this user+message
  const existing = await db
    .select()
    .from(messageFeedback)
    .where(and(eq(messageFeedback.messageId, messageId), eq(messageFeedback.userId, session.user.id)))
    .limit(1)

  if (existing.length > 0) {
    if (existing[0].vote === vote) {
      // Same vote — toggle off (delete)
      await db.delete(messageFeedback).where(eq(messageFeedback.id, existing[0].id))
      return NextResponse.json({ vote: null })
    }
    await db.update(messageFeedback).set({ vote }).where(eq(messageFeedback.id, existing[0].id))
  } else {
    await db.insert(messageFeedback).values({ messageId, userId: session.user.id, vote })
  }

  return NextResponse.json({ vote })
}
