import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth/config'
import { getSkillFiles, addSkillFile, updateSkillFile, deleteSkillFile, deleteAllSkillFiles } from '@/salesforce/skill-files'

// Skill Files settings API — lets the client view/edit free-form instruction documents
// that get injected into the MCP system prompt. These contain detailed business rules,
// query patterns, and domain knowledge that help the LLM answer questions correctly.

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const files = await getSkillFiles()
  return NextResponse.json({ files })
}

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { action, file } = body

    if (action === 'add') {
      if (!file?.name || !file?.content) {
        return NextResponse.json({ error: 'name and content are required' }, { status: 400 })
      }
      const newFile = await addSkillFile(file.name, file.category || 'general', file.triggerWords || '', file.content)
      const files = await getSkillFiles()
      return NextResponse.json({ success: true, file: newFile, files })
    }

    if (action === 'update') {
      if (!file?.id) {
        return NextResponse.json({ error: 'id is required' }, { status: 400 })
      }
      const updated = await updateSkillFile(file.id, file.name, file.category || 'general', file.triggerWords || '', file.content, file.active !== false)
      if (!updated) {
        return NextResponse.json({ error: 'File not found' }, { status: 404 })
      }
      const files = await getSkillFiles()
      return NextResponse.json({ success: true, file: updated, files })
    }

    if (action === 'delete') {
      if (!file?.id) {
        return NextResponse.json({ error: 'id is required' }, { status: 400 })
      }
      await deleteSkillFile(file.id)
      const files = await getSkillFiles()
      return NextResponse.json({ success: true, files })
    }

    if (action === 'deleteAll') {
      await deleteAllSkillFiles()
      const files = await getSkillFiles()
      return NextResponse.json({ success: true, files })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (err) {
    console.error('[settings/skill-files] error:', err)
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
}
