import postgres from 'postgres'
const sql = postgres(process.env.DATABASE_URL)
const tables = await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
console.log(tables.map(t => t.tablename).join(', ') || '(no tables)')
await sql.end()
