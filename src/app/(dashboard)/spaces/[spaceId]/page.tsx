'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type MessageRole = 'user' | 'assistant'
interface Message { id: string; role: MessageRole; content: string; createdAt: string }
interface Doc { id: string; name: string; fileType: string; status: string; summary: string | null; failureReason: string | null; createdAt: string; fileSize: number }
interface DocDetail extends Doc {
  keyNumbers: string[] | null
  risks: string[] | null
  decisions: string[] | null
  importantDates: string[] | null
}
interface TimelineEvent { id: string; type: 'document' | 'decision' | 'risk' | 'number'; text: string; sourceName: string; sourceFileType: string; date: string; status: string }
type SpaceStatus = 'on_track' | 'at_risk' | 'on_hold' | 'completed'
interface Space { id: string; name: string; description: string | null; status: SpaceStatus; lastVisit: string | null }

const STATUS_CONFIG: Record<SpaceStatus, { label: string; dot: string; badge: string }> = {
  on_track:  { label: 'On Track',  dot: 'bg-emerald-400',              badge: 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400' },
  at_risk:   { label: 'At Risk',   dot: 'bg-red-400',                  badge: 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400' },
  on_hold:   { label: 'On Hold',   dot: 'bg-amber-400',                badge: 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400' },
  completed: { label: 'Completed', dot: 'bg-gray-400 dark:bg-gray-500', badge: 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-400' },
}
type View = 'chat' | 'documents' | 'timeline'

import { parseUtc } from '@/lib/utils/date'

const FILE_ICONS: Record<string, string> = { pdf: '📄', docx: '📝', xlsx: '📊', csv: '📋', text: '✏️' }

const TIMELINE_EVENT_CONFIG = {
  document: { label: 'Upload',   icon: '↑', dot: 'bg-gray-200 dark:bg-gray-700',          badge: 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-400' },
  decision:  { label: 'Decision', icon: '✓', dot: 'bg-blue-500 dark:bg-blue-400',           badge: 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' },
  risk:      { label: 'Risk',     icon: '!', dot: 'bg-red-400 dark:bg-red-400',             badge: 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400' },
  number:    { label: 'Figure',   icon: '#', dot: 'bg-emerald-400 dark:bg-emerald-400',     badge: 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400' },
}
const STATUS_COLOR: Record<string, string> = {
  ready: 'text-emerald-500',
  processing: 'text-amber-500',
  pending: 'text-gray-900 dark:text-gray-500',
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
  const router = useRouter()
  const searchParams = useSearchParams()
  const nameHint = searchParams.get('name')

  const [space, setSpace] = useState<Space | null>(null)
  const [statusOpen, setStatusOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null)
  const [responseStyle, setResponseStyle] = useState<'short' | 'detailed'>('short')
  const [view, setView] = useState<View>('chat')
  const [docs, setDocs] = useState<Doc[]>([])
  const [timeline, setTimeline] = useState<TimelineEvent[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [pendingTitle, setPendingTitle] = useState('')
  const [pendingDesc, setPendingDesc] = useState('')
  const [docInputMode, setDocInputMode] = useState<'upload' | 'text'>('upload')
  const [pasteTitle, setPasteTitle] = useState('')
  const [pasteContent, setPasteContent] = useState('')
  const [pasting, setPasting] = useState(false)
  const [docSheet, setDocSheet] = useState<Doc | null>(null)
  const [selectedDoc, setSelectedDoc] = useState<DocDetail | null>(null)
  const [loadingDocDetail, setLoadingDocDetail] = useState(false)
  const [reprocessing, setReprocessing] = useState(false)
  const [chatLoading, setChatLoading] = useState(true)
  const [docsLoading, setDocsLoading] = useState(false)
  const [timelineLoading, setTimelineLoading] = useState(false)

  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const pollingRef = useRef(false)
  const [showScrollBtn, setShowScrollBtn] = useState(false)

  useEffect(() => {
    fetch(`/api/spaces/${spaceId}`).then((r) => r.ok ? r.json() : null).then((d) => d && setSpace(d))
    fetch(`/api/chat?spaceId=${spaceId}`).then((r) => r.json()).then((d) => { setMessages(Array.isArray(d) ? d : []); setChatLoading(false) }).catch(() => setChatLoading(false))
  }, [spaceId])

  useEffect(() => {
    if (view !== 'chat') return
    bottomRef.current?.scrollIntoView(
      streamingMessageId ? true : { behavior: 'smooth' }
    )
  }, [messages, view, streamingMessageId])

  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const container = el
    function onScroll() {
      const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
      setShowScrollBtn(distFromBottom > 120)
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => container.removeEventListener('scroll', onScroll)
  }, [])

  // Poll for doc status updates while any doc is processing
  useEffect(() => {
    if (view !== 'documents') return
    const hasProcessing = docs.some((d) => d.status === 'processing' || d.status === 'pending')
    if (!hasProcessing) return

    const interval = setInterval(async () => {
      if (pollingRef.current) return
      pollingRef.current = true
      try {
        const res = await fetch(`/api/documents?spaceId=${spaceId}`)
        if (res.ok) {
          const data = await res.json()
          if (Array.isArray(data)) setDocs(data)
        }
      } finally {
        pollingRef.current = false
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

    await handleStream('/api/chat', { spaceId, content, spaceName: space?.name, responseStyle }, tempUserId, sid)

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

    await handleStream(endpoint, { spaceId, responseStyle, spaceName: space?.name }, tempUserId, sid)

    setStreamingMessageId(null)
    setLoading(false)
  }

  const fetchDocs = useCallback(async () => {
    const res = await fetch(`/api/documents?spaceId=${spaceId}`)
    if (!res.ok) return
    const data = await res.json()
    if (Array.isArray(data)) setDocs(data)
    setDocsLoading(false)
  }, [spaceId])

  const stagefile = useCallback((file: File) => {
    setPendingFile(file)
    setPendingTitle(file.name.replace(/\.[^.]+$/, ''))
    setPendingDesc('')
  }, [])

  const uploadFile = useCallback(async (file: File, customTitle: string, customDesc: string) => {
    setUploading(true)
    setUploadProgress(0)
    setUploadError(null)
    setPendingFile(null)
    const fd = new FormData()
    fd.append('file', file)
    fd.append('spaceId', spaceId)
    if (customTitle.trim()) fd.append('customName', customTitle.trim())
    if (customDesc.trim()) fd.append('description', customDesc.trim())
    try {
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', '/api/documents')
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100))
        }
        xhr.onload = () => {
          if (xhr.status === 201) { resolve() } else {
            let msg = 'Upload failed'
            try { msg = JSON.parse(xhr.responseText).error ?? msg } catch {}
            reject(new Error(msg))
          }
        }
        xhr.onerror = () => reject(new Error('Network error — check your connection and try again.'))
        xhr.send(fd)
      })
      await fetchDocs()
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed')
      setPendingFile(file)
    } finally {
      setUploading(false)
      setUploadProgress(0)
    }
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
    await fetch(`/api/documents/${docId}`, { method: 'DELETE' })
    setDocs((prev) => prev.filter((d) => d.id !== docId))
    setDocSheet(null)
  }

  async function retryDoc(docId: string) {
    const res = await fetch(`/api/documents/${docId}/retry`, { method: 'POST' })
    if (res.ok) {
      setDocs((prev) => prev.map((d) => d.id === docId ? { ...d, status: 'processing', failureReason: null } : d))
      setDocSheet(null)
    }
  }

  async function renameDoc(docId: string, name: string) {
    const res = await fetch(`/api/documents/${docId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (res.ok) {
      setDocs((prev) => prev.map((d) => d.id === docId ? { ...d, name } : d))
      setDocSheet((prev) => prev ? { ...prev, name } : null)
    }
  }

  async function reprocessAll() {
    setReprocessing(true)
    try {
      const res = await fetch(`/api/spaces/${spaceId}/reprocess`, { method: 'POST' })
      if (res.ok) {
        const { queued } = await res.json()
        if (queued > 0) {
          // Poll docs list — they'll flip to 'processing' then 'ready' as background jobs complete
          setTimeout(() => fetchDocs(), 1500)
        }
      }
    } finally {
      setReprocessing(false)
    }
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
    setTimelineLoading(true)
    const res = await fetch(`/api/timeline?spaceId=${spaceId}`)
    setTimeline(await res.json())
    setTimelineLoading(false)
  }

  async function openDocuments() {
    setView('documents')
    setDocsLoading(true)
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
        <div className="flex-1 min-w-0 pl-12 md:pl-0 flex items-center gap-2">
          <button
            onClick={() => router.push('/spaces')}
            className="shrink-0 p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-all min-w-[32px] min-h-[32px] flex items-center justify-center"
            title="Home"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
              <polyline points="9 22 9 12 15 12 15 22"/>
            </svg>
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <h1 className="font-semibold text-gray-900 dark:text-white text-sm truncate leading-tight min-w-0 shrink">
                {space?.name ?? nameHint ?? '…'}
              </h1>
              {/* Status badge — tap to change */}
              {space && (
                <div className="relative shrink-0">
                  <button
                    onClick={() => setStatusOpen((o) => !o)}
                    className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide transition-opacity hover:opacity-80 ${STATUS_CONFIG[space.status ?? 'on_track'].badge}`}
                  >
                    {STATUS_CONFIG[space.status ?? 'on_track'].label}
                  </button>
                  <AnimatePresence>
                    {statusOpen && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setStatusOpen(false)} />
                        <motion.div
                          initial={{ opacity: 0, scale: 0.95, y: -4 }}
                          animate={{ opacity: 1, scale: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.95, y: -4 }}
                          transition={{ duration: 0.12 }}
                          className="absolute left-0 top-full mt-1.5 z-20 w-36 bg-white dark:bg-[#1c1c1e] border border-gray-100 dark:border-gray-700 rounded-xl shadow-lg overflow-hidden py-1"
                        >
                          {(Object.entries(STATUS_CONFIG) as [SpaceStatus, typeof STATUS_CONFIG[SpaceStatus]][]).map(([key, cfg]) => (
                            <button
                              key={key}
                              onClick={async () => {
                                setStatusOpen(false)
                                setSpace((s) => s ? { ...s, status: key } : s)
                                await fetch(`/api/spaces/${spaceId}`, {
                                  method: 'PATCH',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ status: key }),
                                })
                              }}
                              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-900 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/5 transition-colors text-left"
                            >
                              <span className={`w-2 h-2 rounded-full shrink-0 ${cfg.dot}`} />
                              {cfg.label}
                            </button>
                          ))}
                        </motion.div>
                      </>
                    )}
                  </AnimatePresence>
                </div>
              )}
            </div>
            {space?.description && (
              <p className="text-xs text-gray-900 dark:text-gray-500 truncate">{space.description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <NavBtn label="Chat" active={view === 'chat'} onClick={() => setView('chat')} />
          <NavBtn label="Timeline" active={view === 'timeline'} onClick={openTimeline} />
          <NavBtn label="Docs" active={view === 'documents'} onClick={openDocuments} />
        </div>
      </motion.header>

      {/* ── Content ── */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto relative">
        <AnimatePresence mode="wait">

          {/* CHAT */}
          {view === 'chat' && (
            <motion.div key="chat" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} className="px-4 py-6 max-w-2xl mx-auto">
              {chatLoading ? (
                <ChatSkeleton />
              ) : isEmpty ? (
                <EmptyState
                  spaceName={space?.name}
                  onBriefMe={() => aiAction('Brief me on this space.', '/api/brief')}
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
              <div className="mb-5 flex items-center justify-between">
                <h2 className="font-semibold text-gray-900 dark:text-white">Documents</h2>
                {docs.length > 0 && (
                  <button
                    onClick={reprocessAll}
                    disabled={reprocessing}
                    className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-40 transition-colors flex items-center gap-1"
                    title="Re-chunk all documents with latest AI settings"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                    </svg>
                    {reprocessing ? 'Queuing…' : 'Reprocess all'}
                  </button>
                )}
              </div>
              {docsLoading && <ListSkeleton />}
              {docsLoading ? null : <>

              {/* Tab toggle */}
              <div className="flex gap-1 p-1 bg-gray-100 dark:bg-gray-800/60 rounded-xl mb-4">
                {(['upload', 'text'] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setDocInputMode(mode)}
                    className={`flex-1 py-2 text-xs font-medium rounded-lg transition-colors ${
                      docInputMode === mode
                        ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                        : 'text-gray-900 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                    }`}
                  >
                    {mode === 'upload' ? 'Upload file' : 'Minutes of Meeting'}
                  </button>
                ))}
              </div>

              <AnimatePresence mode="wait">
                {docInputMode === 'upload' ? (
                  <motion.div key="upload-area" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
                    <motion.div
                      onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) stagefile(f) }}
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
                            <p className="text-sm text-gray-900 dark:text-gray-400 font-medium">
                              {uploadProgress < 100 ? `Uploading… ${uploadProgress}%` : 'Processing…'}
                            </p>
                            <div className="w-32 mx-auto mt-2 h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                              <motion.div
                                className="h-full bg-gray-900 dark:bg-gray-300 rounded-full"
                                animate={{ width: `${uploadProgress < 100 ? uploadProgress : 100}%` }}
                                transition={{ duration: 0.3 }}
                              />
                            </div>
                          </motion.div>
                        ) : (
                          <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                            <div className="text-3xl mb-3">📎</div>
                            <p className="text-sm font-medium text-gray-900 dark:text-gray-300">Drop a file or click to upload</p>
                            <p className="text-xs text-gray-900 dark:text-gray-500 mt-1">PDF · Word · Excel · CSV · up to 100MB</p>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </motion.div>
                    <input ref={fileInputRef} type="file" accept=".pdf,.docx,.doc,.xlsx,.xls,.csv" className="hidden"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) stagefile(f); e.target.value = '' }} />
                    <AnimatePresence>
                      {pendingFile && (
                        <motion.div
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: 8 }}
                          className="mt-4 space-y-3 p-4 border border-gray-200 dark:border-gray-700 rounded-2xl bg-gray-50 dark:bg-gray-900"
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-lg">{FILE_ICONS[pendingFile.name.split('.').pop()?.toLowerCase() ?? ''] ?? '📄'}</span>
                            <p className="text-xs text-gray-900 dark:text-gray-400 truncate">{pendingFile.name} · {fmt(pendingFile.size)}</p>
                          </div>
                          <input
                            type="text"
                            value={pendingTitle}
                            onChange={(e) => setPendingTitle(e.target.value)}
                            placeholder="Document title"
                            className="w-full px-3.5 py-2.5 text-base text-gray-900 dark:text-white bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl outline-none focus:border-gray-300 dark:focus:border-gray-600 transition-colors placeholder:text-gray-400 dark:placeholder:text-gray-600"
                          />
                          <input
                            type="text"
                            value={pendingDesc}
                            onChange={(e) => setPendingDesc(e.target.value)}
                            placeholder="Short description (optional)"
                            className="w-full px-3.5 py-2.5 text-base text-gray-900 dark:text-white bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl outline-none focus:border-gray-300 dark:focus:border-gray-600 transition-colors placeholder:text-gray-400 dark:placeholder:text-gray-600"
                          />
                          {uploadError && (
                            <div className="px-3 py-2.5 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
                              <p className="text-xs text-red-600 dark:text-red-400 font-medium">Upload failed</p>
                              <p className="text-xs text-red-500 dark:text-red-400 mt-0.5">{uploadError}</p>
                            </div>
                          )}
                          <div className="flex gap-2">
                            <button
                              onClick={() => { setPendingFile(null); setUploadError(null) }}
                              className="flex-1 py-2.5 text-sm font-medium text-gray-900 dark:text-gray-400 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                            >
                              Cancel
                            </button>
                            <motion.button
                              whileTap={{ scale: 0.97 }}
                              onClick={() => { setUploadError(null); const f = pendingFile; if (f) uploadFile(f, pendingTitle, pendingDesc) }}
                              disabled={!pendingTitle.trim()}
                              className="flex-1 py-2.5 text-sm font-medium bg-gray-900 dark:bg-gray-700 text-white rounded-xl disabled:opacity-40 hover:bg-gray-700 dark:hover:bg-gray-600 transition-colors"
                            >
                              {uploadError ? 'Retry' : 'Upload & process'}
                            </motion.button>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
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
                      placeholder="Paste minutes of meeting, notes, decisions, ideas… Memory will extract insights automatically."
                      rows={8}
                      className="w-full px-3.5 py-3 text-base text-gray-900 dark:text-white bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl outline-none focus:border-gray-300 dark:focus:border-gray-600 transition-colors placeholder:text-gray-400 dark:placeholder:text-gray-600 resize-none"
                    />
                    <motion.button
                      whileTap={{ scale: 0.97 }}
                      onClick={pasteText}
                      disabled={pasting || !pasteTitle.trim() || !pasteContent.trim()}
                      className="w-full py-3 text-sm font-medium bg-gray-900 dark:bg-gray-700 text-white rounded-xl hover:bg-gray-700 dark:hover:bg-gray-600 disabled:opacity-40 transition-colors"
                    >
                      {pasting ? 'Adding to Memory…' : 'Add to Memory'}
                    </motion.button>
                  </motion.div>
                )}
              </AnimatePresence>

              {docs.length === 0 ? (
                <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-sm text-gray-900 dark:text-gray-400 text-center py-10">
                  No documents yet. Upload one to get started.
                </motion.p>
              ) : (
                <motion.div initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.06 } } }} className="space-y-1">
                  {docs.map((doc, i) => {
                    const isReady = doc.status === 'ready'
                    return (
                      <motion.div key={doc.id} custom={i} variants={cardVariants}
                        className={`flex items-start gap-3 px-3 py-3.5 rounded-2xl transition-colors ${
                          isReady ? 'hover:bg-gray-50 dark:hover:bg-gray-900 cursor-pointer' : ''
                        }`}
                        onClick={() => { if (isReady) setDocSheet(doc) }}
                      >
                        <span className="text-2xl shrink-0 mt-0.5">{FILE_ICONS[doc.fileType] ?? '📄'}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{doc.name}</p>
                          {doc.status === 'ready' && doc.summary && (
                            <p className="text-xs text-gray-900 dark:text-gray-400 mt-0.5 line-clamp-2">{doc.summary}</p>
                          )}
                          {doc.status === 'failed' && doc.failureReason && (
                            <p className="text-xs text-red-400 dark:text-red-400 mt-0.5 line-clamp-2">{doc.failureReason}</p>
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
                            <span className="text-xs text-gray-900 dark:text-gray-400">{fmt(doc.fileSize)}</span>
                          </div>
                        </div>
                        <div className="shrink-0 flex flex-col items-end gap-1.5 pt-0.5" onClick={(e) => e.stopPropagation()}>
                          <span className="text-xs text-gray-900 dark:text-gray-500">
                            {parseUtc(doc.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </span>
                          <button
                            onClick={(e) => { e.stopPropagation(); setDocSheet(doc) }}
                            className="p-1.5 text-gray-900 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-all min-w-[32px] min-h-[32px] flex items-center justify-center"
                            title="More options"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                              <circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>
                            </svg>
                          </button>
                        </div>
                      </motion.div>
                    )
                  })}
                </motion.div>
              )}
              </>}
            </motion.div>
          )}

          {/* TIMELINE */}
          {view === 'timeline' && (
            <motion.div key="timeline" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.2 }} className="px-4 py-6 max-w-2xl mx-auto">
              <h2 className="font-semibold text-gray-900 dark:text-white mb-6">Timeline</h2>
              {timelineLoading ? <ListSkeleton /> : timeline.length === 0 ? (
                <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-sm text-gray-900 dark:text-gray-400 text-center py-10">
                  No events yet. Upload documents to start your timeline.
                </motion.p>
              ) : (
                <div className="relative pl-6">
                  <div className="absolute left-[9px] top-2 bottom-2 w-px bg-gray-100 dark:bg-gray-800/80" />
                  <motion.div initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.04 } } }} className="space-y-4">
                    {timeline.map((ev, i) => {
                      const cfg = TIMELINE_EVENT_CONFIG[ev.type]
                      return (
                        <motion.div key={ev.id} custom={i} variants={cardVariants} className="relative">
                          {/* Dot */}
                          <motion.div
                            initial={{ scale: 0 }} animate={{ scale: 1 }}
                            transition={{ delay: i * 0.04 + 0.08, type: 'spring', stiffness: 500, damping: 28 }}
                            className={`absolute -left-6 top-2.5 w-[18px] h-[18px] rounded-full flex items-center justify-center z-10 ${cfg.dot}`}
                          >
                            <span className="text-[9px] leading-none">{cfg.icon}</span>
                          </motion.div>

                          {/* Card */}
                          <div className="flex justify-between gap-3 pl-1">
                            <div className="flex-1 min-w-0">
                              {/* Type badge + source */}
                              <div className="flex items-center gap-1.5 mb-1">
                                <span className={`inline-block text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide ${cfg.badge}`}>
                                  {cfg.label}
                                </span>
                                <span className="text-[10px] text-gray-900 dark:text-gray-500 truncate">{ev.sourceName}</span>
                              </div>
                              {/* Main text */}
                              <p className={`text-sm leading-snug ${ev.type === 'document' ? 'text-gray-900 dark:text-gray-400 italic' : 'text-gray-800 dark:text-gray-200'}`}>
                                {ev.text}
                              </p>
                            </div>
                            <span className="text-[10px] text-gray-900 dark:text-gray-500 shrink-0 pt-0.5 whitespace-nowrap">
                              {parseUtc(ev.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                            </span>
                          </div>
                        </motion.div>
                      )
                    })}
                  </motion.div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Scroll to bottom — sticks to bottom of scroll area, above the input bar */}
        <AnimatePresence>
          {view === 'chat' && showScrollBtn && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.15 }}
              className="sticky bottom-4 flex justify-center pointer-events-none"
            >
              <button
                onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}
                className="pointer-events-auto flex items-center justify-center w-9 h-9 rounded-full bg-gray-900 dark:bg-gray-700 text-white shadow-lg hover:bg-gray-700 dark:hover:bg-gray-600 transition-colors"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 5v14M5 12l7 7 7-7" />
                </svg>
              </button>
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
                  { label: '✦ Brief Me', action: () => aiAction('Brief me on this space.', '/api/brief') },
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
              <StyleToggle value={responseStyle} onChange={setResponseStyle} />
              <motion.button
                whileTap={{ scale: 0.92 }}
                type="submit" disabled={loading || !input.trim()}
                className="shrink-0 h-12 w-12 sm:h-auto sm:w-auto sm:px-5 sm:py-3 flex items-center justify-center gap-2 bg-gray-900 dark:bg-gray-700 text-white rounded-2xl hover:bg-gray-700 dark:hover:bg-gray-600 disabled:opacity-30 transition-colors"
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

      {/* ── Document Action Sheet ── */}
      <AnimatePresence>
        {docSheet && (
          <DocActionSheet
            doc={docSheet}
            onClose={() => setDocSheet(null)}
            onViewInsights={(id) => { setDocSheet(null); openDocInsights(id) }}
            onDelete={deleteDocument}
            onRename={renameDoc}
            onRetry={retryDoc}
            onAskAboutDoc={(docName) => {
              setDocSheet(null)
              setView('chat')
              sendMessage(`Tell me about this document: ${docName}`)
            }}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Sub-components ──

function StyleToggle({ value, onChange }: { value: 'short' | 'detailed'; onChange: (v: 'short' | 'detailed') => void }) {
  return (
    <div className="shrink-0 flex items-center h-12 bg-gray-100 dark:bg-gray-800 rounded-2xl p-1 gap-0.5">
      {(['short', 'detailed'] as const).map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onChange(s)}
          className={`relative px-2.5 py-1.5 text-[11px] font-medium rounded-xl transition-colors capitalize ${
            value === s
              ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
              : 'text-gray-900 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-400'
          }`}
        >
          {s}
        </button>
      ))}
    </div>
  )
}

