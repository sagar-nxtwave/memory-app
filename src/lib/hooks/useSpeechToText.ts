'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

// Minimal shape of the Web Speech API — not in lib.dom.d.ts by default.
interface SpeechRecognitionResultLike {
  [index: number]: { transcript: string }
}
interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike>
}
interface SpeechRecognitionErrorLike {
  error: string
}
interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  maxAlternatives: number
  continuous: boolean
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onend: (() => void) | null
  onerror: ((e: SpeechRecognitionErrorLike) => void) | null
  onstart: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

const ERROR_MESSAGES: Record<string, string> = {
  'not-allowed': 'Microphone access was blocked. Allow microphone permission in your browser\'s site settings and try again.',
  'permission-denied': 'Microphone access was blocked. Allow microphone permission in your browser\'s site settings and try again.',
  'no-speech': 'No speech detected. Try again.',
  'audio-capture': 'No microphone found. Check your device\'s microphone.',
  'network': 'Speech recognition needs an internet connection. Check your connection and try again.',
  'aborted': '',
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike
    webkitSpeechRecognition?: new () => SpeechRecognitionLike
  }
}

/**
 * Browser-native speech-to-text (Web Speech API). No server round trip —
 * transcription happens in-browser (Chrome/Edge/Safari), text is handed to onResult.
 */
export function useSpeechToText(onResult: (text: string) => void) {
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)

  // Resolve browser support AFTER mount. Computing it during render (typeof window …) yields
  // false on the server but true on the client's first render, causing a hydration mismatch
  // on the mic button's disabled/title attributes. Starting false and updating in an effect
  // keeps SSR and first client render identical.
  const [supported, setSupported] = useState(false)
  useEffect(() => {
    setSupported(!!(window.SpeechRecognition || window.webkitSpeechRecognition))
  }, [])

  const start = useCallback(async () => {
    if (!supported || listening) return
    setError(null)

    // Explicitly request mic permission first — some Chromium builds fail the
    // SpeechRecognition prompt silently (recognition just ends with no error) if this
    // isn't requested directly via getUserMedia first.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((t) => t.stop())
    } catch {
      setError(ERROR_MESSAGES['not-allowed'])
      return
    }

    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (!Ctor) return
    const recognition = new Ctor()
    recognition.lang = 'en-US'
    recognition.interimResults = false
    recognition.maxAlternatives = 1
    recognition.continuous = false
    recognition.onresult = (e) => {
      const transcript = Array.from(e.results).map((r) => r[0].transcript).join(' ').trim()
      if (transcript) onResult(transcript)
    }
    recognition.onstart = () => setError(null)
    recognition.onend = () => { recognitionRef.current = null; setListening(false) }
    recognition.onerror = (e) => {
      recognitionRef.current = null
      setListening(false)
      const message = ERROR_MESSAGES[e.error] ?? `Voice input failed (${e.error}). Try again.`
      if (message) setError(message)
    }
    recognitionRef.current = recognition
    try {
      recognition.start()
      setListening(true)
    } catch {
      setError('Could not start voice input. Try again.')
    }
  }, [supported, listening, onResult])

  const stop = useCallback(() => {
    const rec = recognitionRef.current
    if (rec) {
      // Detach handlers first so a result/error that fires mid-teardown can't sneak
      // stale text into the input after the user has explicitly clicked Stop.
      rec.onresult = null
      rec.onerror = null
      rec.onend = null
      rec.abort()
    }
    recognitionRef.current = null
    setListening(false)
  }, [])

  const toggle = useCallback(() => {
    if (listening) stop()
    else start()
  }, [listening, start, stop])

  return { supported, listening, error, start, stop, toggle }
}
