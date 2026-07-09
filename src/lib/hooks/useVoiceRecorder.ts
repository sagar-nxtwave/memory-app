'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

// Record-then-transcribe voice input via MediaRecorder + our /api/transcribe route (OpenRouter
// Whisper). Replaces the browser-native Web Speech API path, which calls Google's speech
// service DIRECTLY from the browser — some networks block that specific endpoint while normal
// HTTPS (including every other call this app makes) works fine, producing a confusing "needs
// an internet connection" error. Routing through our own backend avoids that dependency.
//
// Same external shape as the old useSpeechToText hook (supported/listening/error/toggle/stop)
// so it drops into the existing mic button with minimal UI changes.

const ERROR_MESSAGES: Record<string, string> = {
  'not-allowed': "Microphone access was blocked. Allow microphone permission in your browser's site settings and try again.",
  'no-audio': 'No speech detected. Try again.',
  'transcribe-failed': 'Could not transcribe your voice. Please try again.',
}

export function useVoiceRecorder(onResult: (text: string) => void) {
  const [listening, setListening] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [supported, setSupported] = useState(false)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)

  // Resolve support after mount (matches the previous hook's hydration-safe pattern).
  useEffect(() => {
    setSupported(typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined')
  }, [])

  const cleanup = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    recorderRef.current = null
    chunksRef.current = []
  }, [])

  const start = useCallback(async () => {
    if (!supported || listening || transcribing) return
    setError(null)

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setError(ERROR_MESSAGES['not-allowed'])
      return
    }

    streamRef.current = stream
    chunksRef.current = []

    const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : ''
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
    recorder.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
      cleanup()
      setListening(false)

      if (blob.size < 1000) { // trivially short/empty recording
        setError(ERROR_MESSAGES['no-audio'])
        return
      }

      setTranscribing(true)
      try {
        const form = new FormData()
        form.append('audio', blob, 'voice-input.webm')
        const res = await fetch('/api/transcribe', { method: 'POST', body: form })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'failed')
        const text = (data.text ?? '').trim()
        if (text) onResult(text)
        else setError(ERROR_MESSAGES['no-audio'])
      } catch {
        setError(ERROR_MESSAGES['transcribe-failed'])
      } finally {
        setTranscribing(false)
      }
    }

    recorderRef.current = recorder
    recorder.start()
    setListening(true)
  }, [supported, listening, transcribing, onResult, cleanup])

  const stop = useCallback(() => {
    // Stop = finalize and transcribe (onstop fires and runs the request).
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop()
    } else {
      cleanup()
      setListening(false)
    }
  }, [cleanup])

  const cancel = useCallback(() => {
    // Discard without transcribing (used if the user backs out).
    const recorder = recorderRef.current
    if (recorder) {
      recorder.ondataavailable = null
      recorder.onstop = null
      if (recorder.state !== 'inactive') recorder.stop()
    }
    cleanup()
    setListening(false)
  }, [cleanup])

  const toggle = useCallback(() => {
    if (listening) stop()
    else start()
  }, [listening, start, stop])

  return { supported, listening, transcribing, error, start, stop, cancel, toggle }
}
