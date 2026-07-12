import { db } from '../lib/db'
import { sql } from 'drizzle-orm'

async function main() {
  await db.execute(sql`DROP TABLE IF EXISTS salesforce_chunks`)
  console.log('Dropped salesforce_chunks table')

  const dbSize = await db.execute(sql`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`)
  console.log('Total DB size now:', (dbSize as unknown as { size: string }[])[0]?.size)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
