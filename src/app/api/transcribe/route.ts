import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth/config'
import { transcribeAudio } from '@/lib/ai/provider'

export const maxDuration = 30

// Max recorded clip size — a short voice question is a few hundred KB; this bounds abuse
// without constraining any realistic use.
const MAX_AUDIO_BYTES = 15 * 1024 * 1024

/**
 * POST /api/transcribe — records-audio-then-transcribes fallback for voice input.
 * Routes through OpenRouter's Whisper endpoint (our backend, already proven reachable) instead
 * of the browser calling Google's speech service directly, which some networks block outright.
 */
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const form = await req.formData().catch(() => null)
  const file = form?.get('audio')
  if (!file || !(file instanceof Blob)) {
    return NextResponse.json({ error: 'audio file required' }, { status: 400 })
  }
  if (file.size === 0) return NextResponse.json({ error: 'Empty audio' }, { status: 400 })
  if (file.size > MAX_AUDIO_BYTES) return NextResponse.json({ error: 'Audio too large' }, { status: 413 })

  try {
    const text = await transcribeAudio(file, 'voice-input.webm')
    return NextResponse.json({ text })
  } catch (err) {
    console.error('[transcribe] failed:', err)
    return NextResponse.json({ error: 'Transcription failed. Please try again.' }, { status: 502 })
  }
}
