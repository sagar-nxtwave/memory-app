import postgres from 'postgres'
const src = postgres(process.env.SOURCE_DB, { ssl: 'require' })
const first = await src`SELECT * FROM document_chunks LIMIT 1`
if (first.length) console.log('columns:', Object.keys(first[0]))
else console.log('no chunks')
await src.end()
