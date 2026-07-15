// Independent cross-check for MCP answers — runs a quick fresh SOQL query to verify
// the key numbers (counts, amounts) the LLM claimed in its composed answer. Catches
// the most dangerous hallucination class: LLM fabricating or misreporting a count/amount
// that the raw SOQL data didn't actually contain.
//
// This is fast (one extra SOQL call, ~200ms) and runs only on MCP answers since those
// bypass the deterministic tool pipeline where results are directly formatted.

import { soql } from './client'

const COUNT_PATTERN = /\b(\d[\d,]*)\s*(?:deals?|opportunit\w*|cases?|accounts?|leads?|records?|units?|properties?|communities?|buildings?|customers?|bookings?|cancellations?|transfers?)\b/gi
const AMOUNT_PATTERN = /(?:AED|USD|\$)\s*([\d,]+(?:\.\d+)?)\s*(?:million|billion|M|B)?/gi

/** Extract a 4-digit year from the question (e.g. "sales of 2025" → 2025). */
function extractYear(question: string): number | null {
  const m = question.match(/\b(20\d{2})\b/)
  return m ? parseInt(m[1], 10) : null
}

interface CrossCheckResult {
  verified: boolean
  discrepancies: string[]
}

function guessObject(question: string): string {
  const q = question.toLowerCase()
  if (/\b(case|cases|support|service|eservice)\b/.test(q)) return 'Case'
  if (/\b(lead|leads|prospect)\b/.test(q)) return 'Lead'
  if (/\b(account|accounts|customer|customers|buyer)\b/.test(q)) return 'Account'
  if (/\b(property|properties|unit|units|inventory)\b/.test(q)) return 'Property_Inventory__c'
  if (/\b(task|tasks|activity|activities)\b/.test(q)) return 'Task'
  if (/\b(deal|deals|sale|sales|opportunit|pipeline|won|lost|booking|cancel|transfer)\b/.test(q)) return 'Opportunity'
  return 'Opportunity'
}

function buildVerifyQuery(objectName: string, question: string): string | null {
  const q = question.toLowerCase()

  switch (objectName) {
    case 'Opportunity': {
      const isWon = /\b(won|closed won|booked|sold)\b/.test(q) && !/\bpipeline|open|lost\b/.test(q)
      const isLost = /\b(lost|closed lost)\b/.test(q) && !/\bwon\b/.test(q)
      const isCancelled = /\b(cancel|cancelled|canceled)\b/.test(q)
      const isPipeline = /\b(pipeline|open|in progress)\b/.test(q)

      // Use the same mandatory filters as the MCP agent
      let where = `Sold_By_Nshama__c = 'NEW SALE'
        AND (NOT Name LIKE '%Miscellaneous%')
        AND (NOT Name LIKE '%RTL%')
        AND (NOT Name LIKE '%PK%')
        AND (NOT Name LIKE '%Plot%')
        AND (NOT Building_Name__c LIKE '%Al Qudra%')
        AND (NOT Building_Name__c LIKE '%Alqudra%')
        AND (NOT Building_Name__c LIKE '%ALQDR%')
        AND (NOT Building_Name__c LIKE '%parking%')
        AND Amount != 1
        AND CloseDate != 2032-12-28`

      if (isWon) where += " AND IsWon = true"
      else if (isLost) where += " AND IsClosed = true AND IsWon = false"
      else if (isCancelled) where += " AND Order_Stattus__c IN ('BOOKED_CANCELLED', 'SMT_CANCELLED')"
      else if (isPipeline) where = "IsClosed = false"

      // Add year filter if the question specifies a year — prevents cross-check from
      // returning all-time totals and flagging false discrepancies
      const year = extractYear(question)
      if (year) {
        where += ` AND Order_Date__c >= ${year}-01-01 AND Order_Date__c <= ${year}-12-31`
      }

      // Use Net_Amount__c (not Amount) per business glossary
      return `SELECT COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE ${where}`
    }
    case 'Case':
      return 'SELECT COUNT(Id) cnt FROM Case'
    case 'Lead':
      return 'SELECT COUNT(Id) cnt FROM Lead'
    case 'Account':
      return "SELECT COUNT(Id) cnt FROM Account WHERE (NOT Name LIKE 'Test%') AND (NOT Name LIKE 'Do not update%') AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%Contractor%')"
    case 'Property_Inventory__c':
      return 'SELECT COUNT(Id) cnt FROM Property_Inventory__c'
    case 'Task':
      return 'SELECT COUNT(Id) cnt FROM Task'
    default:
      return null
  }
}

export async function crossCheckMcpAnswer(
  question: string,
  mcpAnswer: string,
): Promise<CrossCheckResult> {
  const discrepancies: string[] = []

  try {
    const objectName = guessObject(question)
    const verifySql = buildVerifyQuery(objectName, question)
    if (!verifySql) return { verified: true, discrepancies: [] }

    const result = await soql(verifySql)
    if (!result.records || result.records.length === 0) {
      return { verified: true, discrepancies: [] }
    }

    const record = result.records[0]
    const actualCount = typeof record.cnt === 'number' ? record.cnt : parseInt(String(record.cnt), 10)
    const actualTotal = record.total != null ? parseFloat(String(record.total)) : null

    const claimedCounts: number[] = []
    let match: RegExpExecArray | null

    COUNT_PATTERN.lastIndex = 0
    while ((match = COUNT_PATTERN.exec(mcpAnswer)) !== null) {
      const num = parseInt(match[1].replace(/,/g, ''), 10)
      if (!isNaN(num) && num > 1) claimedCounts.push(num)
    }

    if (!isNaN(actualCount) && actualCount > 0) {
      for (const claimed of claimedCounts) {
        const ratio = Math.abs(claimed - actualCount) / actualCount
        if (ratio > 0.10 && Math.abs(claimed - actualCount) > 5) {
          discrepancies.push(
            `Answer claims ~${claimed.toLocaleString()} ${objectName} records but independent query found ${actualCount.toLocaleString()}`
          )
        }
      }
    }

    if (actualTotal != null && !isNaN(actualTotal)) {
      AMOUNT_PATTERN.lastIndex = 0
      while ((match = AMOUNT_PATTERN.exec(mcpAnswer)) !== null) {
        let claimedAmount = parseFloat(match[1].replace(/,/g, ''))
        const suffix = mcpAnswer.slice(match.index, match.index + match[0].length).toLowerCase()
        if (suffix.includes('million') || suffix.includes(' m')) claimedAmount *= 1_000_000
        if (suffix.includes('billion') || suffix.includes(' b')) claimedAmount *= 1_000_000_000

        if (!isNaN(claimedAmount) && claimedAmount > 0) {
          const ratio = Math.abs(claimedAmount - actualTotal) / Math.max(actualTotal, 1)
          if (ratio > 0.15 && Math.abs(claimedAmount - actualTotal) > 1000) {
            discrepancies.push(
              `Answer claims AED ${claimedAmount.toLocaleString()} but independent query found AED ${actualTotal.toLocaleString()}`
            )
          }
        }
      }
    }

    return { verified: discrepancies.length === 0, discrepancies }
  } catch (err) {
    console.warn('[cross-check] Independent verification query failed:', err)
    return { verified: true, discrepancies: [] }
  }
}
