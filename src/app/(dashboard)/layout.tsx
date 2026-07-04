import { auth } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import { AuthedLayout } from '@/components/authed-layout'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  if (!session) redirect('/login')

  return (
    <div className="h-full bg-white dark:bg-[#0f0f0f]">
      <AuthedLayout>{children}</AuthedLayout>
    </div>
  )
}
