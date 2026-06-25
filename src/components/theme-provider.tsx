'use client'

import { createContext, useContext, useEffect, useState, useCallback } from 'react'

type Theme = 'light' | 'dark'

interface ThemeContextValue {
  theme: Theme
  toggle: () => void
  mounted: boolean
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'light',
  toggle: () => {},
  mounted: false,
})

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Always start with 'light' — same on server and client, no hydration mismatch
  const [theme, setTheme] = useState<Theme>('light')
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    // After hydration, read the class the inline <script> already applied
    const actual = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
    setTheme(actual)
    setMounted(true)
  }, [])

  const toggle = useCallback(() => {
    // Read from DOM — always the real source of truth, never a stale closure
    const isDark = document.documentElement.classList.contains('dark')
    const next: Theme = isDark ? 'light' : 'dark'
    document.documentElement.classList.toggle('dark', next === 'dark')
    setTheme(next)
    try { localStorage.setItem('theme', next) } catch { /* private browsing */ }
  }, [])

  return (
    <ThemeContext.Provider value={{ theme, toggle, mounted }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  return useContext(ThemeContext)
}
