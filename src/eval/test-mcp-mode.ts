import { answerSalesforceQuery } from '../salesforce/query'

const QUESTIONS = [
  'list all communities',
  'who are top 10 customers',
  'how much is address grand downtown sale',
]

async function main() {
  for (const q of QUESTIONS) {
    console.log('═'.repeat(70))
    console.log(`Q: ${q}`)
    console.log('═'.repeat(70))
    const start = Date.now()
    const result = await answerSalesforceQuery(q)
    console.log(`[${Date.now() - start}ms]`, result?.context?.slice(0, 600) ?? '(null)')
    console.log('Citation:', result?.citation.documentName)
    console.log()
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
