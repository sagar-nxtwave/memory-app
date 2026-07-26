import type { Metadata } from 'next'
import { Playfair_Display, Figtree, Inter } from 'next/font/google'
import './globals.css'
import { auth } from '@/lib/auth/config'
import { Providers } from '@/components/providers'

const playfair = Playfair_Display({ subsets: ['latin'], weight: ['600'], variable: '--font-playfair' })
const figtree = Figtree({ subsets: ['latin'], weight: ['500', '600'], variable: '--font-figtree' })
// Inter — free, cross-platform stand-in for SF Pro (near-identical metrics)
const inter = Inter({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-inter' })

export const metadata: Metadata = {
  title: 'Memory',
  description: 'Executive memory for your business',
  icons: { icon: '/favicon.svg' },
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()

  return (
    <html lang="en" className={`${playfair.variable} ${figtree.variable} ${inter.variable} h-dvh`} suppressHydrationWarning>
      <head>
        {/* Apply theme class before first paint — eliminates flash and stale-state race */}
        <script dangerouslySetInnerHTML={{ __html: `try{var t=localStorage.getItem('theme')||(window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');if(t==='dark')document.documentElement.classList.add('dark')}catch(e){}` }} />
      </head>
      <body className="h-full bg-white dark:bg-[#0f0f0f] font-sans antialiased text-gray-900 dark:text-gray-100" suppressHydrationWarning>
        {/* Skip to main content — accessibility */}
        <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[9999] focus:bg-white focus:px-4 focus:py-2 focus:rounded-lg focus:shadow-lg focus:text-gray-900">
          Skip to content
        </a>
        {/* Session + theme live at the root so they persist across every navigation
            (no session refetch when moving between / and /spaces) */}
        <Providers session={session}>{children}</Providers>
      </body>
    </html>
  )
}
