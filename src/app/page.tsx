import { auth } from '@/lib/auth/config'
import { Marketing } from '@/components/marketing'
import { AuthedLayout } from '@/components/authed-layout'
import { HomeDashboard } from '@/components/home-dashboard'

export default async function RootPage() {
  const session = await auth()

  // Logged-out visitors see the marketing landing; logged-in users get Home.
  if (!session) return <Marketing />

  return (
    <div className="h-full bg-white dark:bg-[#0f0f0f]">
      <AuthedLayout>
        <HomeDashboard />
      </AuthedLayout>
    </div>
  )
}
