import { ThemeProvider } from '@/components/theme-provider'
import { ThemeToggle } from '@/components/theme-toggle'

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <div className="min-h-full flex flex-col items-center justify-center px-4 py-8 sm:py-12 bg-gray-50 dark:bg-[#0f0f0f]">
        <div className="w-full max-w-sm">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-white">Memory</h1>
              <p className="mt-0.5 text-sm text-gray-400 dark:text-gray-500">Executive memory for your business</p>
            </div>
            <ThemeToggle />
          </div>
          {children}
        </div>
      </div>
    </ThemeProvider>
  )
}
