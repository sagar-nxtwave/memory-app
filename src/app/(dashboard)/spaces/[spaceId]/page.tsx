'use client'

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChartBlock, parseChartJson } from '@/components/charts/ChartBlock'
import { useSpacesList } from '@/lib/hooks/useSpacesList'
import { useVoiceRecorder } from '@/lib/hooks/useVoiceRecorder'
import { formatRelativeTime } from '@/lib/utils/date'
import { LLM_MODELS } from '@/lib/ai/models'

type MessageRole = 'user' | 'assistant'
interface Citation { documentId?: string; documentName: string; spaceName?: string; url?: string; sourceType?: 'internal' | 'web'; citationId?: string }
interface DocumentImage { url: string; alt: string; documentName: string }
interface Message { id: string; role: MessageRole; content: string; createdAt: string; isTyping?: boolean; citations?: Citation[]; documentImages?: DocumentImage[]; thinkingSteps?: string[]; thinkingStepActions?: string[]; thinkingStepResults?: string[]; suggestions?: string[] }
interface Doc { id: string; name: string; fileType: string; status: string; summary: string | null; failureReason: string | null; createdAt: string; fileSize: number; version: number }
interface PendingUpload { id: string; file: File; title: string; description: string; progress: number; status: 'queued' | 'uploading' | 'done' | 'error'; error?: string }
interface DocDetail extends Doc {
  keyNumbers: string[] | null
  risks: string[] | null
  decisions: string[] | null
  importantDates: string[] | null
}
interface TimelineEvent { id: string; type: 'document' | 'decision' | 'risk' | 'number'; text: string; sourceName: string; sourceFileType: string; date: string; status: string }
type SpaceStatus = 'new' | 'on_track' | 'at_risk' | 'on_hold' | 'completed'
interface Space { id: string; name: string; description: string | null; status: SpaceStatus; lastVisit: string | null; imageKey: string | null }

