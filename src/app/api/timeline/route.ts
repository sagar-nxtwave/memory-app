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
      risks: documents.risks,
      keyNumbers: documents.keyNumbers,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(eq(documents.spaceId, spaceId))
    .orderBy(asc(documents.createdAt))

  // Flatten each document into individual events — one per decision, risk, key number
  // The document upload itself is a baseline event; extracted facts are the real story
  type EventType = 'document' | 'decision' | 'risk' | 'number'
  interface TimelineEvent {
    id: string
    type: EventType
    text: string
    sourceName: string
    sourceFileType: string
    date: string
    status: string
  }

  const events: TimelineEvent[] = []

  for (const doc of docs) {
    // Always emit the document upload event
    events.push({
      id: `doc-${doc.id}`,
      type: 'document',
      text: doc.status === 'ready' && doc.summary
        ? doc.summary.split(/[.!?]/)[0].trim()  // first sentence only
        : doc.status === 'failed' ? 'Processing failed'
        : 'Processing…',
      sourceName: doc.name,
      sourceFileType: doc.fileType,
      date: doc.createdAt,
      status: doc.status,
    })

    if (doc.status !== 'ready') continue

    // One event per decision
    for (const [i, decision] of (doc.decisions ?? []).entries()) {
      events.push({
        id: `decision-${doc.id}-${i}`,
        type: 'decision',
        text: decision,
        sourceName: doc.name,
        sourceFileType: doc.fileType,
        date: doc.createdAt,
        status: 'ready',
      })
    }

    // One event per risk
    for (const [i, risk] of (doc.risks ?? []).entries()) {
      events.push({
        id: `risk-${doc.id}-${i}`,
        type: 'risk',
        text: risk,
        sourceName: doc.name,
        sourceFileType: doc.fileType,
        date: doc.createdAt,
        status: 'ready',
      })
    }

    // One event per key number
    for (const [i, number] of (doc.keyNumbers ?? []).entries()) {
      events.push({
        id: `number-${doc.id}-${i}`,
        type: 'number',
        text: number,
        sourceName: doc.name,
        sourceFileType: doc.fileType,
        date: doc.createdAt,
        status: 'ready',
      })
    }
  }

  return NextResponse.json(events)
}
