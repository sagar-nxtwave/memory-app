import { NextResponse } from 'next/server'
import { eq, desc, sql } from 'drizzle-orm'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { spaces, spaceMembers, documents, spaceVisits } from '@/lib/db/schema'

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const userId = session.user.id

  // Run all queries in parallel
  const [spaceRows, recentDocRows, lastVisitRows] = await Promise.all([
    // All spaces with stats
    db
      .select({
        id: spaces.id,
        name: spaces.name,
        description: spaces.description,
        status: spaces.status,
        documentCount: sql<number>`cast(count(${documents.id}) filter (where ${documents.status} = 'ready') as int)`,
        lastActivityAt: sql<string | null>`max(${documents.createdAt})`,
        latestDocumentName: sql<string | null>`(select name from documents where space_id = ${spaces.id} order by created_at desc limit 1)`,
      })
      .from(spaces)
      .innerJoin(spaceMembers, eq(spaceMembers.spaceId, spaces.id))
      .leftJoin(documents, eq(documents.spaceId, spaces.id))
      .where(eq(spaceMembers.userId, userId))
      .groupBy(spaces.id, spaces.name, spaces.description, spaces.status)
      .orderBy(sql`max(${documents.createdAt}) desc nulls last`),

    // All documents across all spaces, sorted by most recent
    db
      .select({
        id: documents.id,
        name: documents.name,
        fileType: documents.fileType,
        summary: documents.summary,
        risks: documents.risks,
        decisions: documents.decisions,
        createdAt: documents.createdAt,
        spaceId: spaces.id,
        spaceName: spaces.name,
      })
      .from(documents)
      .innerJoin(spaces, eq(spaces.id, documents.spaceId))
      .innerJoin(spaceMembers, eq(spaceMembers.spaceId, spaces.id))
      .where(eq(spaceMembers.userId, userId))
      .orderBy(desc(documents.createdAt)),

    // Last visit per space for this user
    db
      .select({
        spaceId: spaceVisits.spaceId,
        lastVisit: sql<string>`max(${spaceVisits.visitedAt})`,
      })
      .from(spaceVisits)
      .where(eq(spaceVisits.userId, userId))
      .groupBy(spaceVisits.spaceId),
  ])

  // Build a map of spaceId → lastVisit
  const lastVisitMap = new Map(lastVisitRows.map((r) => [r.spaceId, r.lastVisit]))

  // Annotate each space with newDocsSinceVisit
  const spacesWithSignals = spaceRows.map((s) => {
    const lastVisit = lastVisitMap.get(s.id) ?? null
    const newDocsSinceVisit = lastVisit
      ? recentDocRows.filter(
          (d) => d.spaceId === s.id && new Date(d.createdAt) > new Date(lastVisit)
        ).length
      : s.documentCount // never visited — all docs are "new"
    return { ...s, newDocsSinceVisit, lastVisitAt: lastVisit }
  })

  // Portfolio-level stats
  const totalSpaces = spaceRows.length
  const totalDocuments = spaceRows.reduce((sum, s) => sum + s.documentCount, 0)
  const spacesWithNewActivity = spacesWithSignals.filter((s) => s.newDocsSinceVisit > 0).length
  const newDocumentsTotal = spacesWithSignals.reduce((sum, s) => sum + s.newDocsSinceVisit, 0)

  return NextResponse.json({
    stats: {
      totalSpaces,
      totalDocuments,
      spacesWithNewActivity,
      newDocumentsTotal,
    },
    spaces: spacesWithSignals,
    recentDocuments: recentDocRows,
  })
}
