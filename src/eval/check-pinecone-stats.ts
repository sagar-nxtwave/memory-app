import { getSalesforceIndex } from '../salesforce/pinecone-client'

async function main() {
  const index = getSalesforceIndex()
  const stats = await index.describeIndexStats()
  console.log(JSON.stringify(stats, null, 2))
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
