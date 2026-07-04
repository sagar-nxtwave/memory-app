import { Sidebar } from '@/components/sidebar'
import { AppChrome } from '@/components/app-chrome'

export function AuthedLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="flex h-full">
        <Sidebar />
        <main className="flex-1 min-w-0 overflow-y-auto relative">
          {children}
        </main>
      </div>
      <AppChrome />
    </>
  )
}
