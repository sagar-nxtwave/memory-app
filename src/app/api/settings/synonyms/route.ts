import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth/config'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

const SYNONYMS_FILE = join(process.cwd(), 'data', 'custom-synonyms.json')

interface CustomSynonym {
  key: string
  field: string
  value?: string
  object?: string
  description: string
}

function loadSynonyms(): CustomSynonym[] {
  if (!existsSync(SYNONYMS_FILE)) return []
  try {
    return JSON.parse(readFileSync(SYNONYMS_FILE, 'utf-8'))
  } catch {
    return []
  }
}

function saveSynonyms(synonyms: CustomSynonym[]): void {
  const dir = join(process.cwd(), 'data')
  if (!existsSync(dir)) {
    const { mkdirSync } = require('fs')
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(SYNONYMS_FILE, JSON.stringify(synonyms, null, 2))
}

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return NextResponse.json({ synonyms: loadSynonyms() })
}

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { action, synonym } = body

    const synonyms = loadSynonyms()

    if (action === 'add') {
      if (!synonym?.key || !synonym?.field) {
        return NextResponse.json({ error: 'key and field are required' }, { status: 400 })
      }
      const exists = synonyms.find(s => s.key.toLowerCase() === synonym.key.toLowerCase())
      if (exists) {
        return NextResponse.json({ error: 'Synonym already exists' }, { status: 409 })
      }
      synonyms.push(synonym)
      saveSynonyms(synonyms)
      return NextResponse.json({ success: true, synonyms })
    }

    if (action === 'update') {
      const idx = synonyms.findIndex(s => s.key.toLowerCase() === synonym.key.toLowerCase())
      if (idx === -1) {
        return NextResponse.json({ error: 'Synonym not found' }, { status: 404 })
      }
      synonyms[idx] = { ...synonyms[idx], ...synonym }
      saveSynonyms(synonyms)
      return NextResponse.json({ success: true, synonyms })
    }

    if (action === 'delete') {
      const filtered = synonyms.filter(s => s.key.toLowerCase() !== synonym.key.toLowerCase())
      saveSynonyms(filtered)
      return NextResponse.json({ success: true, synonyms: filtered })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (err) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
}