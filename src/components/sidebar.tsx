'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { useSession, signOut } from 'next-auth/react'
import { motion, AnimatePresence } from 'framer-motion'
import { ThemeToggle } from './theme-toggle'

interface Space { id: string; name: string; description: string | null }

export function Sidebar() {
  const router = useRouter()
  const pathname = usePathname()
  const { data: session } = useSession()

  const [spaces, setSpaces] = useState<Space[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)

  // Draggable sidebar width
  const [sidebarWidth, setSidebarWidth] = useState(240)
  const dragState = useRef({ dragging: false, startX: 0, startWidth: 0, finalWidth: 240 })

  useEffect(() => {
    const saved = parseInt(localStorage.getItem('sidebar-width') ?? '240', 10)
    if (!isNaN(saved)) setSidebarWidth(Math.min(320, Math.max(160, saved)))
  }, [])

  const loadSpaces = useCallback(() => {
    fetch('/api/spaces')
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setSpaces(Array.isArray(d) ? d : []))
      .catch(() => {})
  }, [])

  useEffect(() => { loadSpaces() }, [loadSpaces])

  // Close mobile drawer on navigation
  useEffect(() => { setMobileOpen(false) }, [pathname])

  async function renameSpace(spaceId: string) {
    if (!editName.trim()) { setEditingId(null); return }
    const res = await fetch(`/api/spaces/${spaceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: editName.trim() }),
    })
    if (res.ok) {
      const updated = await res.json()
      setSpaces((prev) => prev.map((s) => s.id === spaceId ? { ...s, name: updated.name } : s))
    }
    setEditingId(null)
  }

  async function deleteSpace(spaceId: string) {
    setDeleting(true)
    const res = await fetch(`/api/spaces/${spaceId}`, { method: 'DELETE' })
    if (res.ok) {
      setSpaces((prev) => prev.filter((s) => s.id !== spaceId))
      if (pathname.startsWith(`/spaces/${spaceId}`)) router.push('/spaces')
    }
    setConfirmDeleteId(null)
    setDeleting(false)
  }

  async function createSpace(e: React.FormEvent) {
    e.preventDefault()
    if (!newName.trim()) return
    setCreating(true)
    const res = await fetch('/api/spaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim() }),
    })
    if (res.ok) {
      const space = await res.json()
      setSpaces((prev) => [...prev, space])
      setNewName('')
      setShowCreate(false)
      router.push(`/spaces/${space.id}`)
    }
    setCreating(false)
  }

  const activeId = pathname.startsWith('/spaces/') ? pathname.split('/')[2] : null
  const user = session?.user
  const initial = (user?.name ?? user?.email ?? '?').charAt(0).toUpperCase()

  const sidebarContent = (
    <div className="flex flex-col h-full">
      {/* Logo + Theme */}
      <div className="flex items-center justify-between px-4 pt-5 pb-3 shrink-0">
        <button
          onClick={() => router.push('/spaces')}
          className="text-[15px] font-semibold text-gray-900 dark:text-white tracking-tight hover:opacity-70 transition-opacity"
        >
          Memory
        </button>
        <ThemeToggle />
      </div>

      {/* Portfolio (Home) */}
      <div className="px-3 mb-1 shrink-0">
        <button
          onClick={() => router.push('/spaces')}
          className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm rounded-xl transition-colors ${
            pathname === '/spaces'
              ? 'bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white font-medium'
              : 'text-gray-900 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-white/5'
          }`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
            <polyline points="9 22 9 12 15 12 15 22"/>
          </svg>
          Portfolio
        </button>
      </div>

      {/* Ask All Spaces */}
      <div className="px-3 mb-1 shrink-0">
        <button
          onClick={() => router.push('/spaces/global')}
          className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm rounded-xl transition-colors ${
            pathname === '/spaces/global'
              ? 'bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white font-medium'
              : 'text-gray-900 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-white/5'
          }`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          Ask all spaces
        </button>
      </div>

      {/* New Space */}
      <div className="px-3 mb-2 shrink-0">
        <motion.button
          whileTap={{ scale: 0.97 }}
          onClick={() => { setShowCreate(true); setMobileOpen(true) }}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-white/5 rounded-xl transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New space
        </motion.button>
      </div>

      {/* Create form */}
      <AnimatePresence>
        {showCreate && (
          <motion.form
            key="create"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18 }}
            onSubmit={createSpace}
            className="px-3 mb-2 overflow-hidden shrink-0"
          >
            <input
              autoFocus
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Space name"
              className="w-full px-3 py-2.5 text-base text-gray-900 dark:text-white bg-white dark:bg-[#1c1c1c] border border-gray-200 dark:border-gray-700 rounded-xl outline-none focus:border-gray-400 dark:focus:border-gray-500 placeholder:text-gray-400 dark:placeholder:text-gray-600 transition-colors"
            />
            <div className="flex gap-1.5 mt-1.5">
              <button
                type="submit"
                disabled={creating || !newName.trim()}
                className="flex-1 py-1.5 text-xs font-medium bg-gray-900 dark:bg-gray-700 text-white rounded-lg disabled:opacity-40 hover:bg-gray-700 dark:hover:bg-gray-600 transition-colors"
              >
                {creating ? 'Creating…' : 'Create'}
              </button>
              <button
                type="button"
                onClick={() => { setShowCreate(false); setNewName('') }}
                className="py-1.5 px-3 text-xs text-gray-900 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
              >
                Cancel
              </button>
            </div>
          </motion.form>
        )}
      </AnimatePresence>

      {/* Section label */}
      <p className="px-4 text-[10px] font-semibold uppercase tracking-wider text-gray-900 dark:text-gray-500 mb-1.5 shrink-0">
        Spaces
      </p>

      {/* Spaces list */}
      <nav className="flex-1 overflow-y-auto px-3 space-y-0.5 scrollbar-hide">
        {spaces.length === 0 && !showCreate && (
          <p className="text-xs text-gray-900 dark:text-gray-500 px-3 py-2">
            No spaces yet
          </p>
        )}
        <AnimatePresence initial={false}>
          {spaces.map((space) => {
            const isActive = space.id === activeId
            const isEditing = editingId === space.id
            return (
              <motion.div
                key={space.id}
                layout
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                className="group flex items-center gap-1"
              >
                {isEditing ? (
                  <input
                    autoFocus
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={() => renameSpace(space.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') renameSpace(space.id)
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                    className="flex-1 px-3 py-2 text-base text-gray-900 dark:text-white bg-white dark:bg-[#1c1c1c] border border-gray-300 dark:border-gray-600 rounded-xl outline-none text-sm"
                  />
                ) : (
                  <>
                    <button
                      onClick={() => router.push(`/spaces/${space.id}?name=${encodeURIComponent(space.name)}`)}
                      className={`flex-1 min-w-0 text-left px-3 py-2.5 rounded-xl text-sm transition-colors ${
                        isActive
                          ? 'bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white font-medium'
                          : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5 hover:text-gray-900 dark:hover:text-white'
                      }`}
                    >
                      <span className="truncate block">{space.name}</span>
                    </button>

                    {/* ? menu */}
                    <div className="relative shrink-0">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          if (menuOpenId === space.id) {
                            setMenuOpenId(null)
                            setMenuPos(null)
                          } else {
                            const rect = e.currentTarget.getBoundingClientRect()
                            setMenuPos({ top: rect.bottom + 4, left: rect.right + 8 })
                            setMenuOpenId(space.id)
                          }
                        }}
                        className="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-white/10 transition-all"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                          <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
                        </svg>
                      </button>

                      <AnimatePresence>
                        {menuOpenId === space.id && menuPos && (
                          <>
                            <div className="fixed inset-0 z-[199]" onClick={() => { setMenuOpenId(null); setMenuPos(null) }} />
                            <motion.div
                              initial={{ opacity: 0, scale: 0.95, y: -4 }}
                              animate={{ opacity: 1, scale: 1, y: 0 }}
                              exit={{ opacity: 0, scale: 0.95, y: -4 }}
                              transition={{ duration: 0.1 }}
                              style={{ position: 'fixed', top: menuPos.top, left: menuPos.left }}
                              className="z-[200] w-36 bg-white dark:bg-[#1c1c1e] border border-gray-100 dark:border-gray-700 rounded-xl shadow-lg overflow-hidden py-1"
                            >
                              <button
                                onClick={() => { setEditName(space.name); setEditingId(space.id); setMenuOpenId(null); setMenuPos(null) }}
                                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-900 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/5 transition-colors text-left"
                              >
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                                </svg>
                                Rename
                              </button>
                              <button
                                onClick={() => { setConfirmDeleteId(space.id); setMenuOpenId(null); setMenuPos(null) }}
                                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/10 transition-colors text-left"
                              >
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="3 6 5 6 21 6"/>
                                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                                  <path d="M10 11v6M14 11v6"/>
                                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                                </svg>
                                Delete
                              </button>
                            </motion.div>
                          </>
                        )}
                      </AnimatePresence>
                    </div>
                  </>
                )}
              </motion.div>
            )
          })}
        </AnimatePresence>
      </nav>

      {/* OCR coming soon notice */}
      <div className="shrink-0 mx-3 mb-2 px-3 py-2 rounded-xl bg-amber-50 dark:bg-amber-900/15 border border-amber-200 dark:border-amber-800/40 flex items-start gap-2">
        <span className="text-amber-500 dark:text-amber-400 shrink-0 mt-px text-xs">⚠</span>
        <p className="text-[11px] text-amber-700 dark:text-amber-400 leading-snug">
          Image &amp; scanned PDF support (OCR) coming soon
        </p>
      </div>

      {/* User footer */}
      <div className="shrink-0 border-t border-gray-100 dark:border-white/5 p-3 mt-1">
        <div className="flex items-center gap-2.5 px-1">
          {/* Avatar */}
          <div className="w-7 h-7 rounded-full bg-gray-900 dark:bg-gray-700 flex items-center justify-center shrink-0">
            <span className="text-[11px] font-semibold text-white">{initial}</span>
          </div>
          {/* Name + email */}
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-gray-900 dark:text-white truncate leading-tight">
              {user?.name ?? 'Account'}
            </p>
            <p className="text-[11px] text-gray-900 dark:text-gray-400 truncate leading-tight">
              {user?.email}
            </p>
          </div>
          {/* Sign out */}
          <button
            onClick={() => signOut({ callbackUrl: '/login' })}
            title="Sign out"
            className="p-2 -mr-1 text-gray-300 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-300 transition-colors shrink-0 rounded-lg hover:bg-gray-100 dark:hover:bg-white/5"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )

  return (
    <>
      {/* -- Desktop sidebar (draggable width) -- */}
      <motion.aside
        initial={{ opacity: 0, x: -12 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.28 }}
        className="hidden md:flex shrink-0 flex-col border-r border-gray-100 dark:border-white/5 bg-gray-50 dark:bg-[#111111] h-full relative"
        style={{ width: sidebarWidth }}
      >
        {sidebarContent}

        {/* Drag handle */}
        <div
          onPointerDown={(e) => {
            e.preventDefault()
            dragState.current = { dragging: true, startX: e.clientX, startWidth: sidebarWidth, finalWidth: sidebarWidth }
            e.currentTarget.setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => {
            if (!dragState.current.dragging) return
            const delta = e.clientX - dragState.current.startX
            const next = Math.min(320, Math.max(160, dragState.current.startWidth + delta))
            dragState.current.finalWidth = next
            setSidebarWidth(next)
          }}
          onPointerUp={() => {
            dragState.current.dragging = false
            localStorage.setItem('sidebar-width', String(dragState.current.finalWidth))
          }}
          className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize group"
          title="Drag to resize"
        >
          <div className="absolute right-0 top-0 bottom-0 w-px bg-transparent group-hover:bg-gray-300 dark:group-hover:bg-gray-600 transition-colors" />
        </div>
      </motion.aside>

      {/* -- Mobile: hamburger button -- */}
      <button
        onClick={() => setMobileOpen(true)}
        className="md:hidden fixed top-4 left-4 z-40 p-2 bg-white dark:bg-[#111111] border border-gray-200 dark:border-white/10 rounded-xl shadow-sm text-gray-600 dark:text-gray-300"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>

      {/* -- Delete confirmation modal -- */}
      <AnimatePresence>
        {confirmDeleteId && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-center justify-center px-5"
            onClick={() => !deleting && setConfirmDeleteId(null)}
          >
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
              onClick={(e) => e.stopPropagation()}
              className="relative w-full max-w-sm bg-white dark:bg-[#1c1c1e] rounded-2xl shadow-2xl p-5"
            >
              <p className="text-base font-semibold text-gray-900 dark:text-white mb-1">Delete space?</p>
              <p className="text-sm text-gray-900 dark:text-gray-400 mb-5">
                All documents, chat history, and memory for{' '}
                <span className="font-medium text-gray-900 dark:text-gray-300">
                  {spaces.find((s) => s.id === confirmDeleteId)?.name}
                </span>{' '}
                will be permanently deleted.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setConfirmDeleteId(null)}
                  disabled={deleting}
                  className="flex-1 py-2.5 text-sm font-medium text-gray-900 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-xl hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  onClick={() => deleteSpace(confirmDeleteId)}
                  disabled={deleting}
                  className="flex-1 py-2.5 text-sm font-medium bg-red-500 hover:bg-red-600 text-white rounded-xl transition-colors disabled:opacity-40"
                >
                  {deleting ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* -- Mobile: drawer overlay -- */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              key="overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="md:hidden fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
              onClick={() => setMobileOpen(false)}
            />
            <motion.aside
              key="drawer"
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ type: 'spring', stiffness: 380, damping: 32 }}
              className="md:hidden fixed left-0 top-0 bottom-0 z-50 w-64 max-w-[85vw] flex flex-col bg-gray-50 dark:bg-[#111111] border-r border-gray-100 dark:border-white/5"
              style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
            >
              {sidebarContent}
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  )
}

