'use client'

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useVoiceRecorder } from '@/lib/hooks/useVoiceRecorder'
import { useSpacesList } from '@/lib/hooks/useSpacesList'

interface Citation { documentId?: string; documentName: string; spaceName?: string; url?: string; sourceType?: 'internal' | 'web'; citationId?: string }
interface DocumentImage { url: string; alt: string; documentName: string; spaceName?: string }
interface Message { id: string; role: 'user' | 'assistant'; content: string; createdAt?: string; isTyping?: boolean; citations?: Citation[]; documentImages?: DocumentImage[]; thinkingSteps?: string[]; thinkingStepActions?: string[]; thinkingStepResults?: string[]; suggestions?: string[] }
interface SpaceDoc { id: string; name: string; fileType: string }
interface MentionChip { spaceId: string; spaceName: string; docId?: string; docName?: string }

const msgVariants = {
  hidden: { opacity: 0, y: 10, scale: 0.98 },
  show: { opacity: 1, y: 0, scale: 1, transition: { type: 'spring' as const, stiffness: 500, damping: 30 } },
}

const SUGGESTIONS = [
  'What is the current status across all my projects?',
  'What are the biggest risks I should be aware of?',
  'What major decisions have been made recently?',
  'Which projects need my attention right now?',
]

export function GlobalChatPanel({ onClose, autoStartMic }: { onClose?: () => void; autoStartMic?: boolean } = {}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [streamingId, setStreamingId] = useState<string | null>(null)
  const [historyLoaded, setHistoryLoaded] = useState(false)

  const { spaces, loaded: spacesLoaded } = useSpacesList()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const selectionInitialized = useRef(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const [responseStyle, setResponseStyle] = useState<'short' | 'detailed'>('short')

  const [mentionChips, setMentionChips] = useState<MentionChip[]>([])
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionStage, setMentionStage] = useState<'space' | 'doc'>('space')
  const [mentionSpaceCtx, setMentionSpaceCtx] = useState<{ id: string; name: string } | null>(null)
  const [mentionActiveIdx, setMentionActiveIdx] = useState(0)
  const [spaceDocs, setSpaceDocs] = useState<Record<string, SpaceDoc[]>>({})

  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const filterRef = useRef<HTMLDivElement>(null)

  const handleSpeechResult = useCallback((transcript: string) => {
    setInput((prev) => (prev ? `${prev} ${transcript}` : transcript))
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [])
  const speech = useVoiceRecorder(handleSpeechResult)
  const autoMicFired = useRef(false)

  // Load persisted history (spaces list comes from the shared useSpacesList cache instead
  // of its own fetch — avoids re-hitting /api/spaces every time this panel remounts, e.g.
  // each time the home page's inline Ask panel is reopened)
  useEffect(() => {
    fetch('/api/global-chat')
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        if (Array.isArray(data)) setMessages(data)
        setHistoryLoaded(true)
      })
      .catch(() => setHistoryLoaded(true))
  }, [])

  // Default selection to "all spaces" once, the first time the list becomes available
  useEffect(() => {
    if (spacesLoaded && !selectionInitialized.current) {
      selectionInitialized.current = true
      setSelectedIds(new Set(spaces.map((s) => s.id)))
    }
  }, [spacesLoaded, spaces])

  // Auto-start voice capture when opened via the home page mic icon
  useEffect(() => {
    if (autoStartMic && speech.supported && !autoMicFired.current) {
      autoMicFired.current = true
      speech.start()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStartMic, speech.supported])

  // Close filter dropdown when clicking outside
  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false)
      }
    }
    if (filterOpen) document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [filterOpen])

  useEffect(() => {
    if (!historyLoaded) return
    if (streamingId) {
      bottomRef.current?.scrollIntoView()
    } else {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, streamingId, historyLoaded])

  function loadSpaceDocs(spaceId: string) {
    if (spaceDocs[spaceId]) return
    fetch(`/api/documents?spaceId=${spaceId}`)
      .then((r) => r.ok ? r.json() : [])
      .then((data: SpaceDoc[]) => {
        if (Array.isArray(data))
          setSpaceDocs((p) => ({ ...p, [spaceId]: data.filter((d) => (d as SpaceDoc & { status: string }).status === 'ready') }))
      })
  }

  function toggleSpace(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        if (next.size === 1) return prev // always keep at least one
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const allSelected = spaces.length > 0 && selectedIds.size === spaces.length

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim() || loading) return
    setInput('')
    const chips = mentionChips
    setMentionChips([])
    setMentionQuery(null)
    setLoading(true)

    const tempUserId = `u-${Date.now()}`
    const sid = `s-${Date.now()}`

    setMessages((p) => [
      ...p,
      { id: tempUserId, role: 'user', content },
      { id: sid, role: 'assistant', content: '', thinkingSteps: [] },
    ])
    setStreamingId(sid)

    try {
      const res = await fetch('/api/global-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          spaceIds: chips.length > 0 ? [...new Set(chips.map((c) => c.spaceId))] : Array.from(selectedIds),
          mentionedDocIds: chips.filter((c) => c.docId).map((c) => c.docId!),
          responseStyle,
        }),
      })

      if (!res.ok || !res.body) throw new Error('Stream failed')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let accumulated = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const event = JSON.parse(line.slice(6))
            if (event.type === 'start') {
              setMessages((p) => p.map((m) => (m.id === tempUserId ? { ...m, id: event.userMessageId } : m)))
            } else if (event.type === 'thinking') {
              setMessages((p) => p.map((m) => {
                if (m.id !== sid) return m
                const steps = [...(m.thinkingSteps ?? []), event.step]
                const actions = [...(m.thinkingStepActions ?? []), event.action ?? '']
                const results = [...(m.thinkingStepResults ?? []), event.result ?? '']
                return { ...m, thinkingSteps: steps, thinkingStepActions: actions, thinkingStepResults: results }
              }))
            } else if (event.type === 'delta') {
              accumulated += event.content
            } else if (event.type === 'done') {
              const finalContent = accumulated
              setMessages((p) => p.map((m) => {
                if (m.id !== sid) return m
                return { ...m, content: finalContent, isTyping: true, citations: event.citations ?? [], documentImages: event.documentImages ?? [], suggestions: event.suggestions ?? [], ...(event.assistantMessageId ? { id: event.assistantMessageId } : {}) }
              }))
            } else if (event.type === 'error') {
              setMessages((p) => p.map((m) => (m.id === sid ? { ...m, content: event.message ?? 'Something went wrong.' } : m)))
            }
          } catch {}
        }
      }
    } catch {
      setMessages((p) =>
        p.map((m) => (m.id === sid ? { ...m, content: 'Something went wrong. Please try again.' } : m))
      )
    } finally {
      setStreamingId(null)
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [loading, selectedIds, mentionChips, responseStyle])

  const handleTypingDone = useCallback((id: string) => {
    setMessages((p) => p.map((m) => (m.id === id ? { ...m, isTyping: false } : m)))
  }, [])

  const isEmpty = messages.length === 0
  const selectedCount = selectedIds.size

  const selectionLabel = allSelected
    ? 'All projects'
    : `${selectedCount} of ${spaces.length} project${spaces.length !== 1 ? 's' : ''}`

  return (
    <div className="flex flex-col h-full bg-white dark:bg-[#0f0f0f]">
      {/* Header */}
      <motion.header
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-800 shrink-0 bg-white/80 dark:bg-[#0f0f0f]/80 backdrop-blur-sm"
      >
        {onClose && (
          <button
            onClick={onClose}
            title="Back to home"
            className="shrink-0 h-8 w-8 flex items-center justify-center text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
          </button>
        )}
        <div className={`${onClose ? '' : 'pl-12 md:pl-0'} flex-1 min-w-0`}>
          <h1 className="font-semibold text-gray-900 dark:text-white text-sm">All Projects</h1>
          <p className="text-xs text-gray-900 dark:text-gray-500">Ask questions across your portfolio</p>
        </div>

        {/* Project filter — compact dropdown, only shown when 2+ spaces */}
        {spacesLoaded && spaces.length >= 2 && (
          <div className="relative shrink-0" ref={filterRef}>
            <motion.button
              whileTap={{ scale: 0.96 }}
              onClick={() => setFilterOpen((o) => !o)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded-xl transition-all ${
                filterOpen
                  ? 'border-gray-400 dark:border-gray-500 text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-900'
                  : 'border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600'
              }`}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
              </svg>
              {selectionLabel}
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className={`transition-transform ${filterOpen ? 'rotate-180' : ''}`}>
                <path d="M6 9l6 6 6-6" />
              </svg>
            </motion.button>

            <AnimatePresence>
              {filterOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -6, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -6, scale: 0.97 }}
                  transition={{ duration: 0.14 }}
                  className="absolute right-0 top-full mt-1.5 w-56 bg-white dark:bg-[#1c1c1c] border border-gray-200 dark:border-gray-700 rounded-2xl shadow-xl z-20 overflow-hidden"
                >
                  {/* Header row */}
                  <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-gray-100 dark:border-gray-800">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-900 dark:text-gray-500">Projects</span>
                    <button
                      onClick={() => setSelectedIds(new Set(spaces.map((s) => s.id)))}
                      className="text-[11px] text-gray-900 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
                    >
                      Select all
                    </button>
                  </div>

                  {/* Space list with checkboxes */}
                  <div className="py-1">
                    {spaces.map((space) => {
                      const checked = selectedIds.has(space.id)
                      return (
                        <button
                          key={space.id}
                          onClick={() => toggleSpace(space.id)}
                          className="w-full flex items-center gap-3 px-3.5 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-900 transition-colors text-left"
                        >
                          {/* Checkbox */}
                          <div className={`w-4 h-4 rounded-md flex items-center justify-center border-2 transition-all shrink-0 ${
                            checked
                              ? 'bg-gray-900 dark:bg-gray-300 border-gray-900 dark:border-gray-300'
                              : 'border-gray-300 dark:border-gray-600'
                          }`}>
                            {checked && (
                              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke={undefined} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" className="text-white dark:text-gray-900" style={{ stroke: 'currentColor' }}>
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            )}
                          </div>
                          <span className={`text-sm truncate ${
                            checked ? 'text-gray-900 dark:text-white font-medium' : 'text-gray-900 dark:text-gray-400'
                          }`}>
                            {space.name}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </motion.header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-4 py-6 max-w-2xl mx-auto">
          {!historyLoaded ? (
            <div className="flex justify-center py-20">
              <span className="flex gap-1">
                {[0, 1, 2].map((i) => (
                  <motion.span key={i} className="w-1.5 h-1.5 bg-gray-300 dark:bg-gray-600 rounded-full"
                    animate={{ y: [0, -5, 0] }} transition={{ repeat: Infinity, duration: 0.8, delay: i * 0.15 }} />
                ))}
              </span>
            </div>
          ) : isEmpty ? (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center pt-6">
              <div className="w-12 h-12 rounded-2xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center mb-5">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-gray-900 dark:text-gray-400">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
              </div>
              <p className="text-gray-900 dark:text-white font-semibold text-sm mb-1">Ask across your projects</p>
              <p className="text-gray-900 dark:text-gray-400 text-xs mb-8 text-center max-w-xs">
                Memory searches documents from all selected projects and answers with context from each.
              </p>
              <div className="w-full max-w-sm space-y-2">
                {SUGGESTIONS.map((s) => (
                  <motion.button
                    key={s}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => sendMessage(s)}
                    disabled={loading}
                    className="w-full text-left px-4 py-3 text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-900 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-white border border-gray-100 dark:border-gray-800 rounded-2xl transition-all disabled:opacity-50"
                  >
                    {s}
                  </motion.button>
                ))}
              </div>
            </motion.div>
          ) : (
            <div className="space-y-3">
              <AnimatePresence initial={false}>
                {messages.map((msg) => (
                  <motion.div key={msg.id} variants={msgVariants} initial="hidden" animate="show" layout>
                    <GlobalChatMessage message={msg} isStreaming={streamingId === msg.id} onTypingDone={handleTypingDone} onSuggestionClick={(s) => { setInput(s); setTimeout(() => sendMessage(s), 0) }} />
                  </motion.div>
                ))}
              </AnimatePresence>
              <div ref={bottomRef} />
            </div>
          )}
        </div>
      </div>

      {/* Input */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="border-t border-gray-100 dark:border-gray-800 shrink-0 bg-white/80 dark:bg-[#0f0f0f]/80 backdrop-blur-sm"
      >
        <div className="w-full max-w-2xl mx-auto px-4 pt-3" style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}>
          {/* mention chips */}
          {mentionChips.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {mentionChips.map((chip, i) => (
                <span key={i} className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 rounded-full border border-blue-200 dark:border-blue-800">
                  <span>@{chip.spaceName}{chip.docName ? `/${chip.docName}` : ''}</span>
                  <button onClick={() => setMentionChips((p) => p.filter((_, j) => j !== i))} className="ml-0.5 opacity-60 hover:opacity-100 transition-opacity">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M18 6L6 18M6 6l12 12"/></svg>
                  </button>
                </span>
              ))}
            </div>
          )}

          {speech.listening && (
            <div className="flex items-center gap-2 mb-2 px-3 py-1.5 rounded-xl bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-xs w-fit">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
              </span>
              Recording…
              <button onClick={speech.stop} className="ml-1 underline">Done</button>
              <button onClick={speech.cancel} className="underline">Cancel</button>
            </div>
          )}
          {speech.transcribing && (
            <div className="flex items-center gap-2 mb-2 px-3 py-1.5 rounded-xl bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 text-xs w-fit">
              Transcribing…
            </div>
          )}


          <div className="relative">
            {/* @ mention dropdown */}
            <AnimatePresence>
              {mentionQuery !== null && (
                <motion.div
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 4 }}
                  transition={{ duration: 0.12 }}
                  className="absolute bottom-full left-0 mb-2 w-full max-w-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-lg overflow-hidden z-50"
                >
                  {/* stage label */}
                  <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-800 flex items-center gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-600">
                      {mentionStage === 'space' ? 'Select project' : `${mentionSpaceCtx?.name} › Select document`}
                    </span>
                    {mentionStage === 'doc' && (
                      <button
                        type="button"
                        onMouseDown={(e) => { e.preventDefault(); setMentionStage('space'); setMentionSpaceCtx(null); setMentionQuery(''); setMentionActiveIdx(0) }}
                        className="ml-auto text-[11px] text-blue-500 hover:text-blue-600"
                      >← back</button>
                    )}
                  </div>
                  {(() => {
                    if (mentionStage === 'space') {
                      const filtered = spaces.filter((s) =>
                        s.name.toLowerCase().includes(mentionQuery.toLowerCase())
                      ).slice(0, 6)
                      if (filtered.length === 0) return <div className="px-4 py-3 text-xs text-gray-400 dark:text-gray-600">No projects found</div>
                      return filtered.map((space, idx) => (
                        <button
                          key={space.id}
                          type="button"
                          onMouseEnter={() => setMentionActiveIdx(idx)}
                          onMouseDown={(e) => {
                            e.preventDefault()
                            // transition to doc stage
                            const atIdx = input.lastIndexOf('@')
                            setInput(input.slice(0, atIdx))
                            setMentionStage('doc')
                            setMentionSpaceCtx({ id: space.id, name: space.name })
                            setMentionQuery('')
                            setMentionActiveIdx(0)
                            loadSpaceDocs(space.id)
                          }}
                          className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${idx === mentionActiveIdx ? 'bg-gray-100 dark:bg-gray-800' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'}`}
                        >
                          <span className="text-sm text-gray-900 dark:text-white truncate font-medium">{space.name}</span>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="ml-auto shrink-0 text-gray-400"><path d="M9 18l6-6-6-6"/></svg>
                        </button>
                      ))
                    } else {
                      const docs = mentionSpaceCtx ? (spaceDocs[mentionSpaceCtx.id] ?? []) : []
                      const filtered = docs.filter((d) => d.name.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 6)
                      const FILE_ICONS: Record<string, string> = { pdf: '📄', docx: '📝', doc: '📝', xlsx: '📊', xls: '📊', csv: '📊', text: '✏️' }
                      const items = [{ id: '__space__', name: `All docs in ${mentionSpaceCtx?.name}`, fileType: '' }, ...filtered]
                      if (items.length === 1 && docs.length === 0) return <div className="px-4 py-3 text-xs text-gray-400 dark:text-gray-600">Loading…</div>
                      return items.map((item, idx) => (
                        <button
                          key={item.id}
                          type="button"
                          onMouseEnter={() => setMentionActiveIdx(idx)}
                          onMouseDown={(e) => {
                            e.preventDefault()
                            if (!mentionSpaceCtx) return
                            if (item.id === '__space__') {
                              setMentionChips((p) => [...p, { spaceId: mentionSpaceCtx.id, spaceName: mentionSpaceCtx.name }])
                            } else {
                              setMentionChips((p) => [...p, { spaceId: mentionSpaceCtx.id, spaceName: mentionSpaceCtx.name, docId: item.id, docName: item.name }])
                            }
                            setMentionQuery(null)
                            setMentionStage('space')
                            setMentionSpaceCtx(null)
                            setMentionActiveIdx(0)
                            setTimeout(() => inputRef.current?.focus(), 0)
                          }}
                          className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${idx === mentionActiveIdx ? 'bg-gray-100 dark:bg-gray-800' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'}`}
                        >
                          <span className="text-base shrink-0">{item.id === '__space__' ? '🗂️' : (FILE_ICONS[item.fileType] ?? '📄')}</span>
                          <span className={`text-sm truncate ${item.id === '__space__' ? 'text-gray-500 dark:text-gray-400 italic' : 'text-gray-900 dark:text-white'}`}>{item.name}</span>
                        </button>
                      ))
                    }
                  })()}
                </motion.div>
              )}
            </AnimatePresence>

            <form
              onSubmit={(e) => { e.preventDefault(); sendMessage(input) }}
              className="flex items-center gap-2 w-full bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-2xl px-3 py-2 focus-within:border-gray-400 dark:focus-within:border-gray-600 focus-within:bg-white dark:focus-within:bg-gray-800 transition-all"
            >
              <button
                type="button"
                onClick={() => { setInput((v) => v + '@'); inputRef.current?.focus(); setMentionStage('space'); setMentionQuery(''); setMentionActiveIdx(0) }}
                disabled={loading}
                title="Reference a project or document"
                className="shrink-0 h-7 w-7 flex items-center justify-center text-gray-500 dark:text-gray-500 hover:text-blue-500 dark:hover:text-blue-400 rounded-lg transition-colors disabled:opacity-30 text-sm font-semibold"
              >@</button>
              <button
                type="button"
                onClick={speech.toggle}
                disabled={loading || !speech.supported || speech.transcribing}
                title={!speech.supported ? "Voice input isn't supported in this browser" : speech.listening ? 'Stop recording' : 'Speak your question'}
                className={`shrink-0 h-7 w-7 flex items-center justify-center rounded-lg transition-colors disabled:opacity-30 ${
                  speech.listening ? 'text-red-500' : 'text-gray-500 dark:text-gray-500 hover:text-blue-500 dark:hover:text-blue-400'
                }`}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                  <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4" />
                </svg>
              </button>
              <textarea
                ref={inputRef}
                value={input}
                rows={1}
                onChange={(e) => {
                  const val = e.target.value
                  setInput(val)
                  e.target.style.height = 'auto'
                  e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
                  const atIdx = val.lastIndexOf('@')
                  if (atIdx !== -1 && (atIdx === 0 || val[atIdx - 1] === ' ' || val[atIdx - 1] === '\n')) {
                    const afterAt = val.slice(atIdx + 1)
                    const slashIdx = afterAt.indexOf('/')
                    if (slashIdx === -1) {
                      setMentionStage('space')
                      setMentionSpaceCtx(null)
                      setMentionQuery(afterAt)
                      setMentionActiveIdx(0)
                    } else {
                      const spaceName = afterAt.slice(0, slashIdx)
                      const match = spaces.find((s) => s.name.toLowerCase() === spaceName.toLowerCase())
                      if (match) {
                        setMentionStage('doc')
                        setMentionSpaceCtx({ id: match.id, name: match.name })
                        setMentionQuery(afterAt.slice(slashIdx + 1))
                        setMentionActiveIdx(0)
                        loadSpaceDocs(match.id)
                      } else {
                        setMentionStage('space')
                        setMentionQuery(afterAt)
                        setMentionActiveIdx(0)
                      }
                    }
                  } else {
                    setMentionQuery(null)
                  }
                }}
                onKeyDown={(e) => {
                  if (mentionQuery !== null) {
                    const list = mentionStage === 'space'
                      ? spaces.filter((s) => s.name.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 6)
                      : [{ id: '__space__', name: '' }, ...(mentionSpaceCtx ? (spaceDocs[mentionSpaceCtx.id] ?? []) : []).filter((d) => d.name.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 6)]
                    if (e.key === 'ArrowDown') { e.preventDefault(); setMentionActiveIdx((i) => Math.min(i + 1, list.length - 1)); return }
                    if (e.key === 'ArrowUp') { e.preventDefault(); setMentionActiveIdx((i) => Math.max(i - 1, 0)); return }
                    if (e.key === 'Enter' && list.length > 0) {
                      e.preventDefault()
                      const item = list[mentionActiveIdx] ?? list[0]
                      if (mentionStage === 'space') {
                        const atIdx = input.lastIndexOf('@')
                        setInput(input.slice(0, atIdx))
                        setMentionStage('doc')
                        setMentionSpaceCtx({ id: item.id, name: item.name })
                        setMentionQuery('')
                        setMentionActiveIdx(0)
                        loadSpaceDocs(item.id)
                      } else if (mentionSpaceCtx) {
                        if (item.id === '__space__') {
                          setMentionChips((p) => [...p, { spaceId: mentionSpaceCtx.id, spaceName: mentionSpaceCtx.name }])
                        } else {
                          setMentionChips((p) => [...p, { spaceId: mentionSpaceCtx.id, spaceName: mentionSpaceCtx.name, docId: item.id, docName: item.name }])
                        }
                        setMentionQuery(null); setMentionStage('space'); setMentionSpaceCtx(null); setMentionActiveIdx(0)
                      }
                      return
                    }
                    if (e.key === 'Escape') { setMentionQuery(null); return }
                  }
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input) }
                }}
                placeholder={`Ask anything across ${selectionLabel.toLowerCase()}… or @ a project`}
                disabled={loading}
                className="flex-1 min-w-0 text-base sm:text-[17px] lg:text-lg text-gray-900 dark:text-white bg-transparent outline-none resize-none placeholder:text-gray-400 dark:placeholder:text-gray-600 disabled:opacity-50 min-h-[28px] max-h-[120px] overflow-y-auto leading-relaxed"
              />
              <div className="shrink-0 flex items-center gap-1.5">
                <StyleToggle value={responseStyle} onChange={setResponseStyle} />
                <motion.button
                  whileTap={{ scale: 0.92 }}
                  type="submit"
                  disabled={loading || !input.trim()}
                  className="h-8 w-8 sm:h-auto sm:w-auto sm:px-4 sm:py-1.5 flex items-center justify-center gap-1.5 bg-gray-900 dark:bg-gray-700 text-white rounded-xl hover:bg-gray-700 dark:hover:bg-gray-600 disabled:opacity-30 transition-colors"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                  </svg>
                  <span className="hidden sm:inline text-xs font-medium">Send</span>
                </motion.button>
              </div>
            </form>
          </div>
        </div>
      </motion.div>
    </div>
  )
}

