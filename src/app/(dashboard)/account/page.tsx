'use client'

import { useSession, signOut } from 'next-auth/react'
import { motion } from 'framer-motion'
import { ThemeToggle } from '@/components/theme-toggle'

export default function AccountPage() {
  const { data: session } = useSession()
  const user = session?.user
  const initial = (user?.name ?? user?.email ?? '?').charAt(0).toUpperCase()

  return (
    <div className="relative min-h-full overflow-y-auto bg-[radial-gradient(circle_at_50%_0%,#faf9f9_68%,#e2e8f0_100%)] dark:bg-[#0a0a0a] dark:bg-none">
      <div className="w-full max-w-2xl mx-auto px-4 md:px-8 pt-16 md:pt-10 pb-40 md:pb-16">

        <h1 className="font-sf t-title font-normal text-[#0F172A] dark:text-white mb-6">Account</h1>

        {/* Profile card */}
        <div className="rounded-3xl bg-white dark:bg-[#111] shadow-[0_4px_16px_rgba(0,0,0,0.04)] ring-1 ring-black/[0.02] dark:ring-white/5 p-5 mb-4 flex items-center gap-4">
          <div className="w-16 h-16 rounded-full bg-gradient-to-br from-rose-200 via-orange-100 to-amber-200 grid place-items-center shrink-0">
            <span className="font-figtree text-2xl font-semibold text-slate-700">{initial}</span>
          </div>
          <div className="min-w-0">
            <p className="font-figtree text-[18px] font-semibold text-[#0F172A] dark:text-white truncate">{user?.name ?? 'Your account'}</p>
            <p className="font-sf text-[13px] text-[#94A3B8] dark:text-slate-500 truncate">{user?.email}</p>
          </div>
        </div>

        {/* Settings */}
        <div className="rounded-3xl bg-white dark:bg-[#111] shadow-[0_4px_16px_rgba(0,0,0,0.04)] ring-1 ring-black/[0.02] dark:ring-white/5 divide-y divide-slate-100 dark:divide-white/5 mb-4">
          <div className="flex items-center justify-between px-5 py-4">
            <span className="font-sf text-[15px] text-[#0F172A] dark:text-white">Appearance</span>
            <ThemeToggle />
          </div>
        </div>

        {/* Sign out */}
        <motion.button
          whileTap={{ scale: 0.98 }}
          onClick={() => signOut({ callbackUrl: '/login' })}
          className="font-sf w-full flex items-center justify-center gap-2 py-4 rounded-3xl bg-white dark:bg-[#111] shadow-[0_4px_16px_rgba(0,0,0,0.04)] ring-1 ring-black/[0.02] dark:ring-white/5 text-[15px] font-medium text-red-500 dark:text-red-400"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          Sign out
        </motion.button>
      </div>
    </div>
  )
}
