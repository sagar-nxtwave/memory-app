import { NextRequest, NextResponse } from 'next/server'
import { and, eq, desc } from 'drizzle-orm'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { documents, spaceMembers } from '@/lib/db/schema'
import { detectFileType, MAX_FILE_SIZE } from '@/lib/parsers'
import { generateStorageKey, s3Client } from '@/lib/storage/minio'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const BUCKET = process.env.MINIO_BUCKET ?? 'memory-docs'

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { spaceId, fileName, fileSize, customName } = await req.json()

  if (!spaceId || !fileName) return NextResponse.json({ error: 'spaceId and fileName required' }, { status: 400 })
  if (fileSize > MAX_FILE_SIZE) return NextResponse.json({ error: 'File too large. Maximum 500MB.' }, { status: 400 })

  let fileType
  try {
    fileType = detectFileType(fileName)
  } catch {
    return NextResponse.json({ error: 'Unsupported file type. Use PDF, Word, Excel, or CSV.' }, { status: 400 })
  }

  const [member] = await db
    .select()
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, session.user.id)))
    .limit(1)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })

  const docName = customName?.trim() || fileName
  const [existingDoc] = await db
    .select({ version: documents.version })
    .from(documents)
    .where(and(eq(documents.spaceId, spaceId), eq(documents.name, docName)))
    .orderBy(desc(documents.version))
    .limit(1)
  const nextVersion = existingDoc ? existingDoc.version + 1 : 1

  // Create DB record first so we have the documentId for the storage key
  const [doc] = await db
    .insert(documents)
    .values({
      spaceId,
      name: docName,
      fileType,
      fileSize,
      storageKey: 'pending',
      status: 'pending',
      uploadedBy: session.user.id,
      version: nextVersion,
    })
    .returning()

  const storageKey = generateStorageKey(spaceId, doc.id, fileName)

  // Generate presigned PUT URL — browser uploads directly to B2/MinIO
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: storageKey,
    ContentLength: fileSize,
  })
  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 })

  // Save storage key immediately so confirm route can find it
  await db.update(documents).set({ storageKey }).where(eq(documents.id, doc.id))

  return NextResponse.json({ documentId: doc.id, uploadUrl, storageKey })
}
