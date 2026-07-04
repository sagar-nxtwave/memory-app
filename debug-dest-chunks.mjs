import postgres from 'postgres'
const dest = postgres(process.env.DEST_DB, { ssl: 'require' })
const first = await dest`SELECT * FROM document_chunks LIMIT 1`
if (first.length) console.log('dest columns:', Object.keys(first[0]))
else {
  // No rows — check schema
  const cols = await dest`SELECT column_name FROM information_schema.columns WHERE table_name = 'document_chunks' ORDER BY ordinal_position`
  console.log('dest columns (empty table):', cols.map(c => c.column_name))
}
await dest.end()
