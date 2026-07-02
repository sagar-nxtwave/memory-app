import postgres from 'postgres'

const sql = postgres(process.env.DATABASE_URL)
await sql`CREATE EXTENSION IF NOT EXISTS vector`
console.log('pgvector extension enabled')
await sql.end()
