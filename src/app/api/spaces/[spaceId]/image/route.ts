import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { spaces, spaceMembers } from '@/lib/db/schema'
import { uploadFile, deleteFile, getSignedDownloadUrl } from '@/lib/storage/minio'

const MAX_SIZE = 5 * 1024 * 1024 // 5MB
const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

async function requireMember(spaceId: string, userId: string) {
  const [member] = await db
    .select()
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
    .limit(1)
  return member
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ spaceId: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { spaceId } = await params
  const member = await requireMember(spaceId, session.user.id)
  if (!member) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [space] = await db.select({ imageKey: spaces.imageKey }).from(spaces).where(eq(spaces.id, spaceId)).limit(1)
  if (!space?.imageKey) return NextResponse.json({ error: 'No image' }, { status: 404 })

  const url = await getSignedDownloadUrl(space.imageKey, 3600)
  // Without Cache-Control, browsers re-hit this route (DB lookup + fresh signed URL) on
  // every re-render instead of caching the redirect — see the same fix on the document
  // image route. max-age kept just under the signed URL's own expiry.
  return NextResponse.redirect(url, { status: 302, headers: { 'Cache-Control': 'private, max-age=3300' } })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ spaceId: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { spaceId } = await params
  const member = await requireMember(spaceId, session.user.id)
  if (!member) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const form = await req.formData()
  const file = form.get('file')
  if (!(file instanceof File)) return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  if (file.size > MAX_SIZE) return NextResponse.json({ error: 'Image must be under 5MB' }, { status: 400 })

  const ext = ALLOWED_TYPES[file.type]
  if (!ext) return NextResponse.json({ error: 'Only JPEG, PNG, or WEBP images are allowed' }, { status: 400 })

  const [existing] = await db.select({ imageKey: spaces.imageKey }).from(spaces).where(eq(spaces.id, spaceId)).limit(1)

  const key = `spaces/${spaceId}/cover-${Date.now()}.${ext}`
  const buffer = Buffer.from(await file.arrayBuffer())
  await uploadFile(key, buffer, file.type)

  await db.update(spaces).set({ imageKey: key, updatedAt: new Date() }).where(eq(spaces.id, spaceId))

  if (existing?.imageKey) await deleteFile(existing.imageKey).catch(() => {})

  return NextResponse.json({ success: true, imageKey: key })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ spaceId: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { spaceId } = await params
  const member = await requireMember(spaceId, session.user.id)
  if (!member) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [existing] = await db.select({ imageKey: spaces.imageKey }).from(spaces).where(eq(spaces.id, spaceId)).limit(1)
  if (existing?.imageKey) await deleteFile(existing.imageKey).catch(() => {})

  await db.update(spaces).set({ imageKey: null, updatedAt: new Date() }).where(eq(spaces.id, spaceId))

  return NextResponse.json({ success: true })
}
