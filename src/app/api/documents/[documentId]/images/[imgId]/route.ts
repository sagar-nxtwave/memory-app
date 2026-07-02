import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { documents, spaceMembers } from '@/lib/db/schema'
import { getFileBuffer } from '@/lib/storage/minio'

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
    const buffer = await getFileBuffer(key)
    const ext = imgId.split('.').pop()?.toLowerCase() ?? 'jpeg'
    const contentType = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
    return new NextResponse(buffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch {
    return new NextResponse('Image not found', { status: 404 })
  }
}
