import { NextRequest, NextResponse, after } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { documents, spaceMembers } from '@/lib/db/schema'
import { detectFileType, ALLOWED_MIME_TYPES, MAX_FILE_SIZE } from '@/lib/parsers'
import { processDocumentFromBuffer } from '@/lib/ai/processing'
import { uploadFile, generateStorageKey } from '@/lib/storage/minio'

// Keep the function alive long enough for document processing
export const maxDuration = 60

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
      fileSize: documents.fileSize,
      status: documents.status,
      summary: documents.summary,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(eq(documents.spaceId, spaceId))
    .orderBy(documents.createdAt)

  return NextResponse.json(docs)
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const formData = await req.formData()
  const file = formData.get('file') as File | null
  const spaceId = formData.get('spaceId') as string | null

  if (!file || !spaceId) {
    return NextResponse.json({ error: 'File and spaceId are required' }, { status: 400 })
  }

  if (!ALLOWED_MIME_TYPES.includes(file.type)) {
    return NextResponse.json({ error: 'Unsupported file type. Use PDF, Word, Excel, or CSV.' }, { status: 400 })
  }

  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: 'File too large. Maximum 50MB.' }, { status: 400 })
  }

  const [member] = await db
    .select()
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, session.user.id)))
    .limit(1)

  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })

  let fileType
  try {
    fileType = detectFileType(file.name)
  } catch {
    return NextResponse.json({ error: 'Unsupported file type' }, { status: 400 })
  }

  const arrayBuffer = await file.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  // Create document record
  const [doc] = await db
    .insert(documents)
    .values({
      spaceId,
      name: file.name,
      fileType,
      fileSize: file.size,
      storageKey: 'pending',
      status: 'pending',
      uploadedBy: session.user.id,
    })
    .returning()

  // Try MinIO upload (non-blocking — processing works without it)
  try {
    const storageKey = generateStorageKey(spaceId, doc.id, file.name)
    await uploadFile(storageKey, buffer, file.type)
    await db
      .update(documents)
      .set({ storageKey })
      .where(eq(documents.id, doc.id))
  } catch {
    // MinIO not available in dev — processing continues from in-memory buffer
  }

  // after() tells Vercel to keep the Lambda alive after the response is sent
  // Without this, Vercel freezes the function immediately and processing never runs
  after(async () => {
    await processDocumentFromBuffer(doc.id, buffer, fileType).catch((err) =>
      console.error('Document processing error:', err)
    )
  })

  return NextResponse.json({ ...doc, status: 'processing' }, { status: 201 })
}
