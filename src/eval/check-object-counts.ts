import { soql } from '../salesforce/client'

const OBJECTS = ['Opportunity', 'Property_Inventory__c', 'Account', 'Case']

async function main() {
  for (const obj of OBJECTS) {
    const result = await soql(`SELECT COUNT(Id) cnt FROM ${obj}`)
    const cnt = (result.records[0] as { cnt?: number })?.cnt ?? 0
    console.log(`${obj}: ${cnt}`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
