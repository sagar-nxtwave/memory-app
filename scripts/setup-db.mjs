import { readFileSync } from 'fs'
import postgres from 'postgres'

// Parse .env.local manually
const env = readFileSync('.env.local', 'utf-8')
  .split('\n')
  .filter(line => line && !line.startsWith('#'))
  .reduce((acc, line) => {
    const [key, ...rest] = line.split('=')
    if (key) acc[key.trim()] = rest.join('=').trim()
    return acc
  }, {})

const sql = postgres(env.DATABASE_URL)

try {
  // 1. Enable pgvector
  await sql`CREATE EXTENSION IF NOT EXISTS vector`
  console.log('✅ pgvector extension enabled')

  // 2. Drop the broken BTree index (BTree cannot handle 1024-dim vectors — exceeds 2704 byte limit)
  await sql`DROP INDEX IF EXISTS embedding_idx`
  console.log('✅ Dropped old BTree index on embeddings')

  // 3. Create HNSW index — designed for approximate nearest-neighbour search on high-dim vectors
  //    vector_cosine_ops matches the <=> operator used in RAG queries
  //    m=16, ef_construction=64 are sensible defaults (higher = more accurate but slower to build)
  await sql`
    CREATE INDEX IF NOT EXISTS embedding_idx
    ON document_chunks
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)
  `
  console.log('✅ HNSW index created for vector similarity search')

} catch (e) {
  console.error('❌ Setup failed:', e.message)
  process.exit(1)
} finally {
  await sql.end()
}
