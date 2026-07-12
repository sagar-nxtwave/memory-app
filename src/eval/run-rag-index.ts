// Standalone RAG indexer runner — pulls Salesforce data, embeds it, stores in pgvector.
// Run: node -e "require('dotenv').config({path:'.env.local'}); require('child_process').execSync('npx tsx src/eval/run-rag-index.ts', {stdio:'inherit', env:process.env})"

import { indexAllSalesforceData, getIndexStatus } from '../salesforce/rag-indexer'

async function main() {
  console.log('═'.repeat(70))
  console.log(' SALESFORCE RAG INDEXER')
  console.log('═'.repeat(70))
  console.log()

  // Optional: pass object names as CLI args to index only a subset, e.g.
  // npx tsx src/eval/run-rag-index.ts Property_Inventory__c
  const filter = process.argv.slice(2)
  const objectNames = filter.length > 0 ? filter : undefined

  const start = Date.now()
  const results = await indexAllSalesforceData(objectNames)
  const elapsed = ((Date.now() - start) / 1000).toFixed(1)

  console.log()
  console.log('═'.repeat(70))
  console.log(' RESULTS')
  console.log('═'.repeat(70))
  for (const r of results) {
    const icon = r.status === 'completed' ? '✓' : '✗'
    console.log(`${icon} ${r.objectName}: ${r.recordsIndexed} records ${r.error ? `(ERROR: ${r.error})` : ''}`)
  }
  console.log(`\nTotal time: ${elapsed}s`)

  console.log()
  console.log('Current index status:')
  const status = await getIndexStatus()
  for (const s of status) {
    console.log(`  ${s.objectName}: ${s.count} chunks, last indexed ${s.lastIndexedAt}`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
  })