function EmptyState({ spaceName, onBriefMe, onCatchMeUp, onTimeline, onDocuments }: {
  spaceName?: string; onBriefMe: () => void; onCatchMeUp: () => void; onTimeline: () => void; onDocuments: () => void
}) {
  const actions = [
    { emoji: '✦', label: 'Brief Me', sub: '2-minute executive summary', onClick: onBriefMe },
    { emoji: '↻', label: 'Catch Me Up', sub: 'Changes since your last visit', onClick: onCatchMeUp },
    { emoji: '◷', label: 'Timeline', sub: 'Full space history', onClick: onTimeline },
    { emoji: '⊞', label: 'Documents', sub: 'Upload & manage files', onClick: onDocuments },
  ]

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }} className="flex flex-col items-center min-h-[55vh] pt-8">
      <motion.p initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="text-gray-900 dark:text-gray-400 text-sm mb-1">
        What would you like to know?
      </motion.p>
      <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.15 }} className="text-gray-900 dark:text-gray-500 text-xs mb-10">
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
            <div className="text-xl mb-2.5 text-gray-900 dark:text-gray-500 group-hover:text-gray-600 dark:group-hover:text-gray-300 transition-colors">{a.emoji}</div>
            <p className="text-sm font-semibold text-gray-900 dark:text-white">{a.label}</p>
            <p className="text-xs text-gray-900 dark:text-gray-400 mt-0.5 leading-relaxed">{a.sub}</p>
          </motion.button>
        ))}
      </div>
    </motion.div>
  )
}

