import postgres from 'postgres'
const src  = postgres(process.env.SOURCE_DB,  { ssl: 'require' })
const dest = postgres(process.env.DEST_DB,    { ssl: 'require' })
const [s] = await src`SELECT COUNT(*) FROM document_chunks`
const [d] = await dest`SELECT COUNT(*) FROM document_chunks`
console.log('Source chunks:', s.count)
console.log('Dest chunks:  ', d.count)
await src.end()
await dest.end()
