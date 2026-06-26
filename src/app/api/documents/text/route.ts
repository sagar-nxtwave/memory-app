import { NextRequest, NextResponse, after } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { documents, spaceMembers } from '@/lib/db/schema'
import { processDocumentFromText } from '@/lib/ai/processing'

export const maxDuration = 60

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { title, content, spaceId } = await req.json()

  if (!title?.trim() || !content?.trim() || !spaceId) {
    return NextResponse.json({ error: 'title, content, and spaceId are required' }, { status: 400 })
  }

  if (content.length > 500_000) {
    return NextResponse.json({ error: 'Text too long. Maximum 500,000 characters.' }, { status: 400 })
  }

  const [member] = await db
    .select()
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, session.user.id)))
    .limit(1)

  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })

  const [doc] = await db
    .insert(documents)
    .values({
      spaceId,
      name: title.trim(),
      fileType: 'text',
      fileSize: content.length,
      storageKey: 'text-entry',
      status: 'pending',
      uploadedBy: session.user.id,
    })
    .returning()

  after(async () => {
    await processDocumentFromText(doc.id, content.trim()).catch((err) =>
      console.error('Text processing error:', err)
    )
  })

  return NextResponse.json({ ...doc, status: 'processing' }, { status: 201 })
}
