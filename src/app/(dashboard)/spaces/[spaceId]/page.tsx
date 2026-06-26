'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type MessageRole = 'user' | 'assistant'
interface Message { id: string; role: MessageRole; content: string; createdAt: string }
interface Doc { id: string; name: string; fileType: string; status: string; summary: string | null; createdAt: string; fileSize: number }
interface DocDetail extends Doc {
  keyNumbers: string[] | null
  risks: string[] | null
  decisions: string[] | null
  importantDates: string[] | null
}
interface TimelineEvent { id: string; title: string; subtitle: string; decisions: string[]; date: string; status: string; fileType: string }
interface Space { id: string; name: string; description: string | null; lastVisit: string | null }
type View = 'chat' | 'documents' | 'timeline'

const FILE_ICONS: Record<string, string> = { pdf: '📄', docx: '📝', xlsx: '📊', csv: '📋', text: '✏️' }
const STATUS_COLOR: Record<string, string> = {
  ready: 'text-emerald-500',
  processing: 'text-amber-500',
  pending: 'text-gray-400 dark:text-gray-500',
  failed: 'text-red-400',
}

function fmt(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

const PROCESSING_STAGES = ['Extracting text', 'Analyzing content', 'Generating summary', 'Building search index']

const msgVariants = {
  hidden: { opacity: 0, y: 10, scale: 0.98 },
  show: { opacity: 1, y: 0, scale: 1, transition: { type: 'spring' as const, stiffness: 500, damping: 30 } },
}

const cardVariants = {
  hidden: { opacity: 0, y: 16 },
  show: (i: number) => ({ opacity: 1, y: 0, transition: { delay: i * 0.08, type: 'spring' as const, stiffness: 400, damping: 28 } }),
}

export default function SpacePage() {
  const { spaceId } = useParams<{ spaceId: string }>()

  const [space, setSpace] = useState<Space | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null)
  const [view, setView] = useState<View>('chat')
  const [docs, setDocs] = useState<Doc[]>([])
  const [timeline, setTimeline] = useState<TimelineEvent[]>([])
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [docInputMode, setDocInputMode] = useState<'upload' | 'text'>('upload')
  const [pasteTitle, setPasteTitle] = useState('')
  const [pasteContent, setPasteContent] = useState('')
  const [pasting, setPasting] = useState(false)
  const [confirmDeleteDocId, setConfirmDeleteDocId] = useState<string | null>(null)
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null)
  const [selectedDoc, setSelectedDoc] = useState<DocDetail | null>(null)
  const [loadingDocDetail, setLoadingDocDetail] = useState(false)

  const bottomRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch(`/api/spaces/${spaceId}`).then((r) => r.ok ? r.json() : null).then((d) => d && setSpace(d))
    fetch(`/api/chat?spaceId=${spaceId}`).then((r) => r.json()).then((d) => setMessages(Array.isArray(d) ? d : []))
  }, [spaceId])

  useEffect(() => {
    if (view !== 'chat') return
    bottomRef.current?.scrollIntoView(
      streamingMessageId ? true : { behavior: 'smooth' }
    )
  }, [messages, view, streamingMessageId])

  // Poll for doc status updates while any doc is processing
  useEffect(() => {
    if (view !== 'documents') return
    const hasProcessing = docs.some((d) => d.status === 'processing' || d.status === 'pending')
    if (!hasProcessing) return

    const interval = setInterval(async () => {
      const res = await fetch(`/api/documents?spaceId=${spaceId}`)
      if (res.ok) {
        const data = await res.json()
        if (Array.isArray(data)) setDocs(data)
      }
    }, 5000)

    return () => clearInterval(interval)
  }, [view, docs, spaceId])

  // Shared SSE streaming handler — used by chat, Brief Me, and Catch Me Up
  async function handleStream(endpoint: string, body: object, tempUserId: string, sid: string) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
            } else if (event.type === 'delta') {
              accumulated += event.content
              const snap = accumulated
              setMessages((p) => p.map((m) => (m.id === sid ? { ...m, content: snap } : m)))
            } else if (event.type === 'done') {
              if (event.assistantMessageId) {
                setMessages((p) => p.map((m) => (m.id === sid ? { ...m, id: event.assistantMessageId } : m)))
              }
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
    }
  }

  async function sendMessage(content: string) {
    if (!content.trim() || loading) return
    setInput('')
    setLoading(true)

    const tempUserId = `u-${Date.now()}`
    const sid = `s-${Date.now()}`

    setMessages((p) => [
      ...p,
      { id: tempUserId, role: 'user', content, createdAt: new Date().toISOString() },
      { id: sid, role: 'assistant', content: '', createdAt: new Date().toISOString() },
    ])
    setStreamingMessageId(sid)

    await handleStream('/api/chat', { spaceId, content, spaceName: space?.name }, tempUserId, sid)

    setStreamingMessageId(null)
    setLoading(false)
    setTimeout(() => inputRef.current?.focus(), 100)
  }

  async function aiAction(label: string, endpoint: string) {
    setView('chat')
    setLoading(true)

    const tempUserId = `u-${Date.now()}`
    const sid = `s-${Date.now()}`

    setMessages((p) => [
      ...p,
      { id: tempUserId, role: 'user', content: label, createdAt: new Date().toISOString() },
      { id: sid, role: 'assistant', content: '', createdAt: new Date().toISOString() },
    ])
    setStreamingMessageId(sid)

    await handleStream(endpoint, { spaceId }, tempUserId, sid)

    setStreamingMessageId(null)
    setLoading(false)
  }

  const fetchDocs = useCallback(async () => {
    const res = await fetch(`/api/documents?spaceId=${spaceId}`)
    if (!res.ok) return
    const data = await res.json()
    if (Array.isArray(data)) setDocs(data)
  }, [spaceId])

  const uploadFile = useCallback(async (file: File) => {
    setUploading(true)
    const fd = new FormData()
    fd.append('file', file)
    fd.append('spaceId', spaceId)
    await fetch('/api/documents', { method: 'POST', body: fd })
    await fetchDocs()
    setUploading(false)
  }, [spaceId, fetchDocs])

  async function pasteText() {
    if (!pasteTitle.trim() || !pasteContent.trim()) return
    setPasting(true)
    await fetch('/api/documents/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: pasteTitle.trim(), content: pasteContent.trim(), spaceId }),
    })
    setPasteTitle('')
    setPasteContent('')
    setDocInputMode('upload')
    await fetchDocs()
    setPasting(false)
  }

  async function deleteDocument(docId: string) {
    setDeletingDocId(docId)
    await fetch(`/api/documents/${docId}`, { method: 'DELETE' })
    setDocs((prev) => prev.filter((d) => d.id !== docId))
    setDeletingDocId(null)
    setConfirmDeleteDocId(null)
  }

  async function openDocInsights(docId: string) {
    setLoadingDocDetail(true)
    setSelectedDoc(null)
    const res = await fetch(`/api/documents/${docId}`)
    if (res.ok) {
      const data = await res.json()
      setSelectedDoc(data)
    }
    setLoadingDocDetail(false)
  }

  async function openTimeline() {
    setView('timeline')
    const res = await fetch(`/api/timeline?spaceId=${spaceId}`)
    setTimeline(await res.json())
  }

  async function openDocuments() {
    setView('documents')
    await fetchDocs()
  }

  const isEmpty = messages.length === 0

  return (
    <div className="flex flex-col h-full bg-white dark:bg-[#0f0f0f]">

      {/* ── Header ── */}
      <motion.header
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="flex items-center gap-2 px-4 py-3 border-b border-gray-100 dark:border-gray-800 shrink-0 bg-white/80 dark:bg-[#0f0f0f]/80 backdrop-blur-sm"
      >
        <div className="flex-1 min-w-0 pl-12 md:pl-0">
          <h1 className="font-semibold text-gray-900 dark:text-white text-sm truncate leading-tight">
            {space?.name ?? '…'}
          </h1>
          {space?.description && (
            <p className="text-xs text-gray-400 dark:text-gray-500 truncate">{space.description}</p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <NavBtn label="Chat" active={view === 'chat'} onClick={() => setView('chat')} />
          <NavBtn label="Timeline" active={view === 'timeline'} onClick={openTimeline} />
          <NavBtn label="Docs" active={view === 'documents'} onClick={openDocuments} />
        </div>
      </motion.header>

      {/* ── Content ── */}
      <div className="flex-1 overflow-y-auto">
        <AnimatePresence mode="wait">

          {/* CHAT */}
          {view === 'chat' && (
            <motion.div key="chat" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} className="px-4 py-6 max-w-2xl mx-auto">
              {isEmpty ? (
                <EmptyState
                  spaceName={space?.name}
                  onBriefMe={() => aiAction('Brief me on this project.', '/api/brief')}
                  onCatchMeUp={() => aiAction('What changed since my last visit?', '/api/catch-up')}
                  onTimeline={openTimeline}
                  onDocuments={openDocuments}
                />
              ) : (
                <div className="space-y-3">
                  <AnimatePresence initial={false}>
                    {messages.map((msg) => (
                      <motion.div key={msg.id} variants={msgVariants} initial="hidden" animate="show" layout>
                        <ChatMessage message={msg} isStreaming={streamingMessageId === msg.id} />
                      </motion.div>
                    ))}
                  </AnimatePresence>
                  <div ref={bottomRef} />
                </div>
              )}
            </motion.div>
          )}

          {/* DOCUMENTS */}
          {view === 'documents' && (
            <motion.div key="documents" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.2 }} className="px-4 py-6 max-w-2xl mx-auto">
              <div className="flex items-center justify-between mb-5">
                <h2 className="font-semibold text-gray-900 dark:text-white">Documents</h2>
                <motion.button whileTap={{ scale: 0.95 }} onClick={() => fileInputRef.current?.click()}
                  className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors">
                  + Upload
                </motion.button>
              </div>

              {/* Tab toggle */}
              <div className="flex gap-1 p-1 bg-gray-100 dark:bg-gray-800/60 rounded-xl mb-4">
                {(['upload', 'text'] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setDocInputMode(mode)}
                    className={`flex-1 py-2 text-xs font-medium rounded-lg transition-colors ${
                      docInputMode === mode
                        ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                        : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                    }`}
                  >
                    {mode === 'upload' ? 'Upload file' : 'Paste text'}
                  </button>
                ))}
              </div>

              <AnimatePresence mode="wait">
                {docInputMode === 'upload' ? (
                  <motion.div key="upload-area" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
                    <motion.div
                      onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) uploadFile(f) }}
                      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                      onDragLeave={() => setDragOver(false)}
                      onClick={() => fileInputRef.current?.click()}
                      className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all mb-5 ${
                        dragOver
                          ? 'border-gray-400 dark:border-gray-500 bg-gray-50 dark:bg-gray-800/50 scale-[1.01]'
                          : 'border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700 hover:bg-gray-50/50 dark:hover:bg-gray-900/50'
                      }`}
                    >
                      <AnimatePresence mode="wait">
                        {uploading ? (
                          <motion.div key="uploading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                            <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1.5, ease: 'linear' }} className="text-2xl inline-block mb-2">⏳</motion.div>
                            <p className="text-sm text-gray-500 dark:text-gray-400 font-medium">Uploading…</p>
                            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">AI will process your document</p>
                          </motion.div>
                        ) : (
                          <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                            <div className="text-3xl mb-3">📎</div>
                            <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Drop a file or click to upload</p>
                            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">PDF · Word · Excel · CSV · up to 50MB</p>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </motion.div>
                    <input ref={fileInputRef} type="file" accept=".pdf,.docx,.doc,.xlsx,.xls,.csv" className="hidden"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.target.value = '' }} />
                  </motion.div>
                ) : (
                  <motion.div key="paste-area" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} className="mb-5 space-y-3">
                    <input
                      type="text"
                      value={pasteTitle}
                      onChange={(e) => setPasteTitle(e.target.value)}
                      placeholder="Title — e.g. Meeting minutes, 25 Jun"
                      className="w-full px-3.5 py-3 text-base text-gray-900 dark:text-white bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl outline-none focus:border-gray-300 dark:focus:border-gray-600 transition-colors placeholder:text-gray-400 dark:placeholder:text-gray-600"
                    />
                    <textarea
                      value={pasteContent}
                      onChange={(e) => setPasteContent(e.target.value)}
                      placeholder="Paste meeting minutes, notes, decisions, ideas… Memory will extract insights automatically."
                      rows={8}
                      className="w-full px-3.5 py-3 text-base text-gray-900 dark:text-white bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl outline-none focus:border-gray-300 dark:focus:border-gray-600 transition-colors placeholder:text-gray-400 dark:placeholder:text-gray-600 resize-none"
                    />
                    <motion.button
                      whileTap={{ scale: 0.97 }}
                      onClick={pasteText}
                      disabled={pasting || !pasteTitle.trim() || !pasteContent.trim()}
                      className="w-full py-3 text-sm font-medium bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-xl hover:bg-gray-700 dark:hover:bg-gray-100 disabled:opacity-40 transition-colors"
                    >
                      {pasting ? 'Adding to Memory…' : 'Add to Memory'}
                    </motion.button>
                  </motion.div>
                )}
              </AnimatePresence>

              {docs.length === 0 ? (
                <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-sm text-gray-500 dark:text-gray-400 text-center py-10">
                  No documents yet. Upload one to get started.
                </motion.p>
              ) : (
                <motion.div initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.06 } } }} className="space-y-1">
                  {docs.map((doc, i) => {
                    const isReady = doc.status === 'ready'
                    return (
                      <motion.div key={doc.id} custom={i} variants={cardVariants}
                        className={`group flex items-start gap-3 px-3 py-3.5 rounded-2xl transition-colors ${
                          isReady ? 'hover:bg-gray-50 dark:hover:bg-gray-900 cursor-pointer' : ''
                        }`}
                        onClick={() => {
                          if (isReady && confirmDeleteDocId !== doc.id) openDocInsights(doc.id)
                        }}
                      >
                        <span className="text-2xl shrink-0 mt-0.5">{FILE_ICONS[doc.fileType] ?? '📄'}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{doc.name}</p>
                          {doc.summary && doc.status === 'ready' && (
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-2">{doc.summary}</p>
                          )}
                          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                            {doc.status === 'processing' || doc.status === 'pending' ? (
                              <ProcessingStatusBadge status={doc.status} />
                            ) : (
                              <span className={`text-xs font-medium ${STATUS_COLOR[doc.status]}`}>
                                {doc.status === 'ready' ? 'Ready' : 'Failed'}
                              </span>
                            )}
                            <span className="text-gray-300 dark:text-gray-700 text-xs">·</span>
                            <span className="text-xs text-gray-500 dark:text-gray-400">{fmt(doc.fileSize)}</span>
                            {isReady && (
                              <>
                                <span className="text-gray-300 dark:text-gray-700 text-xs">·</span>
                                <span className="text-xs text-gray-400 dark:text-gray-500">Tap for insights</span>
                              </>
                            )}
                          </div>
                        </div>
                        <div className="shrink-0 flex flex-col items-end gap-1.5 pt-0.5" onClick={(e) => e.stopPropagation()}>
                          <span className="text-xs text-gray-400 dark:text-gray-500">
                            {new Date(doc.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </span>
                          {confirmDeleteDocId === doc.id ? (
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={() => deleteDocument(doc.id)}
                                disabled={deletingDocId === doc.id}
                                className="text-xs text-red-500 font-medium hover:text-red-600 disabled:opacity-50 transition-colors"
                              >
                                {deletingDocId === doc.id ? '…' : 'Delete'}
                              </button>
                              <button onClick={() => setConfirmDeleteDocId(null)} className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setConfirmDeleteDocId(doc.id)}
                              className="opacity-0 group-hover:opacity-100 p-1 text-gray-300 dark:text-gray-600 hover:text-red-400 dark:hover:text-red-400 transition-all rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20"
                              title="Delete document"
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                                <path d="M10 11v6M14 11v6" />
                                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                              </svg>
                            </button>
                          )}
                        </div>
                      </motion.div>
                    )
                  })}
                </motion.div>
              )}
            </motion.div>
          )}

          {/* TIMELINE */}
          {view === 'timeline' && (
            <motion.div key="timeline" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.2 }} className="px-4 py-6 max-w-2xl mx-auto">
              <h2 className="font-semibold text-gray-900 dark:text-white mb-6">Timeline</h2>
              {timeline.length === 0 ? (
                <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-sm text-gray-500 dark:text-gray-400 text-center py-10">
                  No events yet. Upload documents to start your timeline.
                </motion.p>
              ) : (
                <div className="relative pl-5">
                  <div className="absolute left-[7px] top-2 bottom-2 w-px bg-gray-100 dark:bg-gray-800" />
                  <motion.div initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.07 } } }} className="space-y-6">
                    {timeline.map((ev, i) => (
                      <motion.div key={ev.id} custom={i} variants={cardVariants} className="relative">
                        <motion.div
                          initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: i * 0.07 + 0.1, type: 'spring' }}
                          className={`absolute -left-5 top-1 w-3 h-3 rounded-full border-2 z-10 ${
                            ev.status === 'ready' ? 'bg-emerald-400 border-emerald-400' :
                            ev.status === 'failed' ? 'bg-red-400 border-red-400' :
                            'bg-gray-200 dark:bg-gray-700 border-gray-200 dark:border-gray-700'
                          }`}
                        />
                        <div className="flex justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm">{FILE_ICONS[ev.fileType] ?? '📄'}</span>
                              <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{ev.title}</p>
                            </div>
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">{ev.subtitle}</p>
                            {ev.decisions.slice(0, 3).map((d, j) => (
                              <p key={j} className="text-xs text-gray-500 dark:text-gray-400 flex gap-1.5 mt-1">
                                <span className="text-gray-400 dark:text-gray-600 shrink-0">→</span>
                                <span>{d}</span>
                              </p>
                            ))}
                          </div>
                          <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0 pt-0.5 whitespace-nowrap">
                            {new Date(ev.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </span>
                        </div>
                      </motion.div>
                    ))}
                  </motion.div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── Chat input ── */}
      {view === 'chat' && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="border-t border-gray-100 dark:border-gray-800 shrink-0 bg-white/80 dark:bg-[#0f0f0f]/80 backdrop-blur-sm"
        >
          <div className="w-full max-w-2xl mx-auto px-4 pb-5 pt-3">
            {!isEmpty && (
              <div className="flex gap-2 mb-3 overflow-x-auto scrollbar-hide pb-0.5">
                {[
                  { label: '✦ Brief Me', action: () => aiAction('Brief me on this project.', '/api/brief') },
                  { label: '↻ Catch Me Up', action: () => aiAction('What changed since my last visit?', '/api/catch-up') },
                  { label: '◷ Timeline', action: openTimeline },
                  { label: '⊞ Documents', action: openDocuments },
                ].map(({ label, action }) => (
                  <motion.button key={label} whileTap={{ scale: 0.94 }} onClick={action}
                    disabled={loading}
                    className="shrink-0 px-3.5 py-2 text-xs font-medium text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-900 dark:hover:text-white rounded-xl transition-colors whitespace-nowrap disabled:opacity-40">
                    {label}
                  </motion.button>
                ))}
              </div>
            )}

            <form onSubmit={(e) => { e.preventDefault(); sendMessage(input) }} className="flex items-center gap-2 w-full">
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask anything…"
                disabled={loading}
                className="flex-1 min-w-0 px-4 py-3 text-base text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl outline-none focus:border-gray-300 dark:focus:border-gray-600 focus:bg-white dark:focus:bg-gray-800 transition-all placeholder:text-gray-400 dark:placeholder:text-gray-600 disabled:opacity-50"
              />
              <motion.button
                whileTap={{ scale: 0.92 }}
                type="submit" disabled={loading || !input.trim()}
                className="shrink-0 h-12 w-12 sm:h-auto sm:w-auto sm:px-5 sm:py-3 flex items-center justify-center gap-2 bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-2xl hover:bg-gray-700 dark:hover:bg-gray-100 disabled:opacity-30 transition-colors"
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                </svg>
                <span className="hidden sm:inline text-sm font-medium">Send</span>
              </motion.button>
            </form>
          </div>
        </motion.div>
      )}

      {/* ── Document Insights Modal ── */}
      <AnimatePresence>
        {(selectedDoc || loadingDocDetail) && (
          <DocInsightsModal
            doc={selectedDoc}
            loading={loadingDocDetail}
            onClose={() => { setSelectedDoc(null); setLoadingDocDetail(false) }}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Sub-components ──

function EmptyState({ spaceName, onBriefMe, onCatchMeUp, onTimeline, onDocuments }: {
  spaceName?: string; onBriefMe: () => void; onCatchMeUp: () => void; onTimeline: () => void; onDocuments: () => void
}) {
  const actions = [
    { emoji: '✦', label: 'Brief Me', sub: '2-minute executive summary', onClick: onBriefMe },
    { emoji: '↻', label: 'Catch Me Up', sub: 'Changes since your last visit', onClick: onCatchMeUp },
    { emoji: '◷', label: 'Timeline', sub: 'Full project history', onClick: onTimeline },
    { emoji: '⊞', label: 'Documents', sub: 'Upload & manage files', onClick: onDocuments },
  ]

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }} className="flex flex-col items-center min-h-[55vh] pt-8">
      <motion.p initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="text-gray-500 dark:text-gray-400 text-sm mb-1">
        What would you like to know?
      </motion.p>
      <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.15 }} className="text-gray-400 dark:text-gray-500 text-xs mb-10">
        {spaceName ? `Ask anything about ${spaceName}` : 'Ask a question or choose an action'}
      </motion.p>
      <div className="grid grid-cols-2 gap-3 w-full max-w-xs">
        {actions.map((a, i) => (
          <motion.button
            key={a.label}
            custom={i}
            variants={cardVariants}
            initial="hidden"
            animate="show"
            whileHover={{ scale: 1.03, y: -2 }}
            whileTap={{ scale: 0.97 }}
            onClick={a.onClick}
            className="text-left p-4 rounded-2xl border border-gray-100 dark:border-gray-800 hover:border-gray-200 dark:hover:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-900 transition-all group shadow-sm hover:shadow-md dark:shadow-none"
          >
            <div className="text-xl mb-2.5 text-gray-400 dark:text-gray-500 group-hover:text-gray-600 dark:group-hover:text-gray-300 transition-colors">{a.emoji}</div>
            <p className="text-sm font-semibold text-gray-900 dark:text-white">{a.label}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">{a.sub}</p>
          </motion.button>
        ))}
      </div>
    </motion.div>
  )
}

function ChatMessage({ message, isStreaming }: { message: Message; isStreaming?: boolean }) {
  const isUser = message.role === 'user'
  const showDots = isStreaming && message.content === ''
  const showStreamingText = isStreaming && message.content !== ''

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] px-4 py-3 rounded-2xl text-sm leading-relaxed ${
        isUser
          ? 'bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-br-sm'
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
        ) : showStreamingText ? (
          // Plain text while streaming — prevents markdown re-render flicker on every chunk
          <p className="whitespace-pre-wrap text-sm leading-relaxed">
            {message.content}
            <motion.span
              animate={{ opacity: [1, 0, 1] }}
              transition={{ repeat: Infinity, duration: 0.9, ease: 'linear' }}
              className="inline-block w-0.5 h-[0.85em] bg-gray-400 dark:bg-gray-400 ml-0.5 align-text-bottom rounded-full"
            />
          </p>
        ) : (
          // Full markdown after streaming completes
          <div className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  )
}

function NavBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <motion.button whileTap={{ scale: 0.94 }} onClick={onClick}
      className={`px-3.5 py-2 text-xs font-medium rounded-xl transition-all min-h-[36px] ${
        active ? 'bg-gray-900 dark:bg-white text-white dark:text-gray-900 shadow-sm'
               : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800'
      }`}>
      {label}
    </motion.button>
  )
}

function ProcessingStatusBadge({ status }: { status: string }) {
  const [stage, setStage] = useState(0)

  useEffect(() => {
    if (status !== 'processing') return
    const t = setInterval(() => setStage((p) => (p + 1) % PROCESSING_STAGES.length), 2500)
    return () => clearInterval(t)
  }, [status])

  if (status === 'pending') {
    return (
      <span className="text-xs text-gray-400 dark:text-gray-500 flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 bg-gray-300 dark:bg-gray-600 rounded-full" />
        Queued
      </span>
    )
  }

  return (
    <span className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
      <motion.span
        animate={{ opacity: [1, 0.3, 1] }}
        transition={{ repeat: Infinity, duration: 1.2 }}
        className="w-1.5 h-1.5 bg-amber-400 rounded-full shrink-0"
      />
      {PROCESSING_STAGES[stage]}…
    </span>
  )
}

function DocInsightsModal({ doc, loading, onClose }: { doc: DocDetail | null; loading: boolean; onClose: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <motion.div
        initial={{ opacity: 0, y: 32, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 32, scale: 0.97 }}
        transition={{ type: 'spring', stiffness: 380, damping: 30 }}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full sm:max-w-lg max-h-[85vh] sm:max-h-[80vh] overflow-y-auto bg-white dark:bg-[#1a1a1a] rounded-t-3xl sm:rounded-3xl shadow-2xl"
      >
        {loading || !doc ? (
          <div className="flex items-center justify-center h-48">
            <span className="flex gap-1 items-center">
              {[0, 1, 2].map((i) => (
                <motion.span key={i} className="w-2 h-2 bg-gray-300 dark:bg-gray-600 rounded-full"
                  animate={{ y: [0, -6, 0] }} transition={{ repeat: Infinity, duration: 0.8, delay: i * 0.15 }} />
              ))}
            </span>
          </div>
        ) : (
          <>
            {/* Modal header */}
            <div className="sticky top-0 z-10 flex items-start gap-3 p-5 bg-white dark:bg-[#1a1a1a] border-b border-gray-100 dark:border-gray-800 rounded-t-3xl">
              <span className="text-2xl shrink-0">{FILE_ICONS[doc.fileType] ?? '📄'}</span>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-gray-900 dark:text-white text-sm leading-snug break-words">{doc.name}</p>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                  {fmt(doc.fileSize)} · {new Date(doc.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                </p>
              </div>
              <button
                onClick={onClose}
                className="shrink-0 p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-all"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Modal body */}
            <div className="p-5 space-y-5">
              {doc.summary && (
                <InsightSection label="Summary" icon="📋" items={[doc.summary]} isSummary />
              )}
              {(doc.keyNumbers?.length ?? 0) > 0 && (
                <InsightSection label="Key Numbers" icon="🔢" items={doc.keyNumbers!} />
              )}
              {(doc.risks?.length ?? 0) > 0 && (
                <InsightSection label="Risks" icon="⚠️" items={doc.risks!} accent="amber" />
              )}
              {(doc.decisions?.length ?? 0) > 0 && (
                <InsightSection label="Decisions" icon="✅" items={doc.decisions!} />
              )}
              {(doc.importantDates?.length ?? 0) > 0 && (
                <InsightSection label="Important Dates" icon="📅" items={doc.importantDates!} />
              )}
              {!doc.summary && !doc.keyNumbers?.length && !doc.risks?.length && !doc.decisions?.length && !doc.importantDates?.length && (
                <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-4">No insights extracted from this document.</p>
              )}
            </div>
          </>
        )}
      </motion.div>
    </motion.div>
  )
}

function InsightSection({
  label, icon, items, isSummary, accent,
}: {
  label: string; icon: string; items: string[]; isSummary?: boolean; accent?: 'amber'
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2.5">
        <span className="text-sm">{icon}</span>
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">{label}</p>
      </div>
      {isSummary ? (
        <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">{items[0]}</p>
      ) : (
        <div className="space-y-2">
          {items.map((item, i) => (
            <div key={i} className={`flex gap-2.5 text-sm px-3 py-2.5 rounded-xl ${
              accent === 'amber'
                ? 'bg-amber-50 dark:bg-amber-900/10 text-amber-800 dark:text-amber-300'
                : 'bg-gray-50 dark:bg-gray-900 text-gray-700 dark:text-gray-300'
            }`}>
              <span className="shrink-0 text-gray-400 dark:text-gray-600 mt-0.5">—</span>
              <span className="leading-relaxed">{item}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
