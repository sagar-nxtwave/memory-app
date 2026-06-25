import { readFileSync } from 'fs'
import postgres from 'postgres'

const env = readFileSync('.env.local', 'utf-8')
  .split('\n')
  .filter(line => line && !line.startsWith('#'))
  .reduce((acc, line) => {
    const [key, ...rest] = line.split('=')
    if (key) acc[key.trim()] = rest.join('=').trim()
    return acc
  }, {})

const sql = postgres(env.DATABASE_URL)

const tables = await sql`
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public'
  ORDER BY table_name
`

console.log('Tables in Neon:')
tables.forEach(t => console.log(' ✅', t.table_name))

await sql.end()
