import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth/config'
import { getFileBuffer } from '@/lib/storage/minio'

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const key = req.nextUrl.searchParams.get('key')
  if (!key) return NextResponse.json({ error: 'key param required' }, { status: 400 })

  try {
    const buffer = await getFileBuffer(key)
    return NextResponse.json({ ok: true, bytes: buffer.length })
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: (err as any)?.Code ?? (err as any)?.code ?? null,
      statusCode: (err as any)?.$metadata?.httpStatusCode ?? null,
    })
  }
}
