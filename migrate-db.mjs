/**
 * Migrates spaces, documents, chunks, and messages from source DB → destination DB.
 * User mapping: matches by email. Run after the user has signed up in destination DB.
 *
 * Usage:
 *   SOURCE_DB="..." DEST_DB="..." node migrate-db.mjs
 */

import postgres from 'postgres'

const SOURCE_DB = process.env.SOURCE_DB
const DEST_DB   = process.env.DEST_DB

if (!SOURCE_DB || !DEST_DB) {
  console.error('Set SOURCE_DB and DEST_DB environment variables')
  process.exit(1)
}

const src  = postgres(SOURCE_DB,  { ssl: 'require' })
const dest = postgres(DEST_DB,    { ssl: 'require' })

// ── 1. Build user ID mapping (source userId → dest userId) by email ──────────
console.log('\n[1/6] Mapping users by email…')
const srcUsers  = await src`SELECT id, email FROM users`
const destUsers = await dest`SELECT id, email FROM users`

const destByEmail = new Map(destUsers.map(u => [u.email, u.id]))
const userMap     = new Map()

for (const u of srcUsers) {
  const destId = destByEmail.get(u.email)
  if (destId) {
    userMap.set(u.id, destId)
    console.log(`  ✓ ${u.email}  ${u.id} → ${destId}`)
  } else {
    console.log(`  ✗ ${u.email} not found in destination — skipping their spaces`)
  }
}

// ── 2. Spaces ────────────────────────────────────────────────────────────────
console.log('\n[2/6] Migrating spaces…')
const srcSpaces = await src`SELECT * FROM spaces`
let spacesInserted = 0

// Use any mapped user as fallback for spaces whose creator isn't in destination
const fallbackDestUserId = [...userMap.values()][0]

for (const space of srcSpaces) {
  // Check if already exists (idempotent)
  const [existing] = await dest`SELECT id FROM spaces WHERE id = ${space.id}`
  if (existing) { console.log(`  skip (exists) ${space.name}`); continue }

  const destCreatedBy = userMap.get(space.created_by) ?? fallbackDestUserId
  if (!destCreatedBy) { console.log(`  skip (no user) ${space.name}`); continue }

  await dest`
    INSERT INTO spaces (id, name, description, created_by, created_at, updated_at)
    VALUES (
      ${space.id},
      ${space.name},
      ${space.description},
      ${destCreatedBy},
      ${space.created_at},
      ${space.updated_at}
    )
  `
  spacesInserted++
  console.log(`  ✓ ${space.name}`)
}

// ── 3. Space members ─────────────────────────────────────────────────────────
console.log('\n[3/6] Migrating space members…')
const srcMembers = await src`SELECT * FROM space_members`
let membersInserted = 0

// Also ensure fallback user is owner of spaces where original owner wasn't mapped
const allDestSpaces = await dest`SELECT id, created_by FROM spaces`
for (const space of allDestSpaces) {
  if (space.created_by !== fallbackDestUserId) continue
  const [alreadyMember] = await dest`SELECT space_id FROM space_members WHERE space_id = ${space.id} AND user_id = ${fallbackDestUserId}`
  if (alreadyMember) continue
  await dest`INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES (${space.id}, ${fallbackDestUserId}, 'owner', now())`
}

for (const m of srcMembers) {
  const destUserId = userMap.get(m.user_id) ?? fallbackDestUserId
  if (!destUserId) continue

  const [existing] = await dest`SELECT space_id FROM space_members WHERE space_id = ${m.space_id} AND user_id = ${destUserId}`
  if (existing) continue

  await dest`
    INSERT INTO space_members (space_id, user_id, role, joined_at)
    VALUES (${m.space_id}, ${destUserId}, ${m.role}, ${m.joined_at})
  `
  membersInserted++
}
console.log(`  ✓ ${membersInserted} members inserted`)

// ── 4. Documents ─────────────────────────────────────────────────────────────
console.log('\n[4/6] Migrating documents…')
const srcDocs = await src`SELECT * FROM documents`
let docsInserted = 0

for (const d of srcDocs) {
  const [existing] = await dest`SELECT id FROM documents WHERE id = ${d.id}`
  if (existing) { console.log(`  skip (exists) ${d.name}`); continue }

  await dest`
    INSERT INTO documents (
      id, space_id, name, file_type, file_size, storage_key,
      status, failure_reason, version, uploaded_by, created_at, updated_at
    ) VALUES (
      ${d.id}, ${d.space_id}, ${d.name}, ${d.file_type}, ${d.file_size}, ${d.storage_key},
      ${d.status}, ${d.failure_reason}, ${d.version ?? 1},
      ${userMap.get(d.uploaded_by) ?? fallbackDestUserId},
      ${d.created_at}, ${d.updated_at}
    )
  `
  docsInserted++
}
console.log(`  ✓ ${docsInserted} documents inserted`)

// ── 5. Document chunks (with embeddings) ─────────────────────────────────────
console.log('\n[5/6] Migrating document chunks (this may take a while)…')
const srcChunks = await src`SELECT * FROM document_chunks`

// Get IDs already in dest so we can skip them
const existingIds = new Set(
  (await dest`SELECT id FROM document_chunks`).map(r => r.id)
)

const newChunks = srcChunks
  .filter(c => !existingIds.has(c.id))
  .map(c => ({
    id: c.id,
    document_id: c.document_id,
    content: c.content,
    embedding: c.embedding,
    chunk_index: c.chunk_index ?? 0,
    chunk_type: 'prose',
    contains_numbers: false,
    created_at: c.created_at ?? new Date(),
  }))

console.log(`  ${existingIds.size} already exist, inserting ${newChunks.length} new chunks…`)

const BATCH = 50
for (let i = 0; i < newChunks.length; i += BATCH) {
  const batch = newChunks.slice(i, i + BATCH)
  await dest`INSERT INTO document_chunks ${dest(batch, 'id', 'document_id', 'content', 'embedding', 'chunk_index', 'chunk_type', 'contains_numbers', 'created_at')}`
  if ((i + BATCH) % 200 === 0 || i + BATCH >= newChunks.length) {
    console.log(`  … ${Math.min(i + BATCH, newChunks.length)}/${newChunks.length}`)
  }
}
const chunksInserted = newChunks.length
console.log(`  ✓ ${chunksInserted} chunks inserted`)

// ── 6. Messages ──────────────────────────────────────────────────────────────
console.log('\n[6/6] Migrating chat messages…')
const srcMessages = await src`SELECT * FROM messages`
let msgsInserted = 0

for (const m of srcMessages) {
  const [existing] = await dest`SELECT id FROM messages WHERE id = ${m.id}`
  if (existing) continue

  await dest`
    INSERT INTO messages (id, space_id, role, content, created_at)
    VALUES (${m.id}, ${m.space_id}, ${m.role}, ${m.content}, ${m.created_at})
  `
  msgsInserted++
}
console.log(`  ✓ ${msgsInserted} messages inserted`)

// ── Done ─────────────────────────────────────────────────────────────────────
console.log('\n✅ Migration complete')
console.log(`   Spaces: ${spacesInserted}  |  Documents: ${docsInserted}  |  Chunks: ${chunksInserted}  |  Messages: ${msgsInserted}`)

await src.end()
await dest.end()
