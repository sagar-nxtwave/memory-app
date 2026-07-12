import { db } from '../lib/db'
import { messages, spaces } from '../lib/db/schema'
import { eq, desc } from 'drizzle-orm'

async function main() {
  // Get last 20 assistant messages from space chats
  const recentMessages = await db
    .select({
      id: messages.id,
      content: messages.content,
      role: messages.role,
      createdAt: messages.createdAt,
      spaceId: messages.spaceId,
      spaceName: spaces.name,
    })
    .from(messages)
    .leftJoin(spaces, eq(messages.spaceId, spaces.id))
    .where(eq(messages.role, 'assistant'))
    .orderBy(desc(messages.createdAt))
    .limit(20)

  console.log(`\n${'═'.repeat(70)}`)
  console.log(` LAST ${recentMessages.length} ASSISTANT MESSAGES FROM SPACE CHATS`)
  console.log(`${'═'.repeat(70)}\n`)

  for (let i = 0; i < recentMessages.length; i++) {
    const msg = recentMessages[i]
    console.log(`${'─'.repeat(70)}`)
    console.log(`[${i + 1}] Space: ${msg.spaceName || 'N/A'} | ${msg.createdAt?.toISOString() || 'N/A'}`)
    console.log(`Answer: ${msg.content?.slice(0, 500) || '(empty)'}`)
    console.log()
  }
}

main().catch(console.error)