function ChatMessage({ message, isStreaming }: { message: Message; isStreaming?: boolean }) {
  const isUser = message.role === 'user'
  const showDots = isStreaming && message.content === ''

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
          // Always render markdown — no plain-text intermediate state that causes a flash on completion
          <div className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
            {isStreaming && (
              <motion.span
                animate={{ opacity: [1, 0, 1] }}
                transition={{ repeat: Infinity, duration: 0.9, ease: 'linear' }}
                className="inline-block w-0.5 h-[0.85em] bg-gray-400 dark:bg-gray-400 ml-0.5 align-text-bottom rounded-full"
              />
            )}
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
        active ? 'bg-gray-900 dark:bg-gray-700 text-white shadow-sm'
               : 'text-gray-900 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800'
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
      <span className="text-xs text-gray-900 dark:text-gray-500 flex items-center gap-1.5">
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
                <p className="text-xs text-gray-900 dark:text-gray-500 mt-0.5">
                  {fmt(doc.fileSize)} · {parseUtc(doc.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
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
              {doc.summary && (() => {
                const firstSentMatch = doc.summary.match(/^[^.!?]+[.!?]+\s*/)
                const short = firstSentMatch && firstSentMatch[0].length < doc.summary.length * 0.75
                  ? firstSentMatch[0].trim()
                  : doc.summary
                const detail = short !== doc.summary ? doc.summary.slice(short.length).trim() : ''
                return (
                  <>
                    <InsightSection label="Short Summary" icon="💡" items={[short]} isSummary />
                    {detail && <InsightSection label="Detail Summary" icon="📋" items={[detail]} isSummary />}
                  </>
                )
              })()}
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
                <p className="text-sm text-gray-900 dark:text-gray-500 text-center py-4">No insights extracted from this document.</p>
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
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-900 dark:text-gray-500">{label}</p>
      </div>
      {isSummary ? (
        <p className="text-sm text-gray-900 dark:text-gray-300 leading-relaxed">{items[0]}</p>
      ) : (
        <div className="space-y-2">
          {items.map((item, i) => (
            <div key={i} className={`flex gap-2.5 text-sm px-3 py-2.5 rounded-xl ${
              accent === 'amber'
                ? 'bg-amber-50 dark:bg-amber-900/10 text-amber-800 dark:text-amber-300'
                : 'bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-300'
            }`}>
              <span className="shrink-0 text-gray-900 dark:text-gray-500 mt-0.5">—</span>
              <span className="leading-relaxed">{item}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function DocActionSheet({ doc, onClose, onViewInsights, onDelete, onRename, onRetry, onAskAboutDoc }: {
  doc: Doc
  onClose: () => void
  onViewInsights: (id: string) => void
  onDelete: (id: string) => Promise<void>
  onRename: (id: string, name: string) => Promise<void>
  onRetry: (id: string) => Promise<void>
  onAskAboutDoc: (docName: string) => void
}) {
  const [mode, setMode] = useState<'actions' | 'rename' | 'delete'>('actions')
  const [newName, setNewName] = useState(doc.name)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [viewing, setViewing] = useState(false)
  const [viewError, setViewError] = useState<string | null>(null)

  async function handleRetry() {
    setRetrying(true)
    await onRetry(doc.id)
    setRetrying(false)
  }

  async function handleRename() {
    if (!newName.trim()) return
    setSaving(true)
    await onRename(doc.id, newName.trim())
    setSaving(false)
    setMode('actions')
  }

  async function handleDelete() {
    setDeleting(true)
    await onDelete(doc.id)
    setDeleting(false)
  }

  async function handleViewDocument() {
    setViewing(true)
    setViewError(null)
    // Open the tab synchronously so popup blockers don't interfere,
    // then navigate it to the blob URL once the file is fetched.
    const win = window.open('about:blank', '_blank')
    try {
      const res = await fetch(`/api/documents/${doc.id}/file`)
      if (!res.ok) {
        win?.close()
        let msg = `Error ${res.status}`
        try { const body = await res.json(); msg = body.error ?? msg } catch {}
        throw new Error(msg)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      if (win) {
        win.location.href = url
        setTimeout(() => URL.revokeObjectURL(url), 30000)
        onClose()
      } else {
        // Popup was blocked — fall back to a download link
        const a = document.createElement('a')
        a.href = url
        a.download = doc.name
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        setTimeout(() => URL.revokeObjectURL(url), 30000)
        onClose()
      }
    } catch (err) {
      win?.close()
      setViewError(err instanceof Error ? err.message : 'Failed to load document')
    } finally {
      setViewing(false)
    }
  }

  const isReady = doc.status === 'ready'
  const canViewFile = isReady && doc.fileType !== 'text'

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-end justify-center"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <motion.div
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', stiffness: 420, damping: 36 }}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-lg bg-white dark:bg-[#1c1c1e] rounded-t-3xl shadow-2xl max-h-[85vh] overflow-y-auto"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 16px)' }}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-9 h-1 bg-gray-200 dark:bg-gray-700 rounded-full" />
        </div>

        {mode === 'actions' && (
          <>
            {/* Doc info */}
            <div className="px-5 pt-3 pb-4">
              <div className="flex items-center gap-3">
                <span className="text-2xl shrink-0">{FILE_ICONS[doc.fileType] ?? '📄'}</span>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-gray-900 dark:text-white text-sm leading-snug truncate">{doc.name}</p>
                  <p className="text-xs text-gray-900 dark:text-gray-500 mt-0.5">
                    <span className={STATUS_COLOR[doc.status]}>{doc.status.charAt(0).toUpperCase() + doc.status.slice(1)}</span>
                    {' · '}{fmt(doc.fileSize)}
                    {' · '}{parseUtc(doc.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </p>
                  {doc.status === 'failed' && doc.failureReason && (
                    <p className="text-xs text-red-400 mt-1.5 leading-relaxed">{doc.failureReason}</p>
                  )}
                </div>
              </div>
              {doc.status === 'ready' && doc.summary && (
                <div className="mt-3 px-3 py-2.5 bg-gray-50 dark:bg-gray-900 rounded-xl">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-900 dark:text-gray-500 mb-1">Short Summary</p>
                  <p className="text-xs text-gray-600 dark:text-gray-400 leading-relaxed">{doc.summary}</p>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="px-4 pb-2 space-y-1">
              {doc.status === 'failed' && doc.fileType !== 'text' && (
                <SheetRow
                  icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>}
                  label={retrying ? 'Retrying…' : 'Retry processing'}
                  onClick={handleRetry}
                />
              )}
              {canViewFile && (
                <>
                  <SheetRow
                    icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>}
                    label={viewing ? 'Loading…' : 'View document'}
                    onClick={viewing ? undefined : handleViewDocument}
                    disabled={viewing}
                  />
                  {viewError && (
                    <p className="text-xs text-red-400 px-4 pb-1 leading-relaxed">{viewError}</p>
                  )}
                </>
              )}
              {isReady && (
                <>
                  <SheetRow
                    icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>}
                    label="Ask about this document"
                    onClick={() => onAskAboutDoc(doc.name)}
                  />
                  <SheetRow
                    icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>}
                    label="Summary & insights"
                    onClick={() => onViewInsights(doc.id)}
                  />
                </>
              )}
              <SheetRow
                icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>}
                label="Rename"
                onClick={() => { setNewName(doc.name); setMode('rename') }}
              />
              <SheetRow
                icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>}
                label="Delete"
                destructive
                onClick={() => setMode('delete')}
              />
            </div>

            <div className="px-4 pt-1 pb-5">
              <button
                onClick={onClose}
                className="w-full py-3.5 text-sm font-medium text-gray-900 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-2xl hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
              >
                Cancel
              </button>
            </div>
          </>
        )}

        {mode === 'rename' && (
          <div className="px-5 pt-3 pb-5">
            <button onClick={() => setMode('actions')} className="flex items-center gap-1.5 text-sm text-gray-900 dark:text-gray-400 mb-5 hover:text-gray-700 dark:hover:text-gray-200 transition-colors">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
              Back
            </button>
            <p className="text-base font-semibold text-gray-900 dark:text-white mb-4">Rename document</p>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleRename() }}
              autoFocus
              className="w-full px-4 py-3 text-base text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors mb-4"
            />
            <div className="flex gap-3">
              <button
                onClick={() => setMode('actions')}
                className="flex-1 py-3 text-sm font-medium text-gray-900 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-xl hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleRename}
                disabled={saving || !newName.trim()}
                className="flex-1 py-3 text-sm font-medium text-white bg-gray-900 dark:bg-gray-700 rounded-xl disabled:opacity-40 hover:bg-gray-700 dark:hover:bg-gray-600 transition-colors"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}

        {mode === 'delete' && (
          <div className="px-5 pt-3 pb-5">
            <button onClick={() => setMode('actions')} className="flex items-center gap-1.5 text-sm text-gray-900 dark:text-gray-400 mb-5 hover:text-gray-700 dark:hover:text-gray-200 transition-colors">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
              Back
            </button>
            <p className="text-base font-semibold text-gray-900 dark:text-white mb-2">Delete document?</p>
            <p className="text-sm text-gray-900 dark:text-gray-400 mb-6 leading-relaxed">
              This removes the file and all memory associated with it. This cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setMode('actions')}
                className="flex-1 py-3 text-sm font-medium text-gray-900 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-xl hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="flex-1 py-3 text-sm font-medium text-white bg-red-500 rounded-xl disabled:opacity-50 hover:bg-red-600 transition-colors"
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>
  )
}

function ChatSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      {[80, 60, 90, 50, 75].map((w, i) => (
        <div key={i} className={`flex ${i % 2 === 0 ? 'justify-start' : 'justify-end'}`}>
          <div className={`h-10 rounded-2xl bg-gray-100 dark:bg-gray-800`} style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="space-y-3 animate-pulse mt-2">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-3 px-1 py-2">
          <div className="w-8 h-8 rounded-xl bg-gray-100 dark:bg-gray-800 shrink-0" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 bg-gray-100 dark:bg-gray-800 rounded w-3/4" />
            <div className="h-2.5 bg-gray-100 dark:bg-gray-800 rounded w-1/2" />
          </div>
        </div>
      ))}
    </div>
  )
}

function SheetRow({ icon, label, onClick, destructive, disabled }: {
  icon: React.ReactNode; label: string; onClick?: () => void; destructive?: boolean; disabled?: boolean
}) {
  return (
    <motion.button
      whileTap={disabled ? {} : { scale: 0.98 }}
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center gap-4 px-4 py-3.5 rounded-2xl text-left transition-colors disabled:opacity-50 ${
        destructive
          ? 'text-red-500 hover:bg-red-50 dark:hover:bg-red-900/10'
          : 'text-gray-900 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
      }`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="text-sm font-medium">{label}</span>
    </motion.button>
  )
}


