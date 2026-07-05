// RAG retrieval regression check. Auto-generates test cases from real documents already in
// the DB — no manual test-case curation needed. For each document with an AI-generated
// summary, uses a snippet of that summary (NOT the document's own text) as a paraphrased
// query, then checks whether the document still surfaces in top retrieval results.
//
// This directly exercises the failure mode that motivated this script: a hard similarity
// cutoff can return ZERO rows for a legitimately relevant but differently-worded question,
// which reads to the user as an empty/unhelpful response. Run this after any change to
// embedding models, similarity thresholds, or retrieval SQL.
//
// Usage: node scripts/eval-rag.mjs [--limit=30] [--space=<spaceId>]
import { readFileSync } from 'fs'
import postgres from 'postgres'

const env = readFileSync('.env.local', 'utf-8')
  .split('\n')
  .filter((line) => line && !line.startsWith('#'))
  .reduce((acc, line) => {
    const [key, ...rest] = line.split('=')
    if (key) acc[key.trim()] = rest.join('=').trim()
    return acc
  }, {})

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true])
)
const LIMIT = parseInt(args.limit ?? '30', 10)
const EMBED_MODEL = 'mistralai/mistral-embed-2312'
const SIMILARITY_FLOOR = 0.20 // must match the app's fallback guardrail threshold

const sql = postgres(env.DATABASE_URL, { ssl: 'require' })

async function embed(text) {
  const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  })
  if (!res.ok) throw new Error(`Embedding failed: ${res.status} ${await res.text()}`)
  const data = await res.json()
  return data.data[0].embedding
}

const spaceFilter = args.space ? sql`AND d.space_id = ${args.space}::uuid` : sql``

const docs = await sql`
  SELECT d.id, d.name, d.space_id, d.summary
  FROM documents d
  WHERE d.status = 'ready' AND d.summary IS NOT NULL AND length(d.summary) > 20
  ${spaceFilter}
  ORDER BY d.created_at DESC
  LIMIT ${LIMIT}
`

if (docs.length === 0) {
  console.log('No documents with summaries found — upload/process some documents first.')
  await sql.end()
  process.exit(0)
}

console.log(`Running ${docs.length} retrieval eval case(s)...\n`)

let passed = 0
let failed = 0
const failures = []

for (const doc of docs) {
  // Use the summary as a paraphrased stand-in for "a user asking about this document" —
  // deliberately NOT the document's own raw text, since that would trivially match on
  // shared vocabulary and wouldn't test real semantic retrieval.
  const query = doc.summary.slice(0, 300)
  let embedding
  try {
    embedding = await embed(query)
  } catch (err) {
    console.error(`[ERROR] Embedding failed for "${doc.name}":`, err.message)
    failed++
    continue
  }
  const embStr = `[${embedding.join(',')}]`

  const results = await sql`
    SELECT dc.document_id, (1 - (dc.embedding <=> ${embStr}::vector)) AS similarity
    FROM document_chunks dc
    INNER JOIN documents d ON d.id = dc.document_id
    WHERE d.space_id = ${doc.space_id}
      AND d.status = 'ready'
      AND dc.embedding IS NOT NULL
      AND 1 - (dc.embedding <=> ${embStr}::vector) >= ${SIMILARITY_FLOOR}
    ORDER BY dc.embedding <=> ${embStr}::vector
    LIMIT 8
  `

  const found = results.find((r) => r.document_id === doc.id)
  if (found) {
    passed++
  } else {
    failed++
    failures.push({ name: doc.name, resultCount: results.length, topSim: results[0]?.similarity ?? null })
  }
}

console.log(`\n${passed}/${docs.length} passed, ${failed} failed\n`)

if (failures.length > 0) {
  console.log('Failures (document did not surface for its own summary as a query):')
  for (const f of failures) {
    console.log(`  ✗ "${f.name}" — ${f.resultCount} other result(s) returned, top similarity ${f.topSim?.toFixed(3) ?? 'n/a'}`)
  }
  console.log('\nA failure here means: a user asking about this document in their own words')
  console.log('would get an empty/unhelpful response. Check embedding model, threshold, or chunking.')
}

await sql.end()
process.exit(failed > 0 ? 1 : 0)