function StyleToggle({ value, onChange }: { value: 'short' | 'detailed'; onChange: (v: 'short' | 'detailed') => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open])

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 h-8 px-2.5 text-[11px] font-medium rounded-xl bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white capitalize transition-colors hover:bg-gray-200 dark:hover:bg-gray-700"
      >
        {value}
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.12 }}
            className="absolute bottom-full right-0 mb-1.5 w-28 bg-white dark:bg-[#1c1c1c] border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg overflow-hidden z-20"
          >
            {(['short', 'detailed'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => { onChange(s); setOpen(false) }}
                className={`w-full text-left px-3 py-2 text-xs font-medium capitalize transition-colors ${
                  value === s
                    ? 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/60'
                }`}
              >
                {s}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function normalizeMarkdown(text: string): string {
  return text
    .replace(/\r/g, '')
    // Strip any model-emitted "[WEB-1], [WEB-3] — web source(s)" attribution line…
    .replace(/\[(?:INT|WEB)-\d+\](?:\s*,\s*\[(?:INT|WEB)-\d+\])*\s*[—–-]\s*(?:web|internal)?\s*sources?\.?/gi, '')
    // …and any remaining inline [INT-n] / [WEB-n] citation tags (sources are shown as chips).
    .replace(/\s*\[(?:INT|WEB)-\d+\]/gi, '')
    .split('\n')
    .map(line => line.replace(/^(\s*)•\s+/, '$1- '))
    .join('\n')
}

const failedGlobalImageUrls = new Set<string>()

const GlobalChatImage = React.memo(function GlobalChatImage({ url, alt }: { url: string; alt: string }) {
  const [loaded, setLoaded] = React.useState(false)
  const [errored, setErrored] = React.useState(() => failedGlobalImageUrls.has(url))
  if (errored) return null
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="block flex-shrink-0">
      {!loaded && (
        <div className="rounded-xl bg-gray-100 dark:bg-gray-800 animate-pulse" style={{ width: 200, height: 150 }} />
      )}
      <img
        src={url}
        alt={alt}
        onLoad={() => setLoaded(true)}
        onError={() => { failedGlobalImageUrls.add(url); setErrored(true) }}
        className={`rounded-xl border border-gray-200 dark:border-gray-700 cursor-zoom-in hover:opacity-90 transition-opacity object-cover ${loaded ? 'block' : 'hidden'}`}
        style={{ width: 200, height: 150 }}
        loading="lazy"
      />
    </a>
  )
})

function GlobalChatMessage({ message, isStreaming, onTypingDone, onSuggestionClick }: {
  message: Message
  isStreaming?: boolean
  onTypingDone?: (id: string) => void
  onSuggestionClick?: (suggestion: string) => void
}) {
  const isUser = message.role === 'user'
  const showDots = isStreaming && message.content === ''
  const [displayed, setDisplayed] = useState(message.isTyping ? '' : message.content)
  const [vote, setVote] = useState<'up' | 'down' | null>(null)
  const [thinkingOpen, setThinkingOpen] = useState(false)

  const handleVote = async (v: 'up' | 'down') => {
    const next = vote === v ? null : v
    setVote(next)
    await fetch('/api/messages/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: message.id, vote: v }),
    }).catch(() => {})
  }

  useEffect(() => {
    if (!message.isTyping) {
      setDisplayed(message.content)
      return
    }
    const full = message.content
    if (!full) return
    const speed = Math.max(2, Math.min(20, 2000 / full.length))
    let i = 0
    setDisplayed('')
    const iv = setInterval(() => {
      i++
      setDisplayed(full.slice(0, i))
      if (i >= full.length) {
        clearInterval(iv)
        onTypingDone?.(message.id)
      }
    }, speed)
    return () => clearInterval(iv)
  }, [message.id, message.isTyping]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] px-4 py-3 rounded-2xl text-sm leading-relaxed ${
        isUser
          ? 'bg-gray-900 dark:bg-gray-700 text-white rounded-br-sm'
          : 'bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-100 border border-gray-100 dark:border-gray-800 rounded-bl-sm'
      }`}>
        {showDots ? (
          <span className="flex gap-1 items-center py-0.5">
            {[0, 1, 2].map((i) => (
              <motion.span key={i} className="w-1.5 h-1.5 bg-gray-400 dark:bg-gray-500 rounded-full inline-block"
                animate={{ y: [0, -4, 0] }} transition={{ repeat: Infinity, duration: 0.8, delay: i * 0.15 }} />
            ))}
          </span>
        ) : isUser ? (
          message.content.split('\n').map((line, i, arr) => (
            <span key={i}>{line}{i < arr.length - 1 && <br />}</span>
          ))
        ) : (
          <div>
            {/* Thinking process — collapsible, hidden by default */}
            {message.thinkingSteps && message.thinkingSteps.length > 0 && (
              <div className="mb-2">
                <button
                  onClick={() => setThinkingOpen((o) => !o)}
                  className="flex items-center gap-1.5 text-[11px] text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors select-none"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform duration-150 ${thinkingOpen ? 'rotate-90' : ''}`}>
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                  <span className="font-medium">Thinking process</span>
                  <span className="text-gray-300 dark:text-gray-600">({message.thinkingSteps.length} step{message.thinkingSteps.length !== 1 ? 's' : ''})</span>
                </button>
                {thinkingOpen && (
                  <div className="mt-1.5 pl-3 border-l-2 border-gray-100 dark:border-gray-800 space-y-1">
                    {message.thinkingSteps.map((step, i) => {
                      const action = (message.thinkingStepActions ?? [])[i] ?? ''
                      const result = (message.thinkingStepResults ?? [])[i] ?? ''
                      const isResult = action === 'result' || step.startsWith('Result: ')
                      const displayStep = isResult ? step.replace(/^Result:\s*/, '') : step

                      let iconColor = 'text-gray-300 dark:text-gray-600'
                      let bgColor = ''
                      let badge = null
                      if (['classifyIntent', 'loadSkills', 'understandQuery', 'resolveSynonyms'].includes(action)) {
                        iconColor = 'text-blue-400 dark:text-blue-500'
                      } else if (['soqlQuery', 'find', 'executeTool', 'toolResult', 'mcpStart'].includes(action)) {
                        iconColor = 'text-gray-400 dark:text-gray-500'
                      } else if (action === 'verifyAnswer' || action === 'quickCheck') {
                        iconColor = 'text-emerald-400 dark:text-emerald-500'
                        const scoreMatch = displayStep.match(/(\d+)\/100/)
                        if (scoreMatch) {
                          const score = parseInt(scoreMatch[1])
                          const scoreColor = score >= 70 ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' : score >= 40 ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' : 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'
                          badge = <span className={`ml-1 px-1 py-0.5 rounded text-[9px] font-medium ${scoreColor}`}>{score}</span>
                        }
                      } else if (['crossCheck', 'detectHallucination'].includes(action)) {
                        iconColor = 'text-yellow-500 dark:text-yellow-400'
                        bgColor = 'bg-yellow-50/50 dark:bg-yellow-900/10'
                      } else if (['reactLoop', 'adhocSpec', 'catchAll', 'ragFallback'].includes(action)) {
                        iconColor = 'text-orange-400 dark:text-orange-500'
                      } else if (action === 'composeAnswer') {
                        iconColor = 'text-purple-400 dark:text-purple-500'
                      } else if (action === 'fallthrough') {
                        iconColor = 'text-orange-400 dark:text-orange-500'
                      } else if (action === 'verifierOverride' || action === 'verifierRetry') {
                        iconColor = 'text-yellow-500 dark:text-yellow-400'
                      }

                      return (
                        <div key={i} className={`${isResult ? 'ml-4' : ''} ${bgColor} rounded px-1`}>
                          <div className="flex items-start gap-2 text-[11px] text-gray-400 dark:text-gray-500">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 mt-0.5 ${iconColor}`}>
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                            <span>{displayStep}{badge}</span>
                          </div>
                          {result && !isResult && (
                            <div className="ml-5 mt-0.5 text-[10px] text-gray-300 dark:text-gray-600">
                              {(() => {
                                try {
                                  const parsed = JSON.parse(result)
                                  return <pre className="bg-gray-50 dark:bg-gray-900/50 rounded p-1.5 overflow-x-auto max-h-96 overflow-y-auto font-mono whitespace-pre-wrap break-all">{JSON.stringify(parsed, null, 2)}</pre>
                                } catch {
                                  return <span className="italic">{result}</span>
                                }
                              })()}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
            <div className="markdown-body">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                table: ({ children }) => (
                  <div className="overflow-x-auto my-3"><table>{children}</table></div>
                ),
                img: ({ src, alt }) => {
                  const url = typeof src === 'string' ? src : undefined
                  return (
                    <a href={url} target="_blank" rel="noopener noreferrer">
                      <img
                        src={url}
                        alt={alt ?? ''}
                        className="max-w-full rounded-xl border border-gray-200 dark:border-gray-700 my-3 cursor-zoom-in hover:opacity-90 transition-opacity"
                        loading="lazy"
                      />
                    </a>
                  )
                },
              }}
            >{normalizeMarkdown(displayed)}</ReactMarkdown>
            {message.isTyping && (
              <motion.span
                animate={{ opacity: [1, 0, 1] }}
                transition={{ repeat: Infinity, duration: 0.9, ease: 'linear' }}
                className="inline-block w-0.5 h-[0.85em] bg-gray-400 dark:bg-gray-400 ml-0.5 align-text-bottom rounded-full"
              />
            )}
            {!message.isTyping && message.documentImages && message.documentImages.length > 0 && (
              <div className="mt-3">
                <p className="text-[10px] text-gray-400 dark:text-gray-500 mb-1.5 uppercase tracking-wide">
                  Images from document ({message.documentImages.length})
                </p>
                <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'thin' }}>
                  {message.documentImages.slice(0, 8).map((img) => (
                    <GlobalChatImage key={img.url} url={img.url} alt={img.alt || img.documentName} />
                  ))}
                </div>
              </div>
            )}
            {!message.isTyping && message.citations && message.citations.length > 0 && (() => {
              const webCites = message.citations.filter((c) => c.sourceType === 'web' && c.url)
              const internalCites = message.citations.filter((c) => c.sourceType !== 'web')
              const chip = "text-[10px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 truncate max-w-[180px]"
              const chipLink = `${chip} hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-200 cursor-pointer transition-colors`
              return (
                <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-800 space-y-1">
                  {internalCites.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      <span className="text-[10px] text-gray-400 dark:text-gray-500 mr-0.5 self-center">Sources:</span>
                      {internalCites.map((c, i) => {
                        const label = c.spaceName ? `${c.spaceName} › ${c.documentName}` : c.documentName
                        return c.documentId ? (
                          <a key={i} href={`/api/documents/${c.documentId}/file`} target="_blank" rel="noopener noreferrer" title={label} className={chipLink}>{label}</a>
                        ) : (
                          <span key={i} title={label} className={chip}>{label}</span>
                        )
                      })}
                    </div>
                  )}
                  {webCites.length > 0 && (
                    <>
                      <p className="text-[10px] italic text-gray-400 dark:text-gray-500">🌐 Includes information from the web — please verify against the sources below.</p>
                      <div className="flex flex-wrap gap-1">
                        <span className="text-[10px] text-gray-400 dark:text-gray-500 mr-0.5 self-center">🌐 Web:</span>
                        {webCites.map((c, i) => {
                          let host = c.documentName
                          try { host = new URL(c.url!).hostname.replace(/^www\./, '') } catch {}
                          return (
                            <a key={i} href={c.url} target="_blank" rel="noopener noreferrer" title={c.documentName} className={chipLink}>{host}</a>
                          )
                        })}
                      </div>
                    </>
                  )}
                </div>
              )
            })()}
            {!message.isTyping && !isStreaming && (
              <div className="mt-1.5 flex gap-0.5">
                <button onClick={() => handleVote('up')} title="Helpful"
                  className={`p-1 rounded transition-colors ${vote === 'up' ? 'text-gray-700 dark:text-gray-200' : 'text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400'}`}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/>
                    <path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>
                  </svg>
                </button>
                <button onClick={() => handleVote('down')} title="Not helpful"
                  className={`p-1 rounded transition-colors ${vote === 'down' ? 'text-gray-700 dark:text-gray-200' : 'text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400'}`}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/>
                    <path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/>
                  </svg>
                </button>
              </div>
            )}
            {message.suggestions && message.suggestions.length > 0 && !message.isTyping && !isStreaming && !isUser && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {message.suggestions.map((s, i) => (
                  <button
                    key={i}
                    onClick={() => onSuggestionClick?.(s)}
                    className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-800 dark:hover:text-gray-200 transition-colors cursor-pointer"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
