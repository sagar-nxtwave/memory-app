import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { documents, spaceMembers } from '@/lib/db/schema'
import { getSignedDownloadUrl } from '@/lib/storage/minio'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ documentId: string; imgId: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) return new NextResponse('Unauthorized', { status: 401 })

  const { documentId, imgId } = await params

  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1)
  if (!doc) return new NextResponse('Not found', { status: 404 })

  const [member] = await db
    .select()
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, doc.spaceId), eq(spaceMembers.userId, session.user.id)))
    .limit(1)
  if (!member) return new NextResponse('Unauthorized', { status: 403 })

  const key = `documents/${documentId}/images/${decodeURIComponent(imgId)}`

  try {
    const signedUrl = await getSignedDownloadUrl(key, 3600)
    // Browsers don't cache 302s without an explicit Cache-Control — without this, every
    // re-render/scroll-back-into-view re-triggers the DB lookups + a fresh signed URL.
    // max-age kept just under the signed URL's own expiry so we never cache a dead redirect.
    return NextResponse.redirect(signedUrl, {
      status: 302,
      headers: { 'Cache-Control': 'private, max-age=3300' },
    })
  } catch {
    return new NextResponse('Image not found', { status: 404 })
  }
}
