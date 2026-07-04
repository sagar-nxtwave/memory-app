import postgres from 'postgres'
const dest = postgres(process.env.DEST_DB, { ssl: 'require' })
const enums = await dest`SELECT enum_range(NULL::chunk_type)`
console.log('chunk_type values:', enums[0])
await dest.end()
