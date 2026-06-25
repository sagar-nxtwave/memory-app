import { auth } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { Providers } from '@/components/providers'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  if (!session) redirect('/login')

  return (
    <Providers>
      <div className="h-full bg-white dark:bg-[#0f0f0f]">
        {children}
      </div>
    </Providers>
  )
}