const STATUS_CONFIG: Record<SpaceStatus, { label: string; dot: string; badge: string }> = {
  new:       { label: 'New',       dot: 'bg-blue-400',                 badge: 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400' },
  on_track:  { label: 'On Track',  dot: 'bg-emerald-400',              badge: 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400' },
  at_risk:   { label: 'At Risk',   dot: 'bg-red-400',                  badge: 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400' },
  on_hold:   { label: 'On Hold',   dot: 'bg-amber-400',                badge: 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400' },
  completed: { label: 'Completed', dot: 'bg-gray-400 dark:bg-gray-500', badge: 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-400' },
}
type View = 'chat' | 'documents' | 'timeline' | 'recents'
interface MentionChip { spaceId: string; spaceName: string; docId?: string; docName?: string }
interface MentionDoc { id: string; name: string; fileType: string }

import { parseUtc, formatDateTime } from '@/lib/utils/date'

const FILE_ICONS: Record<string, string> = { pdf: '📄', docx: '📝', xlsx: '📊', csv: '📋', text: '✏️', pptx: '📊', image: '🖼️', zip: '🗜️', email: '✉️', cad: '📐' }

const TIMELINE_EVENT_CONFIG = {
  document: { label: 'Upload',   icon: '↑', dot: 'bg-blue-100 dark:bg-blue-900/30',        badge: 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400',     iconColor: 'text-blue-600 dark:text-blue-400' },
  decision:  { label: 'Decision', icon: '✓', dot: 'bg-green-100 dark:bg-green-900/30',      badge: 'bg-green-50 dark:bg-green-900/30 text-green-600 dark:text-green-400',  iconColor: 'text-green-600 dark:text-green-400' },
  risk:      { label: 'Risk',     icon: '!', dot: 'bg-red-100 dark:bg-red-900/30',          badge: 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400',          iconColor: 'text-red-600 dark:text-red-400' },
  number:    { label: 'Figure',   icon: '#', dot: 'bg-blue-100 dark:bg-blue-900/30',        badge: 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400',     iconColor: 'text-blue-600 dark:text-blue-400' },
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

const PROCESSING_STAGES = ['Extracting text', 'Analyzing images', 'Generating summary', 'Building search index']

const msgVariants = {
  hidden: { opacity: 0, y: 10, scale: 0.98 },
  show: { opacity: 1, y: 0, scale: 1, transition: { type: 'spring' as const, stiffness: 500, damping: 30 } },
}

const cardVariants = {
  hidden: { opacity: 0, y: 16 },
  show: (i: number) => ({ opacity: 1, y: 0, transition: { delay: i * 0.08, type: 'spring' as const, stiffness: 400, damping: 28 } }),
}

// Tracks permanently-failed image URLs so we don't retry on re-render
const failedImageUrls = new Set<string>()

const ChatImage = React.memo(function ChatImage({ url, alt }: { url: string; alt: string }) {
  const [loaded, setLoaded] = React.useState(false)
  const [errored, setErrored] = React.useState(() => failedImageUrls.has(url))

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
        onError={() => { failedImageUrls.add(url); setErrored(true) }}
        className={`rounded-xl border border-gray-200 dark:border-gray-700 cursor-zoom-in hover:opacity-90 transition-opacity object-cover ${loaded ? 'block' : 'hidden'}`}
        style={{ width: 200, height: 150 }}
        loading="lazy"
      />
    </a>
  )
})

export default function SpacePage() {
  const { spaceId } = useParams<{ spaceId: string }>()
  const router = useRouter()
  const searchParams = useSearchParams()
  const nameHint = searchParams.get('name')

  const [space, setSpace] = useState<Space | null>(null)
  const [statusOpen, setStatusOpen] = useState(false)
  const [uploadingCover, setUploadingCover] = useState(false)
  const [coverBust, setCoverBust] = useState(0)
  const coverInputRef = useRef<HTMLInputElement>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null)
  const [responseStyle, setResponseStyle] = useState<'short' | 'detailed'>('short')
  const [provider, setProvider] = useState<string>(LLM_MODELS[0].id)
  const [view, setView] = useState<View>('chat')
  const [docs, setDocs] = useState<Doc[]>([])
  const [timeline, setTimeline] = useState<TimelineEvent[]>([])
  const [expandedTimelineGroups, setExpandedTimelineGroups] = useState<Record<string, boolean>>({})
  const [uploadingAll, setUploadingAll] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([])
  const [docInputMode, setDocInputMode] = useState<'upload' | 'text'>('upload')
  const [pasteTitle, setPasteTitle] = useState('')
  const [pasteContent, setPasteContent] = useState('')
  const [pasting, setPasting] = useState(false)
  const [docSheet, setDocSheet] = useState<Doc | null>(null)
  const [selectedDoc, setSelectedDoc] = useState<DocDetail | null>(null)
  const [loadingDocDetail, setLoadingDocDetail] = useState(false)

  const [chatLoading, setChatLoading] = useState(true)
  const [docsLoading, setDocsLoading] = useState(false)
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [readyDocs, setReadyDocs] = useState<{ id: string; name: string; fileType: string }[]>([])
  // Shared cache — avoids re-fetching /api/spaces on every space-page visit (sidebar already has it)
  const { spaces: allSpaces } = useSpacesList()
  const otherSpaces = useMemo(() => allSpaces.filter((s) => s.id !== spaceId), [allSpaces, spaceId])
  const [spaceSuggestion, setSpaceSuggestion] = useState<{ id: string; name: string } | null>(null)
  const spaceSuggestionRef = useRef<{ id: string; name: string } | null>(null)
  const [docSearch, setDocSearch] = useState('')
  const [docTypeFilter, setDocTypeFilter] = useState<string>('all')
  const [docViewMode, setDocViewMode] = useState<'grid' | 'list'>('list')
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionChips, setMentionChips] = useState<MentionChip[]>([])
  // 'space' = picking which project (current space's docs shown flat, others as drill-in
  // entries); 'doc' = picking a document within mentionSpaceCtx (only reached for OTHER spaces)
  const [mentionStage, setMentionStage] = useState<'space' | 'doc'>('space')
  const [mentionSpaceCtx, setMentionSpaceCtx] = useState<{ id: string; name: string } | null>(null)
  const [otherSpaceDocs, setOtherSpaceDocs] = useState<Record<string, MentionDoc[]>>({})
  const [mentionActiveIdx, setMentionActiveIdx] = useState(0)
  const mentionRef = useRef<HTMLDivElement>(null)
  const [webSearchConfirm, setWebSearchConfirm] = useState<{ question: string; sid: string; endpoint: string; body: object } | null>(null)

  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const mobileHeroRef = useRef<HTMLDivElement>(null)
  const [showHeaderName, setShowHeaderName] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const pollingRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const loadingRef = useRef(false)
  const [showScrollBtn, setShowScrollBtn] = useState(false)

  // Voice input (browser-native speech-to-text) — appends the transcript to the input box.
  const handleSpeechResult = useCallback((transcript: string) => {
    setInput((prev) => (prev ? `${prev} ${transcript}` : transcript))
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [])
  const speech = useVoiceRecorder(handleSpeechResult)

  useEffect(() => {
    fetch(`/api/spaces/${spaceId}`).then((r) => r.ok ? r.json() : null).then((d) => d && setSpace(d))
    fetch(`/api/chat?spaceId=${spaceId}`).then((r) => r.ok ? r.json() : []).then((d) => { setMessages(Array.isArray(d) ? d : []); setChatLoading(false) }).catch(() => setChatLoading(false))
    fetch(`/api/documents?spaceId=${spaceId}`).then((r) => r.ok ? r.json() : []).then((d: Doc[]) => { if (Array.isArray(d)) setReadyDocs(d.filter((doc) => doc.status === 'ready').map((doc) => ({ id: doc.id, name: doc.name, fileType: doc.fileType }))) })
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

  // Show space name in header when mobile hero scrolls out of view
  useEffect(() => {
    const hero = mobileHeroRef.current
    if (!hero) return
    const observer = new IntersectionObserver(
      ([entry]) => setShowHeaderName(!entry.isIntersecting),
      { threshold: 0, root: scrollContainerRef.current }
    )
    observer.observe(hero)
    return () => observer.disconnect()
  }, [chatLoading, view])

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
          if (Array.isArray(data)) setDocs((prev) => {
            // Don't show docs that are currently mid-upload (pendingUploads tracks those)
            const uploadingNames = new Set(
              pendingUploads.filter(p => p.status === 'uploading' || p.status === 'queued').map(p => p.title.trim() || p.file.name)
            )
            return data.filter((d: Doc) => !(d.status === 'pending' && uploadingNames.has(d.name)))
          })
        }
      } finally {
        pollingRef.current = false
      }
    }, 5000)

    return () => clearInterval(interval)
  }, [view, docs, spaceId])

  // Keep readyDocs in sync with docs so @ mention list updates after processing completes
  useEffect(() => {
    setReadyDocs(docs.filter((d) => d.status === 'ready').map((d) => ({ id: d.id, name: d.name, fileType: d.fileType })))
  }, [docs])

  function loadOtherSpaceDocs(otherSpaceId: string) {
    if (otherSpaceDocs[otherSpaceId]) return
    fetch(`/api/documents?spaceId=${otherSpaceId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: (Doc | MentionDoc)[]) => {
        if (Array.isArray(data)) {
          setOtherSpaceDocs((p) => ({
            ...p,
            [otherSpaceId]: data.filter((d) => !('status' in d) || d.status === 'ready').map((d) => ({ id: d.id, name: d.name, fileType: d.fileType })),
          }))
        }
      })
  }

  type MentionItem =
    | { kind: 'doc'; id: string; label: string; icon: string; doc: MentionDoc }
    | { kind: 'otherspace'; id: string; label: string }
    | { kind: 'allspace'; id: string; label: string }

  // Stage 'space': this space's own docs listed directly, plus other projects as drill-in
  // entries. Stage 'doc': reached only after clicking an other project — its docs + "all docs" option.
  function getMentionItems(): MentionItem[] {
    const q = (mentionQuery ?? '').toLowerCase()
    if (mentionStage === 'doc' && mentionSpaceCtx) {
      const items: MentionItem[] = []
      if (!mentionChips.some((c) => c.spaceId === mentionSpaceCtx.id && !c.docId)) {
        items.push({ kind: 'allspace', id: '__space__', label: `All docs in ${mentionSpaceCtx.name}` })
      }
      const docs = (otherSpaceDocs[mentionSpaceCtx.id] ?? []).filter((d) =>
        !mentionChips.some((c) => c.docId === d.id) && d.name.toLowerCase().includes(q)
      )
      items.push(...docs.map((d) => ({ kind: 'doc' as const, id: d.id, label: d.name, icon: FILE_ICONS[d.fileType] ?? '📄', doc: d })))
      return items
    }
    const currentDocs = readyDocs
      .filter((d) => !mentionChips.some((c) => c.docId === d.id) && d.name.toLowerCase().includes(q))
      .map((d) => ({ kind: 'doc' as const, id: d.id, label: d.name, icon: FILE_ICONS[d.fileType] ?? '📄', doc: d }))
    const matchingSpaces = otherSpaces
      .filter((s) => s.name.toLowerCase().includes(q))
      .map((s) => ({ kind: 'otherspace' as const, id: s.id, label: s.name }))
    return [...currentDocs, ...matchingSpaces]
  }

  function selectMentionItem(item: MentionItem) {
    if (item.kind === 'otherspace') {
      const atIdx = input.lastIndexOf('@')
      setInput(input.slice(0, atIdx))
      setMentionStage('doc')
      setMentionSpaceCtx({ id: item.id, name: item.label })
      setMentionQuery('')
      setMentionActiveIdx(0)
      loadOtherSpaceDocs(item.id)
      return
    }
    const atIdx = input.lastIndexOf('@')
    setInput(input.slice(0, atIdx))
    if (item.kind === 'allspace' && mentionSpaceCtx) {
      setMentionChips((p) => [...p, { spaceId: mentionSpaceCtx.id, spaceName: mentionSpaceCtx.name }])
    } else if (item.kind === 'doc') {
      const isCurrentSpace = mentionStage === 'space'
      setMentionChips((p) => [...p, {
        spaceId: isCurrentSpace ? spaceId : mentionSpaceCtx!.id,
        spaceName: isCurrentSpace ? (space?.name ?? '') : mentionSpaceCtx!.name,
        docId: item.doc.id,
        docName: item.doc.name,
      }])
    }
    setMentionQuery(null)
    setMentionStage('space')
    setMentionSpaceCtx(null)
    setMentionActiveIdx(0)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  // Shared SSE streaming handler — used by chat, Brief Me, and Catch Me Up
  async function handleStream(endpoint: string, body: object, tempUserId: string, initialSid: string, signal?: AbortSignal) {
    let sid = initialSid
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
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
              setMessages((p) => p.map((m) => {
                if (m.id === tempUserId) return { ...m, id: event.userMessageId }
                return m
              }))
            } else if (event.type === 'thinking') {
              setMessages((p) => p.map((m) => {
                if (m.id !== sid) return m
                const steps = [...(m.thinkingSteps ?? []), event.step]
                const actions = [...(m.thinkingStepActions ?? []), event.action ?? '']
                const results = [...(m.thinkingStepResults ?? []), event.result ?? '']
                return { ...m, thinkingSteps: steps, thinkingStepActions: actions, thinkingStepResults: results }
              }))
            } else if (event.type === 'webSearchConfirm') {
              setWebSearchConfirm({ question: event.question, sid, endpoint, body })
            } else if (event.type === 'delta') {
              accumulated += event.content
              setMessages((p) => p.map((m) => (m.id === sid ? { ...m, content: accumulated } : m)))
            } else if (event.type === 'done') {
              const finalContent = accumulated
              setMessages((p) => p.map((m) => {
                if (m.id !== sid) return m
                return { ...m, content: finalContent, citations: event.citations ?? [], documentImages: event.documentImages ?? [], suggestions: event.suggestions ?? [], ...(event.assistantMessageId ? { id: event.assistantMessageId } : {}) }
              }))
            } else if (event.type === 'error') {
              setMessages((p) => p.map((m) => (m.id === sid ? { ...m, content: event.message ?? 'Something went wrong.' } : m)))
            }
          } catch {}
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setMessages((p) =>
        p.map((m) => (m.id === sid ? { ...m, content: 'Something went wrong. Please try again.' } : m))
      )
    }
  }

  async function confirmWebSearch(accept: boolean) {
    if (!webSearchConfirm) return
    const { question, sid, endpoint, body } = webSearchConfirm
    setWebSearchConfirm(null)
    if (!accept) return
    // Re-send the same request with webSearch: true override
    setLoading(true)
    loadingRef.current = true
    const tempUserId = `u-${Date.now()}`
    const newSid = `s-${Date.now()}`
    setMessages((p) => [
      ...p,
      { id: tempUserId, role: 'user', content: question, createdAt: new Date().toISOString() },
      { id: newSid, role: 'assistant', content: '', createdAt: new Date().toISOString(), thinkingSteps: [] },
    ])
    setStreamingMessageId(newSid)
    await handleStream(endpoint, { ...(body as object), webSearch: true }, tempUserId, newSid)
    setStreamingMessageId(null)
    setLoading(false)
    loadingRef.current = false
  }

  async function sendMessage(content: string) {
    if (!content.trim() || loadingRef.current) return
    loadingRef.current = true
    setInput('')
    if (inputRef.current) inputRef.current.style.height = 'auto'
    const chips = mentionChips
    const docIds = chips.filter((c) => c.docId).map((c) => c.docId!)
    const otherSpaceIds = [...new Set(chips.filter((c) => c.spaceId !== spaceId).map((c) => c.spaceId))]
    setMentionChips([])
    setMentionQuery(null)
    setSpaceSuggestion(null)
    spaceSuggestionRef.current = null
    setLoading(true)

    const tempUserId = `u-${Date.now()}`
    const sid = `s-${Date.now()}`
    const controller = new AbortController()
    abortRef.current = controller

    setMessages((p) => [
      ...p,
      { id: tempUserId, role: 'user', content, createdAt: new Date().toISOString() },
      { id: sid, role: 'assistant', content: '', createdAt: new Date().toISOString(), thinkingSteps: [] },
    ])
    setStreamingMessageId(sid)

    const crossSpace = !!spaceSuggestionRef.current
    if (crossSpace) {
      await handleStream('/api/global-chat', { content, responseStyle, provider }, tempUserId, sid, controller.signal)
    } else {
      await handleStream('/api/chat', { spaceId, content, spaceName: space?.name, responseStyle, provider, mentionedDocIds: docIds.length > 0 ? docIds : undefined, mentionedSpaceIds: otherSpaceIds.length > 0 ? otherSpaceIds : undefined }, tempUserId, sid, controller.signal)
    }

    abortRef.current = null
    setStreamingMessageId(null)
    setLoading(false)
    loadingRef.current = false
    setTimeout(() => inputRef.current?.focus(), 100)
  }

  async function aiAction(label: string, endpoint: string) {
    setView('chat')
    setLoading(true)
    loadingRef.current = true

    const tempUserId = `u-${Date.now()}`
    const sid = `s-${Date.now()}`

    setMessages((p) => [
      ...p,
      { id: tempUserId, role: 'user', content: label, createdAt: new Date().toISOString() },
      { id: sid, role: 'assistant', content: '', createdAt: new Date().toISOString(), thinkingSteps: [] },
    ])
    setStreamingMessageId(sid)

    await handleStream(endpoint, { spaceId, responseStyle, provider, spaceName: space?.name }, tempUserId, sid)

    setStreamingMessageId(null)
    setLoading(false)
    loadingRef.current = false
  }

  const fetchDocs = useCallback(async () => {
    const res = await fetch(`/api/documents?spaceId=${spaceId}`)
    if (!res.ok) return
    const data = await res.json()
    if (Array.isArray(data)) {
      setDocs(data)
      setReadyDocs(data.filter((doc: Doc) => doc.status === 'ready').map((doc: Doc) => ({ id: doc.id, name: doc.name, fileType: doc.fileType })))
    }
    setDocsLoading(false)
  }, [spaceId])

  const stageFiles = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files)
    const newItems: PendingUpload[] = arr.map((file) => ({
      id: `${Date.now()}-${Math.random()}`,
      file,
      title: file.name.replace(/\.[^.]+$/, ''),
      description: '',
      progress: 0,
      status: 'queued',
    }))
    setPendingUploads((prev) => [...prev, ...newItems])
  }, [])

  const uploadSingleFile = useCallback(async (item: PendingUpload): Promise<boolean> => {
    try {
      setPendingUploads((prev) => prev.map((p) => p.id === item.id ? { ...p, status: 'uploading', progress: 0 } : p))

      // Step 1: Get presigned URL + create DB record
      const presignRes = await fetch('/api/documents/presign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spaceId, fileName: item.file.name, fileSize: item.file.size, customName: item.title.trim() || undefined }),
      })
      if (!presignRes.ok) {
        const body = await presignRes.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to prepare upload')
      }
      const { documentId, uploadUrl } = await presignRes.json()

      // Step 2: Upload directly to B2/MinIO via XHR (for progress tracking)
      const uploadResult = await new Promise<{ ok: boolean; status: number; body: string }>((resolve) => {
        const xhr = new XMLHttpRequest()
        xhr.open('PUT', uploadUrl)
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100)
            setPendingUploads((prev) => prev.map((p) => p.id === item.id ? { ...p, progress: pct } : p))
          }
        }
        xhr.onload = () => resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, body: xhr.responseText })
        // status stays 0 on a genuine network/CORS block (browser can't even read a response) —
        // any other status means the request reached B2 and it rejected it for a specific reason.
        xhr.onerror = () => resolve({ ok: false, status: xhr.status, body: xhr.responseText })
        xhr.send(item.file)
      })

      if (!uploadResult.ok) {
        // CORS block (status=0) → fall back to server-side proxy upload
        if (uploadResult.status === 0) {
          setPendingUploads((prev) => prev.map((p) => p.id === item.id ? { ...p, progress: 50 } : p))
          const proxyRes = await fetch(`/api/documents/${documentId}/upload`, {
            method: 'PUT',
            headers: { 'Content-Type': item.file.type || 'application/octet-stream' },
            body: item.file,
          })
          if (!proxyRes.ok) {
            await fetch(`/api/documents/${documentId}`, { method: 'DELETE' }).catch(() => {})
            const body = await proxyRes.json().catch(() => ({}))
            throw new Error(body.error ?? 'Upload failed via proxy')
          }
        } else {
          // Clean up ghost DB record
          await fetch(`/api/documents/${documentId}`, { method: 'DELETE' }).catch(() => {})
          const reason = `Upload to storage failed — B2 returned HTTP ${uploadResult.status}${uploadResult.body ? `: ${uploadResult.body.slice(0, 300)}` : ''}`
          throw new Error(reason)
        }
      }

      // Step 3: Notify server to start processing
      const confirmRes = await fetch('/api/documents/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId }),
      })
      if (!confirmRes.ok) throw new Error('Failed to start processing')

      setPendingUploads((prev) => prev.map((p) => p.id === item.id ? { ...p, status: 'done', progress: 100 } : p))
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed'
      setPendingUploads((prev) => prev.map((p) => p.id === item.id ? { ...p, status: 'error', error: msg } : p))
      return false
    }
  }, [spaceId])

  const uploadAll = useCallback(async () => {
    const queued = pendingUploads.filter((p) => p.status === 'queued' || p.status === 'error')
    if (queued.length === 0) return
    setUploadingAll(true)
    for (const item of queued) {
      await uploadSingleFile(item)
    }
    await fetchDocs()
    // Remove successfully uploaded items after a short delay
    setTimeout(() => {
      setPendingUploads((prev) => prev.filter((p) => p.status !== 'done'))
    }, 1500)
    setUploadingAll(false)
  }, [pendingUploads, uploadSingleFile, fetchDocs])

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
    setReadyDocs((prev) => prev.filter((d) => d.id !== docId))
    setDocSheet(null)
  }

  async function retryDoc(docId: string) {
    const res = await fetch(`/api/documents/${docId}/retry`, { method: 'POST' })
    if (res.ok) {
      setDocs((prev) => prev.map((d) => d.id === docId ? { ...d, status: 'processing', failureReason: null } : d))
      setDocSheet(null)
    } else if (res.status === 404) {
      // Document no longer exists — remove from UI
      setDocs((prev) => prev.filter((d) => d.id !== docId))
      setDocSheet(null)
    } else {
      const data = await res.json().catch(() => ({}))
      alert(data.error ?? 'Retry failed. Please delete and re-upload.')
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

  async function uploadCover(file: File) {
    setUploadingCover(true)
    const form = new FormData()
    form.append('file', file)
    const res = await fetch(`/api/spaces/${spaceId}/image`, { method: 'POST', body: form })
    if (res.ok) {
      const { imageKey } = await res.json()
      setSpace((s) => s ? { ...s, imageKey } : s)
      setCoverBust((b) => b + 1)
      window.dispatchEvent(new CustomEvent('space-created')) // refresh sidebar/home caches
    }
    setUploadingCover(false)
  }

  async function openDocuments() {
    setView('documents')
    setDocsLoading(true)
    await fetchDocs()
  }

  async function openRecents() {
    setView('recents')
    setDocsLoading(true)
    await fetchDocs()
  }

  const isEmpty = messages.length === 0

  return (
    <div className="flex flex-col h-full bg-[#F8FAFC] dark:bg-[#0f0f0f]">

      {/* ── Header ── */}
      <motion.header
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="flex items-center gap-2 px-4 pb-3 sm:pb-3.5 md:pb-4 min-h-[64px] sm:min-h-[72px] md:min-h-[80px] shrink-0 z-20 relative"
        style={{ paddingTop: 'max(0.875rem, env(safe-area-inset-top))' }}
      >
        {/* Mobile: back pill — chevron + "Chats" label */}
        <button
          onClick={() => router.push('/')}
          className="md:hidden shrink-0 flex items-center gap-2 px-4 py-3 bg-white dark:bg-gray-800 rounded-full shadow-[0_4px_16px_rgba(0,0,0,0.08)] text-[#0F172A] dark:text-white hover:bg-gray-50 dark:hover:bg-gray-700 transition-all"
          title="Back to Chats"
          aria-label="Go back to Chats"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M12.79 5.23a.75.75 0 0 1-.02 1.06L8.832 10l3.938 3.71a.75.75 0 1 1-1.04 1.08l-4.5-4.25a.75.75 0 0 1 0-1.08l4.5-4.25a.75.75 0 0 1 1.06.02Z" clipRule="evenodd" />
          </svg>
          <span className="font-figtree text-sm font-medium">Chats</span>
        </button>

        {/* Desktop: image + title + status */}
        <div className="hidden md:flex flex-1 min-w-0 items-center gap-3">
          <button
            onClick={() => coverInputRef.current?.click()}
            disabled={uploadingCover}
            title="Change space photo"
            aria-label="Change space photo"
            className="relative shrink-0 w-12 h-12 rounded-[18px] overflow-hidden bg-gray-100 dark:bg-gray-800 group/cover"
          >
            {space?.imageKey ? (
              // eslint-disable-next-line @next/next/no-img-element -- signed-URL redirect
              <img key={coverBust} src={`/api/spaces/${spaceId}/image?v=${coverBust}`} alt="" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full grid place-items-center text-gray-400 dark:text-gray-500 text-xs font-semibold">
                {(space?.name ?? nameHint ?? '?').charAt(0).toUpperCase()}
              </div>
            )}
            <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover/cover:bg-black/40 transition-colors">
              {uploadingCover ? (
                <svg className="animate-spin text-white opacity-0 group-hover/cover:opacity-100" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 12a9 9 0 1 1-2.64-6.36" /></svg>
              ) : (
                <svg className="text-white opacity-0 group-hover/cover:opacity-100 transition-opacity" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" />
                </svg>
              )}
            </div>
          </button>
          <input
            ref={coverInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadCover(f); e.target.value = '' }}
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <h1 className="font-sf font-bold text-gray-900 dark:text-white text-xl tracking-normal truncate leading-tight min-w-0 shrink">
                {space?.name ?? nameHint ?? '…'}
              </h1>
              {space && (
                <div className="relative shrink-0">
                  <button
                    onClick={() => setStatusOpen((o) => !o)}
                    className={`font-sf text-[11px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide transition-opacity hover:opacity-80 ${STATUS_CONFIG[space.status ?? 'on_track'].badge}`}
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
                              className="font-sf w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-900 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/5 transition-colors text-left"
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
            {space?.lastVisit && (
              <p className="font-sf text-xs text-slate-400 dark:text-gray-500 truncate">Updated {formatRelativeTime(space.lastVisit)}</p>
            )}
          </div>
        </div>

        {/* Mobile: spacer or space name when scrolled */}
        <div className="flex-1 md:hidden min-w-0">
          {showHeaderName && (
            <div className="flex items-center gap-2 min-w-0">
              <h1 className="font-sf font-bold text-[15px] text-[#0F172A] dark:text-white truncate leading-tight">
                {space?.name ?? nameHint ?? '…'}
              </h1>
              {space && (
                <span className={`font-sf text-[9px] font-bold px-1 py-0.5 rounded uppercase tracking-wide ${STATUS_CONFIG[space.status ?? 'on_track'].badge}`}>
                  {STATUS_CONFIG[space.status ?? 'on_track'].label}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Desktop: nav pills */}
        <div className="hidden md:flex items-center gap-1 shrink-0">
          <NavBtn label="Chats" active={view === 'chat'} onClick={() => setView('chat')} />
          <NavBtn label="Recents" active={view === 'recents'} onClick={openRecents} />
        </div>
      </motion.header>

      {/* ── Content ── */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto relative">
        <AnimatePresence mode="wait">

          {/* CHAT */}
          {view === 'chat' && (
            <motion.div key="chat" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} className="px-4 py-6 max-w-2xl mx-auto">
              {/* Mobile: space image + title (hidden on desktop, shown in header) */}
              <div ref={mobileHeroRef} className="md:hidden flex flex-col items-center mb-6">
                <button
                  onClick={() => coverInputRef.current?.click()}
                  disabled={uploadingCover}
                  title="Change space photo"
                  aria-label="Change space photo"
                  className="relative shrink-0 w-24 h-24 rounded-[18px] overflow-hidden bg-gray-100 dark:bg-gray-800 group/cover mb-3"
                >
                  {space?.imageKey ? (
                    // eslint-disable-next-line @next/next/no-img-element -- signed-URL redirect
                    <img key={coverBust} src={`/api/spaces/${spaceId}/image?v=${coverBust}`} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full grid place-items-center text-gray-400 dark:text-gray-500 text-2xl font-semibold">
                      {(space?.name ?? nameHint ?? '?').charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover/cover:bg-black/40 transition-colors">
                    {uploadingCover ? (
                      <svg className="animate-spin text-white opacity-0 group-hover/cover:opacity-100" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 12a9 9 0 1 1-2.64-6.36" /></svg>
                    ) : (
                      <svg className="text-white opacity-0 group-hover/cover:opacity-100 transition-opacity" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" />
                      </svg>
                    )}
                  </div>
                </button>
                <h1 className="font-sf font-bold text-[28px] tracking-[0.38px] text-[#0F172A] dark:text-white text-center truncate leading-tight">
                  {space?.name ?? nameHint ?? '…'}
                </h1>
                {space?.lastVisit && (
                  <p className="font-sf text-xs text-[#94A3B8] dark:text-gray-500 mt-1">Updated {formatRelativeTime(space.lastVisit)}</p>
                )}
              </div>
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
                      <motion.div key={msg.id} variants={msgVariants} initial="hidden" animate="show">
                        <ChatMessage message={msg} isStreaming={streamingMessageId === msg.id} onSuggestionClick={(s) => { setInput(s); setTimeout(() => sendMessage(s), 0) }} />
                      </motion.div>
                    ))}
                  </AnimatePresence>
                  {webSearchConfirm && (
                    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-2 px-4 py-2.5 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl text-sm">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-blue-500 shrink-0"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                      <span className="font-sf text-blue-700 dark:text-blue-300">Search the web for more info?</span>
                      <button onClick={() => confirmWebSearch(true)} className="font-sf ml-auto px-3 py-1 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">Search</button>
                      <button onClick={() => confirmWebSearch(false)} className="font-sf px-3 py-1 text-xs font-medium bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors">Skip</button>
                    </motion.div>
                  )}
                  <div ref={bottomRef} />
                </div>
              )}
            </motion.div>
          )}

          {/* DOCUMENTS */}
          {view === 'documents' && (
            <motion.div key="documents" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.2 }} className="px-4 py-6 max-w-2xl mx-auto">
              {docsLoading && <ListSkeleton />}
              {docsLoading ? null : <>

              {/* Header: Search + View Toggle */}
              <div className="mb-4 flex items-center gap-3">
                <div className="relative flex-1">
                  <svg className="absolute left-4 top-1/2 -translate-y-1/2 text-[#94A3B8]" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                  <input
                    type="text"
                    value={docSearch}
                    onChange={e => setDocSearch(e.target.value)}
                    placeholder="Search document"
                    className="font-sf w-full pl-11 pr-4 py-3 text-base bg-white dark:bg-gray-900 border border-[rgba(26,26,26,0.20)] dark:border-gray-700 rounded-full outline-none focus:border-gray-400 dark:focus:border-gray-600 text-[#0F172A] dark:text-white placeholder:text-[#94A3B8] dark:placeholder:text-gray-600 shadow-[0_4px_16px_rgba(0,0,0,0.08)]"
                  />
                  {docSearch && (
                    <button onClick={() => setDocSearch('')} aria-label="Clear search" className="absolute right-4 top-1/2 -translate-y-1/2 text-[#94A3B8] hover:text-gray-600">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  )}
                </div>
                {/* View toggle pill */}
                <div className="flex items-center gap-1 p-1 bg-white dark:bg-gray-900 border border-[rgba(26,26,26,0.20)] dark:border-gray-700 rounded-full shadow-[0_4px_16px_rgba(0,0,0,0.08)]">
                  <button
                    onClick={() => setDocViewMode('list')}
                    className={`w-11 h-11 flex items-center justify-center rounded-full transition-colors ${docViewMode === 'list' ? 'bg-[#0F172A] dark:bg-white text-white dark:text-[#0F172A]' : 'bg-[#F1F5F9] dark:bg-gray-800 text-[#0F172A] dark:text-white'}`}
                    title="List view"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
                      <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
                    </svg>
                  </button>
                  <button
                    onClick={() => setDocViewMode('grid')}
                    className={`w-11 h-11 flex items-center justify-center rounded-full transition-colors ${docViewMode === 'grid' ? 'bg-[#0F172A] dark:bg-white text-white dark:text-[#0F172A]' : 'bg-[#F1F5F9] dark:bg-gray-800 text-[#0F172A] dark:text-white'}`}
                    title="Grid view"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
                      <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
                    </svg>
                  </button>
                </div>
              </div>

              {/* Filter type pills */}
              <div className="mb-4 flex gap-1.5 flex-wrap">
                {(['all', 'pdf', 'docx', 'xlsx', 'csv', 'text'] as const).map(type => (
                  <button
                    key={type}
                    onClick={() => setDocTypeFilter(type)}
                    className={`font-sf px-4 py-2 text-base rounded-full transition-colors ${
                      docTypeFilter === type
                        ? 'bg-[#0F172A] dark:bg-white text-white dark:text-[#0F172A]'
                        : 'bg-white dark:bg-gray-900 border border-[rgba(26,26,26,0.20)] dark:border-gray-700 text-[#64748B] dark:text-gray-400 hover:border-gray-300 dark:hover:border-gray-600 shadow-[0_4px_16px_rgba(0,0,0,0.04)]'
                    }`}
                  >
                    {type === 'all' ? 'All' : type.toUpperCase()}
                  </button>
                ))}
              </div>

              {/* Tab toggle for upload/text — only when no docs or upload mode */}
              {docs.length === 0 && (
                <div className="flex gap-1 p-1 bg-[#F1F5F9] dark:bg-gray-800/60 rounded-xl mb-4">
                  {(['upload', 'text'] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setDocInputMode(mode)}
                      className={`font-sf flex-1 py-2 text-xs font-medium rounded-lg transition-colors ${
                        docInputMode === mode
                          ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                          : 'text-gray-900 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                      }`}
                    >
                      {mode === 'upload' ? 'Upload file' : 'Minutes of Meeting'}
                    </button>
                  ))}
                </div>
              )}

              <AnimatePresence mode="wait">
                {docInputMode === 'upload' ? (
                  <motion.div key="upload-area" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
                    {/* Drop zone */}
                    <motion.div
                      onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length > 0) stageFiles(e.dataTransfer.files) }}
                      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                      onDragLeave={() => setDragOver(false)}
                      onClick={() => fileInputRef.current?.click()}
                      className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all mb-4 ${
                        dragOver
                          ? 'border-gray-400 dark:border-gray-500 bg-gray-50 dark:bg-gray-800/50 scale-[1.01]'
                          : 'border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700 hover:bg-gray-50/50 dark:hover:bg-gray-900/50'
                      }`}
                    >
                      <div className="text-3xl mb-3">📎</div>
                      <p className="font-sf text-sm font-medium text-gray-900 dark:text-gray-300">Drop files or click to upload</p>
                      <p className="font-sf text-xs text-gray-900 dark:text-gray-500 mt-1">PDF · Word · Excel · CSV · up to 500MB each</p>
                    </motion.div>
                    <input ref={fileInputRef} type="file" multiple accept=".pdf,.docx,.doc,.xlsx,.xls,.csv,.pptx,.ppt,.txt,.jpg,.jpeg,.png,.webp,.zip,.eml,.msg,.dwg,.dxf,.skp" className="hidden"
                      onChange={(e) => { if (e.target.files && e.target.files.length > 0) stageFiles(e.target.files); e.target.value = '' }} />

                    {/* Upload queue */}
                    <AnimatePresence>
                      {pendingUploads.length > 0 && (
                        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} className="space-y-2 mb-4">
                          {pendingUploads.map((item) => (
                            <div key={item.id} className="flex items-center gap-3 p-3 border border-gray-200 dark:border-gray-700 rounded-2xl bg-gray-50 dark:bg-gray-900">
                              <span className="text-xl shrink-0">{FILE_ICONS[item.file.name.split('.').pop()?.toLowerCase() ?? ''] ?? '📄'}</span>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1 group/title">
                                  <input
                                    type="text"
                                    value={item.title}
                                    onChange={(e) => setPendingUploads((prev) => prev.map((p) => p.id === item.id ? { ...p, title: e.target.value } : p))}
                                    disabled={item.status === 'uploading' || item.status === 'done'}
                                    placeholder="Document title"
                                    className="flex-1 min-w-0 text-sm font-medium text-gray-900 dark:text-white bg-transparent outline-none border-b border-gray-200 dark:border-gray-700 focus:border-gray-400 dark:focus:border-gray-500 transition-colors pb-0.5 disabled:opacity-60"
                                  />
                                  {item.status === 'queued' && (
                                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-gray-400 dark:text-gray-600 group-focus-within/title:text-gray-500 transition-colors">
                                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                                    </svg>
                                  )}
                                </div>
                                <div className="flex items-center gap-1 group/desc mt-1">
                                  <input
                                    type="text"
                                    value={item.description}
                                    onChange={(e) => setPendingUploads((prev) => prev.map((p) => p.id === item.id ? { ...p, description: e.target.value } : p))}
                                    disabled={item.status === 'uploading' || item.status === 'done'}
                                    placeholder="Add a description (optional)"
                                    className="flex-1 min-w-0 text-xs text-gray-500 dark:text-gray-400 bg-transparent outline-none border-b border-gray-100 dark:border-gray-800 focus:border-gray-300 dark:focus:border-gray-600 transition-colors pb-0.5 disabled:opacity-60 placeholder:text-gray-400 dark:placeholder:text-gray-600"
                                  />
                                  {item.status === 'queued' && (
                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-gray-300 dark:text-gray-700 group-focus-within/desc:text-gray-400 transition-colors">
                                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                                    </svg>
                                  )}
                                </div>
                                <p className="font-sf text-xs text-gray-400 dark:text-gray-600 mt-1">{fmt(item.file.size)}</p>
                                {item.status === 'uploading' && (
                                  <div className="mt-1.5 h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                                    <motion.div className="h-full bg-gray-900 dark:bg-gray-300 rounded-full" animate={{ width: `${item.progress}%` }} transition={{ duration: 0.3 }} />
                                  </div>
                                )}
                                {item.status === 'error' && (
                                  <p className="font-sf text-xs text-red-400 mt-0.5">{item.error}</p>
                                )}
                              </div>
                              <div className="shrink-0">
                                {item.status === 'done' && <span className="text-emerald-500 text-sm">✓</span>}
                                {item.status === 'uploading' && (
                                  <motion.span animate={{ opacity: [1, 0.4, 1] }} transition={{ repeat: Infinity, duration: 1 }} className="font-sf text-xs text-amber-500">{item.progress}%</motion.span>
                                )}
                                {(item.status === 'queued' || item.status === 'error') && !uploadingAll && (
                                  <button
                                    onClick={() => setPendingUploads((prev) => prev.filter((p) => p.id !== item.id))}
                                    className="p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                                  >
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M18 6L6 18M6 6l12 12"/></svg>
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}

                          {/* Upload all / clear done */}
                          {(() => {
                            const queued = pendingUploads.filter((p) => p.status === 'queued' || p.status === 'error')
                            const allDone = pendingUploads.every((p) => p.status === 'done')
                            if (allDone) return null
                            return (
                              <div className="flex gap-2 pt-1">
                                {!uploadingAll && (
                                  <button
                                    onClick={() => setPendingUploads([])}
                                    className="font-sf flex-1 py-2.5 text-sm font-medium text-gray-900 dark:text-gray-400 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                                  >
                                    Clear
                                  </button>
                                )}
                                <motion.button
                                  whileTap={{ scale: 0.97 }}
                                  onClick={uploadAll}
                                  disabled={uploadingAll || queued.length === 0}
                                  className="font-sf flex-1 py-2.5 text-sm font-medium bg-gray-900 dark:bg-gray-700 text-white rounded-xl disabled:opacity-40 hover:bg-gray-700 dark:hover:bg-gray-600 transition-colors"
                                >
                                  {uploadingAll ? 'Uploading…' : queued.length === 1 ? 'Upload & process' : `Upload ${queued.length} files`}
                                </motion.button>
                              </div>
                            )
                          })()}
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
                      className="font-sf w-full px-3.5 py-3 text-base text-gray-900 dark:text-white bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl outline-none focus:border-gray-300 dark:focus:border-gray-600 transition-colors placeholder:text-gray-400 dark:placeholder:text-gray-600"
                    />
                    <textarea
                      value={pasteContent}
                      onChange={(e) => setPasteContent(e.target.value)}
                      placeholder="Paste minutes of meeting, notes, decisions, ideas… Memory will extract insights automatically."
                      rows={8}
                      className="font-sf w-full px-3.5 py-3 text-base text-gray-900 dark:text-white bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl outline-none focus:border-gray-300 dark:focus:border-gray-600 transition-colors placeholder:text-gray-400 dark:placeholder:text-gray-600 resize-none"
                    />
                    <motion.button
                      whileTap={{ scale: 0.97 }}
                      onClick={pasteText}
                      disabled={pasting || !pasteTitle.trim() || !pasteContent.trim()}
                      className="font-sf w-full py-3 text-sm font-medium bg-gray-900 dark:bg-gray-700 text-white rounded-xl hover:bg-gray-700 dark:hover:bg-gray-600 disabled:opacity-40 transition-colors"
                    >
                      {pasting ? 'Adding to Memory…' : 'Add to Memory'}
                    </motion.button>
                  </motion.div>
                )}
              </AnimatePresence>

              {docs.length === 0 ? (
                <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="font-sf text-sm text-gray-900 dark:text-gray-400 text-center py-10">
                  No documents yet. Upload one to get started.
                </motion.p>
              ) : (
                <>
                  {docViewMode === 'list' ? (
                    /* ── LIST VIEW ── */
                    <motion.div initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.06 } } }} className="space-y-4">
                      {docs.filter(doc => {
                        const matchesSearch = docSearch === '' || doc.name.toLowerCase().includes(docSearch.toLowerCase())
                        const matchesType = docTypeFilter === 'all' || doc.fileType === docTypeFilter
                        return matchesSearch && matchesType
                      }).map((doc, i) => {
                        const isReady = doc.status === 'ready'
                        return (
                          <motion.div key={doc.id} custom={i} variants={cardVariants}
                            className="bg-white/70 dark:bg-gray-900/70 border border-white dark:border-gray-800 shadow-[0_4px_16px_rgba(0,0,0,0.08)] dark:shadow-[0_4px_16px_rgba(0,0,0,0.3)] rounded-2xl flex items-start gap-3 cursor-pointer hover:bg-white dark:hover:bg-gray-900 transition-colors"
                            onClick={() => { if (isReady) setDocSheet(doc) }}
                          >
                            {/* Left icon area */}
                            <div className="shrink-0 w-[72px] h-[72px] flex items-center justify-center bg-[#F1F5F9] dark:bg-gray-800 rounded-l-2xl">
                              <div className="w-9 h-9 flex items-center justify-center bg-white dark:bg-gray-700 rounded-lg">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                                </svg>
                              </div>
                            </div>
                            {/* Right content */}
                            <div className="flex-1 min-w-0 py-3 pr-3">
                              <p className="font-sf text-[15px] font-semibold text-[#0F172A] dark:text-white truncate leading-[20px] tracking-[-0.23px]">{doc.name}</p>
                              <div className="flex items-center gap-1 mt-1">
                                <span className="font-sf text-xs text-[#94A3B8]">{doc.fileType.toUpperCase()}</span>
                                <span className="font-sf text-xs text-[#94A3B8]">·</span>
                                <span className="font-sf text-xs text-[#94A3B8]">{fmt(doc.fileSize)}</span>
                              </div>
                            </div>
                            {/* Ellipsis */}
                            <button
                              onClick={(e) => { e.stopPropagation(); setDocSheet(doc) }}
                              className="shrink-0 w-5 h-5 flex items-center justify-center bg-[#F1F5F9] dark:bg-gray-800 rounded-lg mt-3 mr-3 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                              title="More options"
                              aria-label="More options"
                            >
                              <svg width="1.25" height="11.25" viewBox="0 0 3 12" fill="#0F172A" className="dark:fill-white">
                                <circle cx="1.5" cy="1.5" r="1.5"/><circle cx="1.5" cy="6" r="1.5"/><circle cx="1.5" cy="10.5" r="1.5"/>
                              </svg>
                            </button>
                          </motion.div>
                        )
                      })}
                    </motion.div>
                  ) : (
                    /* ── GRID VIEW ── */
                    <motion.div initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.06 } } }} className="grid grid-cols-2 gap-4">
                      {docs.filter(doc => {
                        const matchesSearch = docSearch === '' || doc.name.toLowerCase().includes(docSearch.toLowerCase())
                        const matchesType = docTypeFilter === 'all' || doc.fileType === docTypeFilter
                        return matchesSearch && matchesType
                      }).map((doc, i) => {
                        const isReady = doc.status === 'ready'
                        return (
                          <motion.div key={doc.id} custom={i} variants={cardVariants}
                            className="bg-white dark:bg-gray-900 border border-white dark:border-gray-800 shadow-[0_4px_16px_rgba(0,0,0,0.08)] dark:shadow-[0_4px_16px_rgba(0,0,0,0.3)] rounded-2xl overflow-hidden cursor-pointer hover:shadow-[0_6px_20px_rgba(0,0,0,0.12)] dark:hover:shadow-[0_6px_20px_rgba(0,0,0,0.4)] transition-shadow"
                            onClick={() => { if (isReady) setDocSheet(doc) }}
                          >
                            {/* Top section — colored bg */}
                            <div className="h-24 flex items-end p-4 bg-gradient-to-br from-[#F8FAFC] to-[#D0DCE8]/24">
                              <div className="w-9 h-9 flex items-center justify-center bg-[#F1F5F9] dark:bg-gray-800 rounded-lg">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                                </svg>
                              </div>
                            </div>
                            {/* Bottom section — white */}
                            <div className="p-4">
                              <p className="font-sf text-[15px] font-semibold text-[#0F172A] dark:text-white truncate leading-[20px] tracking-[-0.23px]">{doc.name}</p>
                              <div className="flex items-center justify-between mt-2">
                                <div className="flex items-center gap-1">
                                  <span className="font-sf text-xs text-[#94A3B8]">{doc.fileType.toUpperCase()}</span>
                                  <span className="font-sf text-xs text-[#94A3B8]">·</span>
                                  <span className="font-sf text-xs text-[#94A3B8]">{fmt(doc.fileSize)}</span>
                                </div>
                                <button
                                  onClick={(e) => { e.stopPropagation(); setDocSheet(doc) }}
                                  className="w-5 h-5 flex items-center justify-center bg-[#F1F5F9] dark:bg-gray-800 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                                  title="More options"
                                  aria-label="More options"
                                >
                                  <svg width="1.25" height="11.25" viewBox="0 0 3 12" fill="#0F172A" className="dark:fill-white">
                                    <circle cx="1.5" cy="1.5" r="1.5"/><circle cx="1.5" cy="6" r="1.5"/><circle cx="1.5" cy="10.5" r="1.5"/>
                                  </svg>
                                </button>
                              </div>
                            </div>
                          </motion.div>
                        )
                      })}
                    </motion.div>
                  )}
                  {docs.filter(doc => (docSearch === '' || doc.name.toLowerCase().includes(docSearch.toLowerCase())) && (docTypeFilter === 'all' || doc.fileType === docTypeFilter)).length === 0 && (
                    <p className="font-sf text-sm text-gray-400 dark:text-gray-600 text-center py-8">No documents match your filter.</p>
                  )}
                </>
              )}
              </>}
            </motion.div>
          )}

          {/* TIMELINE */}
          {view === 'timeline' && (
            <motion.div key="timeline" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.2 }} className="px-4 py-6 max-w-2xl mx-auto">
              {timelineLoading ? <ListSkeleton /> : timeline.length === 0 ? (
                <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="font-sf text-sm text-gray-900 dark:text-gray-400 text-center py-10">
                  No events yet. Upload documents to start your timeline.
                </motion.p>
              ) : (() => {
                // Group events by date
                const groups: { label: string; events: typeof timeline }[] = []
                let lastDate = ''
                for (const ev of timeline) {
                  const d = new Date(ev.date)
                  const today = new Date()
                  const yesterday = new Date(today)
                  yesterday.setDate(yesterday.getDate() - 1)
                  let label: string
                  if (d.toDateString() === today.toDateString()) {
                    label = 'Today'
                  } else if (d.toDateString() === yesterday.toDateString()) {
                    label = 'Yesterday'
                  } else {
                    label = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
                  }
                  if (label !== lastDate) {
                    groups.push({ label, events: [] })
                    lastDate = label
                  }
                  groups[groups.length - 1].events.push(ev)
                }
                return (
                  <div className="space-y-6">
                    {groups.map((group, gi) => (
                      <div key={group.label}>
                        {/* Day header */}
                        <div className="flex items-center gap-3 mb-4">
                          <h3 className="font-figtree font-semibold text-base text-[#0F172A] dark:text-white leading-[22px] tracking-[-0.18px]">{group.label}</h3>
                          <div className="flex-1 h-px bg-[#E2E8F0] dark:bg-gray-800" />
                        </div>
                        {/* Timeline events */}
                        <div className="relative pl-8">
                          <div className="absolute left-[11px] top-2 bottom-2 w-px bg-[#E2E8F0] dark:bg-gray-800" />
                          <motion.div initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.04 } } }} className="space-y-4">
                            {(() => {
                              // Sub-group consecutive events by source document — a single upload can
                              // yield dozens of extracted facts (key numbers especially), which would
                              // otherwise flood one date with a huge unbroken card stack.
                              const subGroups: { sourceName: string; events: typeof group.events }[] = []
                              for (const ev of group.events) {
                                const last = subGroups[subGroups.length - 1]
                                if (last && last.sourceName === ev.sourceName) last.events.push(ev)
                                else subGroups.push({ sourceName: ev.sourceName, events: [ev] })
                              }
                              const VISIBLE_CAP = 4
                              let idx = 0
                              return subGroups.map((sub, si) => {
                                const key = `${group.label}__${sub.sourceName}__${si}`
                                const expanded = !!expandedTimelineGroups[key]
                                const visibleEvents = expanded ? sub.events : sub.events.slice(0, VISIBLE_CAP)
                                const hiddenCount = sub.events.length - visibleEvents.length
                                return (
                                  <div key={key} className="space-y-4">
                                    {visibleEvents.map((ev) => {
                                      const cfg = TIMELINE_EVENT_CONFIG[ev.type]
                                      const i = idx++
                                      return (
                                        <motion.div key={ev.id} custom={i} variants={cardVariants} className="relative">
                                          {/* Icon circle */}
                                          <motion.div
                                            initial={{ scale: 0 }} animate={{ scale: 1 }}
                                            transition={{ delay: i * 0.04 + 0.08, type: 'spring', stiffness: 500, damping: 28 }}
                                            className={`absolute -left-8 top-2 w-8 h-8 rounded-full flex items-center justify-center z-10 ${cfg.dot} border-2 border-white dark:border-[#0f0f0f]`}
                                          >
                                            <span className={`text-[11px] leading-none ${cfg.iconColor}`}>{cfg.icon}</span>
                                          </motion.div>

                                          {/* Card */}
                                          <div className="bg-white dark:bg-gray-900 border border-white dark:border-gray-800 shadow-[0_4px_16px_rgba(0,0,0,0.08)] dark:shadow-[0_4px_16px_rgba(0,0,0,0.3)] rounded-2xl p-4">
                                            <div className="flex justify-between gap-3">
                                              <div className="flex-1 min-w-0">
                                                {/* Type badge + source */}
                                                <div className="flex items-center gap-2 mb-1">
                                                  <span className={`font-sf inline-block text-xs font-bold px-2 py-0.5 rounded-md uppercase tracking-wide ${cfg.badge}`}>
                                                    {cfg.label}
                                                  </span>
                                                  <span className="font-sf text-xs text-[#94A3B8] truncate">{ev.sourceName}</span>
                                                </div>
                                                {/* Main text */}
                                                <p className={`font-sf text-[13px] leading-[18px] ${ev.type === 'document' ? 'text-[#64748B] dark:text-gray-400 italic' : 'text-[#0F172A] dark:text-gray-200'}`}>
                                                  {ev.text}
                                                </p>
                                              </div>
                                              <span className="font-sf text-xs text-[#94A3B8] shrink-0 pt-0.5 whitespace-nowrap">
                                                {formatDateTime(ev.date)}
                                              </span>
                                            </div>
                                          </div>
                                        </motion.div>
                                      )
                                    })}
                                    {hiddenCount > 0 && (
                                      <div className="relative">
                                        <div className="absolute -left-8 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full flex items-center justify-center bg-[#F1F5F9] dark:bg-gray-800 border-2 border-white dark:border-[#0f0f0f]">
                                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
                                        </div>
                                        <button
                                          onClick={() => setExpandedTimelineGroups((p) => ({ ...p, [key]: true }))}
                                          className="font-sf text-xs font-medium text-[#64748B] dark:text-gray-400 hover:text-[#0F172A] dark:hover:text-white py-1.5 transition-colors"
                                        >
                                          Show {hiddenCount} more from {sub.sourceName}
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                )
                              })
                            })()}
                          </motion.div>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              })()}
            </motion.div>
          )}

          {/* RECENTS — recently added documents, sorted newest first */}
          {view === 'recents' && (
            <motion.div key="recents" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.2 }} className="px-4 py-6 max-w-2xl mx-auto">
              {docsLoading ? <ListSkeleton /> : docs.length === 0 ? (
                <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="font-sf text-sm text-gray-900 dark:text-gray-400 text-center py-10">
                  No documents yet. Upload one to get started.
                </motion.p>
              ) : (
                <motion.div initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.06 } } }} className="space-y-4">
                  {[...docs]
                    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
                    .slice(0, 15)
                    .map((doc, i) => {
                      const isReady = doc.status === 'ready'
                      return (
                        <motion.div key={doc.id} custom={i} variants={cardVariants}
                          className="bg-white/70 dark:bg-gray-900/70 border border-white dark:border-gray-800 shadow-[0_4px_16px_rgba(0,0,0,0.08)] dark:shadow-[0_4px_16px_rgba(0,0,0,0.3)] rounded-2xl flex items-start gap-3 cursor-pointer hover:bg-white dark:hover:bg-gray-900 transition-colors"
                          onClick={() => { if (isReady) setDocSheet(doc) }}
                        >
                          {/* Left icon area */}
                          <div className="shrink-0 w-[72px] h-[72px] flex items-center justify-center bg-[#F1F5F9] dark:bg-gray-800 rounded-l-2xl">
                            <div className="w-9 h-9 flex items-center justify-center bg-white dark:bg-gray-700 rounded-lg">
                              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                              </svg>
                            </div>
                          </div>
                          {/* Right content */}
                          <div className="flex-1 min-w-0 py-3 pr-3">
                            <p className="font-sf text-[15px] font-semibold text-[#0F172A] dark:text-white truncate leading-[20px] tracking-[-0.23px]">{doc.name}</p>
                            <div className="flex items-center gap-1 mt-1">
                              <span className="font-sf text-xs text-[#94A3B8]">{doc.fileType.toUpperCase()}</span>
                              <span className="font-sf text-xs text-[#94A3B8]">·</span>
                              <span className="font-sf text-xs text-[#94A3B8]">Added {formatRelativeTime(doc.createdAt)}</span>
                            </div>
                          </div>
                        </motion.div>
                      )
                    })}
                </motion.div>
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
                aria-label="Scroll to bottom"
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
          className="border-t border-gray-100 dark:border-gray-800 shrink-0 bg-[#F1F5F9]/80 dark:bg-[#0f0f0f]/80 backdrop-blur-[24px]"
        >
          <div className="w-full max-w-2xl mx-auto px-4 pt-3" style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}>
            {!isEmpty && (
              <div className="flex gap-2 mb-3 overflow-x-auto scrollbar-hide pb-0.5">
                {[
                  { icon: 'doc', label: 'Brief me', action: () => aiAction('Brief me on this space.', '/api/brief') },
                  { icon: 'clock', label: 'Catch me up', action: () => aiAction('What changed since my last visit?', '/api/catch-up') },
                  { icon: 'list', label: 'Timeline', action: openTimeline },
                  { icon: 'folder', label: 'Documents', action: openDocuments },
                ].map(({ icon, label, action }) => (
                  <motion.button key={label} whileTap={{ scale: 0.94 }} onClick={action}
                    disabled={loading}
                    className="font-sf shrink-0 flex items-center gap-1.5 px-4 py-3 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 border border-gray-100 dark:border-transparent rounded-full shadow-[0_4px_16px_rgba(0,0,0,0.08)] transition-colors whitespace-nowrap disabled:opacity-40">
                    <span className="w-5 h-5 flex items-center justify-center text-[#0F172A] dark:text-white shrink-0">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
                        {icon === 'doc' && <path d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />}
                        {icon === 'clock' && <path d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />}
                        {icon === 'list' && <path d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0ZM3.75 12h.007v.008H3.75V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm-.375 5.25h.007v.008H3.75v-.008Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />}
                        {icon === 'folder' && <path d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />}
                      </svg>
                    </span>
                    <span className="flex flex-col items-start leading-tight">
                      <span className="text-[13px] font-medium text-[#0F172A] dark:text-white">{label}</span>
                      {space?.lastVisit && (
                        <span className="text-[11px] text-[#64748B] dark:text-gray-500">Updated {formatRelativeTime(space.lastVisit)}</span>
                      )}
                    </span>
                  </motion.button>
                ))}
              </div>
            )}

            {/* @ mention chips — current-space docs show "@DocName"; other-project refs show
                "@ProjectName:DocName", or just "@ProjectName" when the whole project was picked */}
            {mentionChips.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {mentionChips.map((chip, i) => {
                  const isCurrentSpace = chip.spaceId === spaceId
                  const label = isCurrentSpace
                    ? `@${chip.docName}`
                    : `@${chip.spaceName}${chip.docName ? `:${chip.docName}` : ''}`
                  return (
                    <span key={i} className="font-sf inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 rounded-full border border-blue-200 dark:border-blue-800">
                      <span>{label}</span>
                      <button onClick={() => setMentionChips((p) => p.filter((_, j) => j !== i))} aria-label="Remove reference" className="ml-0.5 opacity-60 hover:opacity-100 transition-opacity">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M18 6L6 18M6 6l12 12"/></svg>
                      </button>
                    </span>
                  )
                })}
              </div>
            )}

            {/* Space switch suggestion */}
            <AnimatePresence>
              {spaceSuggestion && (
                <motion.div
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 4 }}
                  transition={{ duration: 0.15 }}
                  className="mb-2 flex items-center gap-2"
                >
                  <span className="font-sf text-xs text-gray-400 dark:text-gray-500">Switch to:</span>
                  <button
                    type="button"
                    onClick={() => router.push(`/spaces/${spaceSuggestion.id}`)}
                    className="font-sf text-xs px-3 py-1 rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors font-medium"
                  >
                    {spaceSuggestion.name} →
                  </button>
                  <button
                    type="button"
                    onClick={() => setSpaceSuggestion(null)}
                    aria-label="Dismiss suggestion"
                    className="text-xs text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400 transition-colors"
                  >✕</button>
                </motion.div>
              )}
            </AnimatePresence>

            {/* @ mention dropdown */}
            <div className="relative">
              <AnimatePresence>
                {mentionQuery !== null && (
                  <motion.div
                    ref={mentionRef}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 4 }}
                    transition={{ duration: 0.12 }}
                    className="absolute bottom-full left-0 mb-2 w-full max-w-sm bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl shadow-lg overflow-hidden z-50"
                  >
                    {mentionStage === 'doc' && mentionSpaceCtx && (
                      <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-800 flex items-center gap-2">
                        <span className="font-sf text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-600">
                          {mentionSpaceCtx.name} › Select document
                        </span>
                        <button
                          type="button"
                          onMouseDown={(e) => { e.preventDefault(); setMentionStage('space'); setMentionSpaceCtx(null); setMentionQuery(''); setMentionActiveIdx(0) }}
                          className="font-sf ml-auto text-[11px] text-blue-500 hover:text-blue-600"
                        >← back</button>
                      </div>
                    )}
                    {(() => {
                      const items = getMentionItems()
                      if (items.length === 0) return (
                        <div className="font-sf px-4 py-3 text-xs text-gray-400 dark:text-gray-600">
                          {mentionStage === 'doc' ? 'No documents found' : 'No matches found'}
                        </div>
                      )
                      return items.slice(0, 8).map((item, idx) => (
                        <button
                          key={`${item.kind}-${item.id}`}
                          type="button"
                          onMouseEnter={() => setMentionActiveIdx(idx)}
                          onMouseDown={(e) => { e.preventDefault(); selectMentionItem(item) }}
                          className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${idx === mentionActiveIdx ? 'bg-gray-100 dark:bg-gray-800' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'}`}
                        >
                          <span className="text-base shrink-0">
                            {item.kind === 'doc' ? item.icon : item.kind === 'allspace' ? '🗂️' : '📁'}
                          </span>
                          <span className={`font-sf text-sm truncate ${item.kind === 'allspace' ? 'text-gray-500 dark:text-gray-400 italic' : 'text-gray-900 dark:text-white'}`}>
                            {item.label}
                          </span>
                          {item.kind === 'otherspace' && (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="ml-auto shrink-0 text-gray-400"><path d="M9 18l6-6-6-6"/></svg>
                          )}
                        </button>
                      ))
                    })()}
                  </motion.div>
                )}
              </AnimatePresence>

              {speech.listening && (
                <div className="font-sf flex items-center gap-2 mb-2 px-3 py-1.5 rounded-xl bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-xs w-fit">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
                  </span>
                  Recording…
                  <button type="button" onClick={speech.stop} className="font-sf ml-1 underline">Done</button>
                  <button type="button" onClick={speech.cancel} className="font-sf underline">Cancel</button>
                </div>
              )}
              {speech.transcribing && (
                <div className="font-sf flex items-center gap-2 mb-2 px-3 py-1.5 rounded-xl bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 text-xs w-fit">
                  Transcribing…
                </div>
              )}
              {speech.error && (
                <div className="font-sf mb-2 px-3 py-1.5 rounded-xl bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-xs w-fit">
                  {speech.error}
                </div>
              )}

              <form
                onSubmit={(e) => { e.preventDefault(); sendMessage(input) }}
                className="bg-white dark:bg-gray-900 border border-[rgba(26,26,26,0.20)] dark:border-gray-700 rounded-[28px] px-4 py-3 focus-within:border-gray-400 dark:focus-within:border-gray-600 focus-within:bg-white dark:focus-within:bg-gray-800 transition-all shadow-[0_4px_16px_rgba(0,0,0,0.08)]"
              >
                <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => { setInput((v) => v + '@'); inputRef.current?.focus(); setMentionStage('space'); setMentionSpaceCtx(null); setMentionQuery('') }}
                  disabled={loading || (readyDocs.length === 0 && otherSpaces.length === 0)}
                  title="Reference a document or project"
                  aria-label="Mention a project or document"
                  className="font-sf md:hidden shrink-0 h-8 w-8 flex items-center justify-center text-gray-500 dark:text-gray-500 hover:text-blue-500 dark:hover:text-blue-400 rounded-lg transition-colors disabled:opacity-30 text-base font-semibold"
                >@</button>
                <button
                  type="button"
                  onClick={speech.toggle}
                  disabled={loading || !speech.supported || speech.transcribing}
                  title={!speech.supported ? "Voice input isn't supported in this browser" : speech.listening ? 'Stop recording' : 'Speak your question'}
                  aria-label="Voice input"
                  className={`shrink-0 h-8 w-8 flex items-center justify-center rounded-lg transition-colors disabled:opacity-30 ${
                    speech.listening ? 'text-red-500' : 'text-gray-500 dark:text-gray-500 hover:text-blue-500 dark:hover:text-blue-400'
                  }`}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
                      setMentionQuery(val.slice(atIdx + 1)); setMentionActiveIdx(0)
                    } else {
                      setMentionQuery(null)
                    }
                    // Detect space name mentions for switch suggestion
                    const lv = val.toLowerCase()
                    const matched = otherSpaces.find((s) => lv.includes(s.name.toLowerCase()) && s.name.length >= 3) ?? null
                    setSpaceSuggestion(matched)
                    spaceSuggestionRef.current = matched
                  }}
                  onKeyDown={(e) => {
                    if (mentionQuery !== null) {
                      const items = getMentionItems().slice(0, 8)
                      if (e.key === 'ArrowDown') {
                        e.preventDefault()
                        setMentionActiveIdx((i) => Math.min(i + 1, items.length - 1))
                        return
                      }
                      if (e.key === 'ArrowUp') {
                        e.preventDefault()
                        setMentionActiveIdx((i) => Math.max(i - 1, 0))
                        return
                      }
                      if (e.key === 'Enter' && items.length > 0) {
                        e.preventDefault()
                        selectMentionItem(items[mentionActiveIdx] ?? items[0])
                        return
                      }
                      if (e.key === 'Escape') { setMentionQuery(null); setMentionStage('space'); setMentionSpaceCtx(null); return }
                    }
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input) }
                  }}
                  placeholder={(readyDocs.length > 0 || otherSpaces.length > 0) ? 'Ask memory… or @ a doc' : 'Ask memory…'}
                  className="flex-1 min-w-0 text-base text-gray-900 dark:text-white bg-transparent outline-none resize-none placeholder:text-[#94A3B8] dark:placeholder:text-gray-600 min-h-[28px] max-h-[120px] overflow-y-auto leading-relaxed"
                />
                {/* Desktop: all controls inline */}
                <div className="hidden md:flex shrink-0 items-center gap-1.5">
                  <ModelSelector value={provider} onChange={setProvider} />
                  <StyleToggle value={responseStyle} onChange={setResponseStyle} />
                  {streamingMessageId ? (
                    <motion.button
                      whileTap={{ scale: 0.92 }}
                      type="button"
                      onClick={() => { abortRef.current?.abort(); setStreamingMessageId(null); setLoading(false); setTimeout(() => inputRef.current?.focus(), 100) }}
                      className="h-8 w-8 flex items-center justify-center bg-red-500 hover:bg-red-600 text-white rounded-xl transition-colors"
                      title="Stop generating"
                      aria-label="Stop generating"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
                    </motion.button>
                  ) : (
                    <motion.button
                      whileTap={{ scale: 0.92 }}
                      type="submit" disabled={loading || !input.trim()}
                      className="h-8 w-8 sm:h-auto sm:w-auto sm:px-4 sm:py-1.5 flex items-center justify-center gap-1.5 bg-gray-900 dark:bg-gray-700 text-white rounded-xl hover:bg-gray-700 dark:hover:bg-gray-600 disabled:opacity-30 transition-colors"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                      </svg>
                      <span className="font-sf hidden sm:inline text-xs font-medium">Send</span>
                    </motion.button>
                  )}
                </div>
                {/* Mobile: just submit button */}
                <div className="md:hidden shrink-0">
                  {streamingMessageId ? (
                    <motion.button
                      whileTap={{ scale: 0.92 }}
                      type="button"
                      onClick={() => { abortRef.current?.abort(); setStreamingMessageId(null); setLoading(false); setTimeout(() => inputRef.current?.focus(), 100) }}
                      className="h-8 w-8 flex items-center justify-center bg-red-500 hover:bg-red-600 text-white rounded-xl transition-colors"
                      title="Stop generating"
                      aria-label="Stop generating"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2" /></svg>
                    </motion.button>
                  ) : (
                    <motion.button
                      whileTap={{ scale: 0.92 }}
                      type="submit" disabled={loading || !input.trim()}
                      aria-label="Send message"
                      className="h-8 w-8 flex items-center justify-center bg-gray-900 dark:bg-gray-700 text-white rounded-xl hover:bg-gray-700 dark:hover:bg-gray-600 disabled:opacity-30 transition-colors"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                      </svg>
                    </motion.button>
                  )}
                </div>
                </div>
                {/* Mobile: model & style selectors below textarea */}
                <div className="flex md:hidden items-center gap-2 pt-2 mt-2 border-t border-gray-200 dark:border-gray-800">
                  <ModelSelector value={provider} onChange={setProvider} />
                  <StyleToggle value={responseStyle} onChange={setResponseStyle} />
                </div>
              </form>
            </div>
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
        className="font-sf flex items-center gap-1 h-8 px-2.5 text-[11px] font-medium rounded-xl bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white capitalize transition-colors hover:bg-gray-200 dark:hover:bg-gray-700"
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
                className={`font-sf w-full text-left px-3 py-2 text-xs font-medium capitalize transition-colors ${
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

function ModelSelector({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open])

  const selectedModel = LLM_MODELS.find(m => m.id === value)
  const displayName = selectedModel?.name ?? value.split('/').pop() ?? value

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="font-sf flex items-center gap-1 h-8 px-2.5 text-[11px] font-medium rounded-xl bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white transition-colors hover:bg-gray-200 dark:hover:bg-gray-700"
      >
        <span className="font-sf truncate max-w-[80px]">{displayName}</span>
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
            className="absolute bottom-full left-0 mb-1.5 w-48 bg-white dark:bg-[#1c1c1c] border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg overflow-hidden z-20"
          >
            {LLM_MODELS.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => { onChange(m.id); setOpen(false) }}
                className={`font-sf w-full text-left px-3 py-2 text-xs font-medium transition-colors ${
                  value === m.id
                    ? 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/60'
                }`}
              >
                <span className="font-sf block">{m.name}</span>
                <span className="font-sf block text-[11px] opacity-60">{m.provider}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function EmptyState({ spaceName, onBriefMe, onCatchMeUp, onTimeline, onDocuments }: {
  spaceName?: string; onBriefMe: () => void; onCatchMeUp: () => void; onTimeline: () => void; onDocuments: () => void
}) {
  const actions = [
    { icon: 'doc', label: 'Brief me', sub: 'Updated 2 hours ago', onClick: onBriefMe },
    { icon: 'clock', label: 'Catch me up', sub: 'Updated 2 hours ago', onClick: onCatchMeUp },
    { icon: 'list', label: 'Timeline', sub: 'Updated 2 hours ago', onClick: onTimeline },
    { icon: 'folder', label: 'Documents', sub: 'Updated 2 hours ago', onClick: onDocuments },
  ]

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }} className="flex flex-col items-center min-h-[55vh] pt-8">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-gray-100 dark:bg-gray-800 mb-4">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-gray-600 dark:text-gray-400">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </div>
        <p className="font-sf text-gray-900 dark:text-white text-base font-semibold mb-1">
          Hi, I'm Memory
        </p>
        <p className="font-sf text-gray-900 dark:text-gray-400 text-sm max-w-xs leading-relaxed">
          {spaceName
            ? `Ask me anything about ${spaceName}. I can search your documents, CRM data, and the web.`
            : 'Ask me anything. I can search your documents, CRM data, and the web.'}
        </p>
      </motion.div>
      <div className="flex flex-col gap-3 w-full max-w-xs">
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
            className="flex items-center gap-3 text-left px-4 py-3 rounded-full bg-white dark:bg-gray-800 shadow-[0_4px_16px_rgba(0,0,0,0.08)] hover:shadow-[0_6px_20px_rgba(0,0,0,0.12)] transition-all group"
          >
            <div className="w-5 h-5 flex items-center justify-center text-[#0F172A] dark:text-white">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
                {a.icon === 'doc' && <path d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />}
                {a.icon === 'clock' && <path d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />}
                {a.icon === 'list' && <path d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0ZM3.75 12h.007v.008H3.75V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm-.375 5.25h.007v.008H3.75v-.008Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />}
                {a.icon === 'folder' && <path d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />}
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-figtree text-sm font-medium text-[#0F172A] dark:text-white">{a.label}</p>
              <p className="font-sf text-xs text-[#64748B] dark:text-gray-400 truncate">{a.sub}</p>
            </div>
          </motion.button>
        ))}
      </div>
    </motion.div>
  )
}

function normalizeMarkdown(text: string): string {
  return text
    // Strip Windows carriage returns — they break GFM table parsing
    .replace(/\r/g, '')
    // Strip any model-emitted "[WEB-1], [WEB-3] — web source(s)" attribution line…
    .replace(/\[(?:INT|WEB)-\d+\](?:\s*,\s*\[(?:INT|WEB)-\d+\])*\s*[—–-]\s*(?:web|internal)?\s*sources?\.?/gi, '')
    // …and any remaining inline [INT-n] / [WEB-n] citation tags (sources are shown as chips).
    .replace(/\s*\[(?:INT|WEB)-\d+\]/gi, '')
    .split('\n')
    .map(line => line.replace(/^(\s*)•\s+/, '$1- '))
    .join('\n')
}

function ChatMessage({ message, isStreaming, onSuggestionClick }: {
  message: Message
  isStreaming?: boolean
  onSuggestionClick?: (suggestion: string) => void
}) {
  const isUser = message.role === 'user'
  const latestAction = message.thinkingStepActions?.[message.thinkingStepActions.length - 1] ?? ''
  const latestStep = message.thinkingSteps?.[message.thinkingSteps.length - 1] ?? ''
  const showStatus = isStreaming && message.content === ''
  const statusText = showStatus ? (
    latestAction === 'soqlQuery' ? 'Querying CRM data…' :
    latestAction === 'find' ? 'Searching CRM records…' :
    latestAction === 'composeAnswer' ? 'Drafting response…' :
    latestAction === 'verifyAnswer' ? 'Verifying answer…' :
    latestAction === 'crossCheck' ? 'Cross-checking data…' :
    latestAction === 'quickCheck' ? 'Validating results…' :
    latestAction === 'fallthrough' ? 'Trying alternative approach…' :
    latestAction === 'detectHallucination' ? 'Checking accuracy…' :
    latestAction === 'classifyIntent' ? 'Understanding your question…' :
    latestAction === 'loadSkills' ? 'Loading knowledge…' :
    latestAction === 'skillApplied' ? 'Applying rules…' :
    latestAction === 'info' ? (latestStep || 'Thinking…') :
    latestAction ? `${latestAction}…` :
    'Thinking…'
  ) : ''
  const [vote, setVote] = useState<'up' | 'down' | null>(null)
  const [thinkingOpen, setThinkingOpen] = useState(false)

  const remarkPlugins = useMemo(() => [remarkGfm], [])

  const mdComponents = useMemo(() => ({
    table: ({ children }: { children: React.ReactNode }) => (
      <div className="overflow-x-auto my-3"><table>{children}</table></div>
    ),
    img: ({ src, alt }: { src?: string; alt?: string }) => {
      const url = typeof src === 'string' && src ? src : null
      if (!url) return null
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
    code: ({ className, children, ...props }: React.HTMLAttributes<HTMLElement> & { className?: string; children?: React.ReactNode }) => {
      const isChart = /language-chart/.test(className || '')
      if (isChart) {
        const raw = String(children).replace(/\n$/, '')
        const spec = parseChartJson(raw)
        if (spec) return <ChartBlock spec={spec} />
      }
      return <code className={className} {...props}>{children}</code>
    },
  } as any), [])

  const mdContent = useMemo(() => normalizeMarkdown(message.content), [message.content])

  const handleVote = async (v: 'up' | 'down') => {
    const next = vote === v ? null : v
    setVote(next)
    await fetch('/api/messages/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: message.id, vote: v }),
    }).catch(() => {})
  }

  return (
    <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
      <div className={`max-w-[85%] px-4 py-3 rounded-[24px] text-[15px] leading-relaxed tracking-[-0.23px] ${
        isUser
          ? 'bg-[#1A1A1A]/[0.09] dark:bg-gray-700 text-[#0F172A] dark:text-white rounded-br-sm shadow-[0_4px_16px_rgba(0,0,0,0.08)]'
          : 'bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 border border-gray-100 dark:border-gray-800 rounded-bl-sm'
      }`}>
        {isUser ? (
          message.content.split('\n').map((line, i, arr) => (
            <span key={i}>{line}{i < arr.length - 1 && <br />}</span>
          ))
        ) : showStatus ? (
          <span className="flex items-center gap-2 py-0.5">
            <span className="flex items-center gap-[3px]">
              {[0, 1, 2].map((i) => (
                <motion.span
                  key={i}
                  className="w-[4px] h-[4px] rounded-full bg-[#0F172A] dark:bg-gray-300"
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{ repeat: Infinity, duration: 1.2, delay: i * 0.2, ease: 'easeInOut' }}
                />
              ))}
            </span>
            <span className="font-sf text-xs text-gray-500 dark:text-gray-400">{statusText}</span>
          </span>
        ) : (
          <div>
            {message.thinkingSteps && message.thinkingSteps.length > 0 && (
              <div className="mb-2">
                <button
                  onClick={() => setThinkingOpen((o) => !o)}
                  className="font-sf flex items-center gap-1.5 text-[11px] text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors select-none"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform duration-150 ${thinkingOpen ? 'rotate-90' : ''}`}>
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                  <span className="font-sf font-medium">Thinking process</span>
                  <span className="font-sf text-gray-300 dark:text-gray-600">({message.thinkingSteps.length} step{message.thinkingSteps.length !== 1 ? 's' : ''})</span>
                </button>
                {thinkingOpen && (
                  <div className="mt-1.5 pl-3 border-l-2 border-gray-100 dark:border-gray-800 space-y-1 max-h-48 overflow-y-auto">
                    {message.thinkingSteps.map((step, i) => {
                      const action = (message.thinkingStepActions ?? [])[i] ?? ''
                      const result = (message.thinkingStepResults ?? [])[i] ?? ''
                      const isResult = action === 'result' || step.startsWith('Result: ')
                      const displayStep = isResult ? step.replace(/^Result:\s*/, '') : step

                      // Color-coding by action type
                      let iconColor = 'text-gray-300 dark:text-gray-600'
                      let bgColor = ''
                      let badge = null
                      if (['classifyIntent', 'loadSkills', 'understandQuery', 'resolveSynonyms', 'skillApplied'].includes(action)) {
                        iconColor = 'text-blue-400 dark:text-blue-500'
                      } else if (['soqlQuery', 'find', 'executeTool', 'toolResult', 'mcpStart', 'resolveFollowUp'].includes(action)) {
                        iconColor = 'text-gray-400 dark:text-gray-500'
                      } else if (action === 'verifyAnswer' || action === 'quickCheck') {
                        iconColor = 'text-emerald-400 dark:text-emerald-500'
                        // Extract score for color badge (no text duplicate)
                        const scoreMatch = displayStep.match(/(\d+)\/100/)
                        if (scoreMatch) {
                          const score = parseInt(scoreMatch[1])
                          const scoreColor = score >= 70 ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' : score >= 40 ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' : 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'
                          badge = <span className={`ml-1 px-1 py-0.5 rounded text-[11px] font-medium ${scoreColor}`}>{score}</span>
                        }
                      } else if (['crossCheck', 'detectHallucination'].includes(action)) {
                        iconColor = 'text-yellow-500 dark:text-yellow-400'
                        bgColor = 'bg-yellow-50/50 dark:bg-yellow-900/10'
                      } else if (action === 'webSearch') {
                        iconColor = 'text-cyan-500 dark:text-cyan-400'
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
                            <div className="ml-5 mt-0.5 text-[11px] text-gray-300 dark:text-gray-600">
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
                remarkPlugins={remarkPlugins}
                components={mdComponents}
              >{mdContent}</ReactMarkdown>
              {isStreaming && message.content.length > 0 && (
                <motion.span
                  animate={{ opacity: [1, 0, 1] }}
                  transition={{ repeat: Infinity, duration: 0.9, ease: 'linear' }}
                  className="inline-block w-0.5 h-[0.85em] bg-gray-400 dark:bg-gray-400 ml-0.5 align-text-bottom rounded-full"
                />
              )}
              {!isStreaming && message.documentImages && message.documentImages.length > 0 && (
                <div className="mt-3">
                  <p className="font-sf text-[11px] text-gray-400 dark:text-gray-500 mb-1.5 uppercase tracking-wide">
                    Images from document ({message.documentImages.length})
                  </p>
                  <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'thin' }}>
                    {message.documentImages.slice(0, 8).map((img, i) => (
                      <ChatImage key={img.url} url={img.url} alt={img.alt || img.documentName} />
                    ))}
                  </div>
                </div>
              )}
              {message.citations && message.citations.length > 0 && (() => {
                const webCites = message.citations.filter((c) => c.sourceType === 'web' && c.url)
                const internalCites = message.citations.filter((c) => c.sourceType !== 'web')
                const chip = "text-[11px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 truncate max-w-[180px]"
                const chipLink = `${chip} hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-200 cursor-pointer transition-colors`
                return (
                  <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-800 space-y-1">
                    {internalCites.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        <span className="font-sf text-[11px] text-gray-400 dark:text-gray-500 mr-0.5 self-center">Sources:</span>
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
                        <p className="font-sf text-[11px] italic text-gray-400 dark:text-gray-500">🌐 Includes information from the web — please verify against the sources below.</p>
                        <div className="flex flex-wrap gap-1">
                          <span className="font-sf text-[11px] text-gray-400 dark:text-gray-500 mr-0.5 self-center">🌐 Web:</span>
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
              {!isStreaming && (
                <div className="mt-1.5 flex gap-0.5">
                  <button onClick={() => handleVote('up')} title="Helpful"
                    aria-label="Mark as helpful"
                    className={`p-1 rounded transition-colors ${vote === 'up' ? 'text-gray-700 dark:text-gray-200' : 'text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400'}`}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/>
                      <path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>
                    </svg>
                  </button>
                  <button onClick={() => handleVote('down')} title="Not helpful"
                    aria-label="Mark as not helpful"
                    className={`p-1 rounded transition-colors ${vote === 'down' ? 'text-gray-700 dark:text-gray-200' : 'text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400'}`}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/>
                      <path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/>
                    </svg>
                  </button>
                </div>
              )}
               {message.suggestions && message.suggestions.length > 0 && !isStreaming && message.role !== 'user' && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                   {message.suggestions.map((s: string, i: number) => (
                    <button
                      key={i}
                      onClick={() => onSuggestionClick?.(s)}
                      className="font-sf text-xs px-3 py-1.5 rounded-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-200 transition-colors cursor-pointer shadow-[0_2px_8px_rgba(0,0,0,0.04)]"
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
      <div className={`font-sf text-[11px] text-gray-400 dark:text-gray-600 mt-1 ${isUser ? 'text-right' : 'text-left'}`}>
        {message.createdAt && formatRelativeTime(message.createdAt)}
      </div>
    </div>
  )
}

function NavBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <motion.button whileTap={{ scale: 0.94 }} onClick={onClick}
      className={`font-figtree flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-full transition-all min-h-[44px] backdrop-blur-[132px] ${
        active ? 'bg-white dark:bg-gray-700 text-[#0F172A] dark:text-white shadow-[0_4px_16px_rgba(0,0,0,0.08)]'
               : 'text-gray-400 dark:text-gray-500 hover:text-[#0F172A] dark:hover:text-white hover:bg-white/50 dark:hover:bg-gray-800'
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
      <span className="font-sf text-xs text-gray-900 dark:text-gray-500 flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 bg-gray-300 dark:bg-gray-600 rounded-full" />
        Queued
      </span>
    )
  }

  return (
    <span className="font-sf text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
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
      role="dialog"
      aria-modal="true"
      aria-label="Document insights"
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[24px]" />
      <motion.div
        initial={{ opacity: 0, y: 32, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 32, scale: 0.97 }}
        transition={{ type: 'spring', stiffness: 380, damping: 30 }}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full sm:max-w-lg max-h-[85vh] sm:max-h-[80vh] overflow-y-auto bg-[#F1F5F9] dark:bg-[#1a1a1a] rounded-t-3xl sm:rounded-3xl shadow-2xl backdrop-blur-[24px]"
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
            <div className="sticky top-0 z-10 flex items-start gap-3 p-5 bg-[#F1F5F9] dark:bg-[#1a1a1a] border-b border-gray-100 dark:border-gray-800 rounded-t-3xl backdrop-blur-[24px]">
              <span className="text-2xl shrink-0">{FILE_ICONS[doc.fileType] ?? '📄'}</span>
              <div className="flex-1 min-w-0">
                <p className="font-sf font-semibold text-gray-900 dark:text-white text-sm leading-snug break-words">{doc.name}</p>
                <p className="font-sf text-xs text-gray-900 dark:text-gray-500 mt-0.5">
                  {fmt(doc.fileSize)} · {formatDateTime(doc.createdAt, { long: true })}
                </p>
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
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
                <p className="font-sf text-sm text-gray-900 dark:text-gray-500 text-center py-4">No insights extracted from this document.</p>
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
        <p className="font-sf text-xs font-semibold uppercase tracking-wider text-gray-900 dark:text-gray-500">{label}</p>
      </div>
      {isSummary ? (
        <p className="font-sf text-sm text-gray-900 dark:text-gray-300 leading-relaxed">{items[0]}</p>
      ) : (
        <div className="space-y-2">
          {items.map((item, i) => (
            <div key={i} className={`flex gap-2.5 text-sm px-3 py-2.5 rounded-xl ${
              accent === 'amber'
                ? 'bg-amber-50 dark:bg-amber-900/10 text-amber-800 dark:text-amber-300'
                : 'bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-300'
            }`}>
              <span className="shrink-0 text-gray-900 dark:text-gray-500 mt-0.5">—</span>
              <span className="font-sf leading-relaxed">{item}</span>
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
    const win = window.open('about:blank', '_blank')
    try {
      const res = await fetch(`/api/documents/${doc.id}/view`)
      if (!res.ok) {
        win?.close()
        let msg = `Error ${res.status}`
        try { const body = await res.json(); msg = body.error ?? msg } catch {}
        throw new Error(msg)
      }
      const { url } = await res.json()
      if (win) {
        win.location.href = url
        onClose()
      } else {
        // Popup blocked — fall back to direct link
        const a = document.createElement('a')
        a.href = url
        a.target = '_blank'
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
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
      role="dialog"
      aria-modal="true"
      aria-label="Document actions"
      className="fixed inset-0 z-50 flex items-end justify-center"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[24px]" />
      <motion.div
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', stiffness: 420, damping: 36 }}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-lg bg-[#F1F5F9] dark:bg-[#1c1c1e] rounded-t-3xl shadow-2xl max-h-[85vh] overflow-y-auto backdrop-blur-[24px]"
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
                  <p className="font-sf font-semibold text-gray-900 dark:text-white text-sm leading-snug truncate flex items-center gap-2">
                    {doc.name}
                    {doc.version > 1 && <span className="font-sf shrink-0 text-[11px] font-medium px-1.5 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900 text-indigo-600 dark:text-indigo-300">v{doc.version}</span>}
                  </p>
                  <p className="font-sf text-xs text-gray-900 dark:text-gray-500 mt-0.5">
                    <span className={STATUS_COLOR[doc.status]}>{doc.status.charAt(0).toUpperCase() + doc.status.slice(1)}</span>
                    {' · '}{fmt(doc.fileSize)}
                    {' · '}{formatDateTime(doc.createdAt)}
                  </p>
                  {doc.status === 'failed' && doc.failureReason && (
                    <p className="font-sf text-xs text-red-400 mt-1.5 leading-relaxed">{doc.failureReason}</p>
                  )}
                </div>
              </div>
              {doc.status === 'ready' && doc.summary && (
                <div className="mt-3 px-3 py-2.5 bg-gray-50 dark:bg-gray-900 rounded-xl">
                  <p className="font-sf text-[11px] font-semibold uppercase tracking-wider text-gray-900 dark:text-gray-500 mb-1">Short Summary</p>
                  <p className="font-sf text-xs text-gray-600 dark:text-gray-400 leading-relaxed">{doc.summary}</p>
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
                    <p className="font-sf text-xs text-red-400 px-4 pb-1 leading-relaxed">{viewError}</p>
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
                className="font-sf w-full py-3.5 text-sm font-medium text-gray-900 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-2xl hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
              >
                Cancel
              </button>
            </div>
          </>
        )}

        {mode === 'rename' && (
          <div className="px-5 pt-3 pb-5">
            <button onClick={() => setMode('actions')} className="font-sf flex items-center gap-1.5 text-sm text-gray-900 dark:text-gray-400 mb-5 hover:text-gray-700 dark:hover:text-gray-200 transition-colors">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
              Back
            </button>
            <p className="font-sf text-base font-semibold text-gray-900 dark:text-white mb-4">Rename document</p>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleRename() }}
              autoFocus
              className="font-sf w-full px-4 py-3 text-base text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors mb-4"
            />
            <div className="flex gap-3">
              <button
                onClick={() => setMode('actions')}
                className="font-sf flex-1 py-3 text-sm font-medium text-gray-900 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-xl hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleRename}
                disabled={saving || !newName.trim()}
                className="font-sf flex-1 py-3 text-sm font-medium text-white bg-gray-900 dark:bg-gray-700 rounded-xl disabled:opacity-40 hover:bg-gray-700 dark:hover:bg-gray-600 transition-colors"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}

        {mode === 'delete' && (
          <div className="px-5 pt-3 pb-5">
            <button onClick={() => setMode('actions')} className="font-sf flex items-center gap-1.5 text-sm text-gray-900 dark:text-gray-400 mb-5 hover:text-gray-700 dark:hover:text-gray-200 transition-colors">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
              Back
            </button>
            <p className="font-sf text-base font-semibold text-gray-900 dark:text-white mb-2">Delete document?</p>
            <p className="font-sf text-sm text-gray-900 dark:text-gray-400 mb-6 leading-relaxed">
              This removes the file and all memory associated with it. This cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setMode('actions')}
                className="font-sf flex-1 py-3 text-sm font-medium text-gray-900 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-xl hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="font-sf flex-1 py-3 text-sm font-medium text-white bg-red-500 rounded-xl disabled:opacity-50 hover:bg-red-600 transition-colors"
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
          <div className="w-9 h-9 rounded-lg bg-[#F1F5F9] dark:bg-gray-800 shrink-0" />
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
      <span className="font-sf text-sm font-medium">{label}</span>
    </motion.button>
  )
}


