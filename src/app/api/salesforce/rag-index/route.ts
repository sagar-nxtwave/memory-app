import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth/config'
import { indexAllSalesforceData, getIndexStatus } from '@/salesforce/rag-indexer'

export const maxDuration = 300 // indexing thousands of records + embedding calls takes a while

// GET — check index freshness (record counts + last indexed time per object)
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const status = await getIndexStatus()
  return NextResponse.json({ status })
}

// POST — trigger a full re-index (pulls latest data from Salesforce, re-embeds, replaces chunks).
// Long-running (embeds thousands of records) — intended to be triggered manually or via cron,
// not on every page load.
export async function POST() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const results = await indexAllSalesforceData()
    return NextResponse.json({ success: true, results })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
