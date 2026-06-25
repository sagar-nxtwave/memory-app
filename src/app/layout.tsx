import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
import './globals.css'

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' })

export const metadata: Metadata = {
  title: 'Memory',
  description: 'Executive memory for your business',
  icons: { icon: '/favicon.svg' },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} h-dvh`} suppressHydrationWarning>
      <head>
        {/* Apply theme class before first paint — eliminates flash and stale-state race */}
        <script dangerouslySetInnerHTML={{ __html: `try{var t=localStorage.getItem('theme')||(window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');if(t==='dark')document.documentElement.classList.add('dark')}catch(e){}` }} />
      </head>
      <body className="h-full bg-white dark:bg-[#0f0f0f] font-sans antialiased text-gray-900 dark:text-gray-100" suppressHydrationWarning>
        {children}
      </body>
    </html>
  )
}
