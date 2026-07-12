import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth/config'
import { getCustomGlossaryTerms, addGlossaryTerm, updateGlossaryTerm, deleteGlossaryTerm } from '@/salesforce/business-glossary'

// Business Glossary settings API — lets the client view/edit the business-term-to-schema
// mappings that get injected into the MCP prompt (e.g. "Customer" -> Account/Contact).
// Stored in the DB (glossary_terms table), not a JSON file, since Vercel's serverless
// filesystem doesn't persist writes reliably across requests/deployments.

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const terms = await getCustomGlossaryTerms()
  return NextResponse.json({ terms })
}

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { action, term: termData } = body

    if (action === 'add') {
      if (!termData?.term || !termData?.mapsTo) {
        return NextResponse.json({ error: 'term and mapsTo are required' }, { status: 400 })
      }
      const term = await addGlossaryTerm(termData.term, termData.mapsTo, termData.explanation || '')
      const terms = await getCustomGlossaryTerms()
      return NextResponse.json({ success: true, term, terms })
    }

    if (action === 'update') {
      if (!termData?.id) {
        return NextResponse.json({ error: 'id is required' }, { status: 400 })
      }
      const updated = await updateGlossaryTerm(termData.id, termData.term, termData.mapsTo, termData.explanation || '')
      if (!updated) {
        return NextResponse.json({ error: 'Term not found' }, { status: 404 })
      }
      const terms = await getCustomGlossaryTerms()
      return NextResponse.json({ success: true, term: updated, terms })
    }

    if (action === 'delete') {
      if (!termData?.id) {
        return NextResponse.json({ error: 'id is required' }, { status: 400 })
      }
      await deleteGlossaryTerm(termData.id)
      const terms = await getCustomGlossaryTerms()
      return NextResponse.json({ success: true, terms })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (err) {
    console.error('[settings/glossary] error:', err)
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
}
