'use client'

import { useState, useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'

// -- Nav item (Caption2/Regular: SF Pro 11/13, +0.0055em) ---------------------

function NavItem({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`font-sf flex flex-col items-center justify-center gap-1 rounded-full transition-colors py-2 ${
        active ? 'bg-white text-[#0F172A] px-[clamp(0.9rem,4.5vw,1.5rem)]' : 'text-white px-[clamp(0.6rem,3.5vw,1.25rem)]'
      }`}
    >
      {icon}
      <span className="text-[11px] leading-[13px] tracking-[0.0055em]">{label}</span>
    </button>
  )
}

export function AppChrome() {
  const router = useRouter()
  const pathname = usePathname()
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [creating, setCreating] = useState(false)

  // Any page can trigger the shared sheet via openCreateSpace()
  useEffect(() => {
    const open = () => setShowCreate(true)
    window.addEventListener('memory:new-space', open)
    return () => window.removeEventListener('memory:new-space', open)
  }, [])

  async function createSpace(e: React.FormEvent) {
    e.preventDefault()
    if (!newName.trim()) return
    setCreating(true)
    const res = await fetch('/api/spaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim(), description: newDesc.trim() || null }),
    })
    if (res.ok) {
      const space = await res.json()
      setShowCreate(false); setNewName(''); setNewDesc('')
      window.dispatchEvent(new CustomEvent('space-created'))
      router.push(`/spaces/${space.id}`)
    }
    setCreating(false)
  }

  const isHome = pathname === '/'
  const isSpaces = pathname === '/spaces'
  const isAccount = pathname === '/account'
  const isSettings = pathname === '/settings'
  // Chrome (header + bottom nav) shows only on the three tab roots — drill-in
  // pages (space detail, global chat) keep a clean full-screen layout.
  const showChrome = isHome || isSpaces || isAccount || isSettings

  return (
    <>
      {/* -- Memory header (mobile only — desktop uses the sidebar) -- */}
      {showChrome && (
      <header className="md:hidden fixed top-0 inset-x-0 z-20 bg-[#faf9f9]/70 dark:bg-[#0a0a0a]/70 backdrop-blur-[24px]">
        {/* Inner container matches the page content width so the logo lines up with the page heading */}
        <div className="w-full max-w-2xl mx-auto px-4 pt-4 pb-3 flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-rose-200 via-orange-100 to-amber-200" />
          <span className="font-serif text-[20px] font-semibold leading-[22px] text-[#1E293B] dark:text-slate-100">Memory</span>
        </div>
      </header>
      )}

      {/* -- Floating bottom nav (mobile only) — Figma "Nav bar" -- */}
      {showChrome && (
      <div className="md:hidden fixed inset-x-0 bottom-0 z-30 pointer-events-none">
        <div className="h-[122px] bg-gradient-to-t from-[#faf9f9] dark:from-[#0a0a0a] to-transparent" />
        <div
          className="pointer-events-auto absolute inset-x-0 bottom-0 flex items-center justify-center gap-[clamp(0.375rem,2vw,0.5rem)] px-3 pb-2"
          style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 8px)' }}
        >
          {/* Pill: bg rgba(26,26,26,0.36), blur 24, shadow 0 2px 8px 0.08, pad 8, gap 8 */}
          <div className="flex items-center gap-[clamp(0.25rem,1.5vw,0.5rem)] p-2 rounded-full bg-[rgba(26,26,26,0.36)] backdrop-blur-[24px] shadow-[0_2px_8px_rgba(0,0,0,0.08)]">
            <NavItem active={isHome} label="Home" onClick={() => router.push('/')} icon={
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
            } />
            <NavItem active={isSpaces} label="Spaces" onClick={() => router.push('/spaces')} icon={
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><circle cx="3.5" cy="6" r="1" fill="currentColor" stroke="none" /><circle cx="3.5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="3.5" cy="18" r="1" fill="currentColor" stroke="none" /></svg>
            } />
            <NavItem active={isAccount} label="Account" onClick={() => router.push('/account')} icon={
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>
            } />
            <NavItem active={isSettings} label="Settings" onClick={() => router.push('/settings')} icon={
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
            } />
          </div>
          {/* + button: 68×62 glass pill, white plus */}
          <button
            onClick={() => setShowCreate(true)}
            aria-label="New space"
            className="shrink-0 grid place-items-center w-[clamp(3.25rem,15vw,4.25rem)] h-[clamp(3rem,13.5vw,3.875rem)] rounded-full bg-[rgba(26,26,26,0.36)] backdrop-blur-[24px] shadow-[0_2px_8px_rgba(0,0,0,0.08)] text-white"
          >
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        </div>
      </div>
      )}

      {/* -- Desktop new-space button -- */}
      <motion.button
        whileTap={{ scale: 0.92 }}
        onClick={() => setShowCreate(true)}
        className="hidden md:grid fixed right-6 bottom-6 z-30 place-items-center w-14 h-14 rounded-full bg-slate-900 dark:bg-white text-white dark:text-slate-900 shadow-lg"
        aria-label="New space"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
      </motion.button>

      {/* -- Shared new-space sheet -- */}
      <AnimatePresence>
        {showCreate && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
            onClick={() => { setShowCreate(false); setNewName(''); setNewDesc('') }}
          >
            <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', stiffness: 420, damping: 36 }}
              onClick={(e) => e.stopPropagation()}
              className="relative w-full max-w-md bg-white dark:bg-[#1c1c1e] rounded-t-3xl sm:rounded-3xl shadow-2xl"
              style={{ paddingBottom: 'env(safe-area-inset-bottom, 20px)' }}
            >
              <div className="flex justify-center pt-3 pb-1">
                <div className="w-9 h-1 bg-gray-200 dark:bg-gray-700 rounded-full" />
              </div>
              <form onSubmit={createSpace} className="px-5 pt-3 pb-5">
                <p className="text-base font-semibold text-gray-900 dark:text-white mb-4">New space</p>
                <div className="space-y-3 mb-5">
                  <input
                    autoFocus
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Space name — e.g. Sea Gardens"
                    className="w-full px-4 py-3 text-base text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors placeholder:text-gray-400 dark:placeholder:text-gray-600"
                  />
                  <input
                    type="text"
                    value={newDesc}
                    onChange={(e) => setNewDesc(e.target.value)}
                    placeholder="Short description (optional)"
                    className="w-full px-4 py-3 text-base text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl outline-none focus:border-gray-400 dark:focus:border-gray-500 transition-colors placeholder:text-gray-400 dark:placeholder:text-gray-600"
                  />
                </div>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => { setShowCreate(false); setNewName(''); setNewDesc('') }}
                    className="flex-1 py-3 text-sm font-medium text-gray-900 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 rounded-xl hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={creating || !newName.trim()}
                    className="flex-1 py-3 text-sm font-medium bg-gray-900 dark:bg-gray-700 text-white rounded-xl disabled:opacity-40 hover:bg-gray-700 dark:hover:bg-gray-600 transition-colors"
                  >
                    {creating ? 'Creating…' : 'Create space'}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
