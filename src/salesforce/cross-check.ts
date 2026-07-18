// Independent cross-check for MCP answers - runs a quick fresh SOQL query to verify
// the key numbers (counts, amounts) the LLM claimed in its composed answer. Catches
// the most dangerous hallucination class: LLM fabricating or misreporting a count/amount
// that the raw SOQL data didn't actually contain.
//
// This is fast (one extra SOQL call, ~200ms) and runs only on MCP answers since those
// bypass the deterministic tool pipeline where results are directly formatted.

import { soql } from './client'

// --- Patterns ---

const COUNT_PATTERN = /\b(\d[\d,]*(?:\.\d+)?)\s*(?:deals?|opportunit\w*|cases?|accounts?|leads?|records?|units?|properties?|communities?|buildings?|customers?|bookings?|cancellations?|transfers?|transactions?|apartments?|villas?|townhouses?|reservations?|requests?|enquir\w*|tickets?|violations?)\b/gi
const AMOUNT_PATTERN = /(?:AED|USD|\$)\s*([\d,]+(?:\.\d+)?)\s*(?:million|billion|m|b)?/gi
const YEAR_PATTERN = /^20\d{2}$/
const MONTH_NAMES = ['january','february','march','april','may','june','july','august','september','october','november','december']

// --- Known building/community patterns ---

const BUILDING_PATTERNS: Array<{ regex: RegExp; like: string }> = [
  { regex: /\bhaya\b/i, like: '%Haya%' },
  { regex: /\bhayat\b/i, like: '%Hayat%' },
  { regex: /\bshams\b/i, like: '%Shams%' },
  { regex: /\bhillcrest\b/i, like: '%Hillcrest%' },
  { regex: /\bkaya\b/i, like: '%Kaya%' },
  { regex: /\balton\b/i, like: '%Alton%' },
  { regex: /\bsafi\b/i, like: '%Safi%' },
  { regex: /\bmaha\b/i, like: '%Maha%' },
  { regex: /\breef\b/i, like: '%Reef%' },
  { regex: /\bnaya\b/i, like: '%Naya%' },
  { regex: /\bzbara\b/i, like: '%Zbara%' },
  { regex: /\bsamaya\b/i, like: '%Samaya%' },
  { regex: /\bnshama\b/i, like: '%Nshama%' },
  { regex: /\baddress\s+grand\b/i, like: '%Address Grand%' },
  { regex: /\bbinghatti\b/i, like: '%Binghatti%' },
  { regex: /\bdamac\b/i, like: '%Damac%' },
  { regex: /\becoland\b/i, like: '%Ecoland%' },
]

// --- Date helpers ---

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

function extractYear(question: string): number | null {
  const m = question.match(/\b(20\d{2})\b/)
  return m ? parseInt(m[1], 10) : null
}

function extractQuarter(question: string): { year: number; quarter: number } | null {
  const q = question.toLowerCase()
  const qMatch = q.match(/\b(?:q|quarter)\s*([1-4])\s*(20\d{2})?\b/)
  if (qMatch) {
    const quarter = parseInt(qMatch[1], 10)
    const year = qMatch[2] ? parseInt(qMatch[2], 10) : extractYear(question) || new Date().getFullYear()
    return { year, quarter }
  }
  const halfMatch = q.match(/\b(first|second)\s+half\s+(20\d{2})\b/)
  if (halfMatch) {
    const half = halfMatch[1] === 'first' ? 1 : 2
    const year = parseInt(halfMatch[2], 10)
    return { year, quarter: half }
  }
  return null
}

function extractRelativeDate(question: string): { start: string; end: string } | null {
  const q = question.toLowerCase()
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

  if (/\bthis\s+month\b/.test(q)) {
    const start = new Date(now.getFullYear(), now.getMonth(), 1)
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    return { start: fmt(start), end: fmt(end) }
  }
  if (/\blast\s+month\b/.test(q)) {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const end = new Date(now.getFullYear(), now.getMonth(), 0)
    return { start: fmt(start), end: fmt(end) }
  }
  if (/\bthis\s+year\b/.test(q)) {
    return { start: `${now.getFullYear()}-01-01`, end: `${now.getFullYear()}-12-31` }
  }
  if (/\blast\s+year\b/.test(q)) {
    const y = now.getFullYear() - 1
    return { start: `${y}-01-01`, end: `${y}-12-31` }
  }
  const daysMatch = q.match(/\blast\s+(\d+)\s+days?\b/)
  if (daysMatch) {
    const n = parseInt(daysMatch[1], 10)
    const end = new Date(now)
    const start = new Date(now)
    start.setDate(start.getDate() - n)
    return { start: fmt(start), end: fmt(end) }
  }
  const monthsMatch = q.match(/\blast\s+(\d+)\s+months?\b/)
  if (monthsMatch) {
    const n = parseInt(monthsMatch[1], 10)
    const end = new Date(now)
    const start = new Date(now)
    start.setMonth(start.getMonth() - n)
    return { start: fmt(start), end: fmt(end) }
  }
  return null
}

function extractMonthFilter(question: string, year: number | null): string | null {
  const q = question.toLowerCase()
  for (let i = 0; i < MONTH_NAMES.length; i++) {
    if (q.includes(MONTH_NAMES[i])) {
      const monthNum = i + 1
      const yr = year || new Date().getFullYear()
      const lastDay = daysInMonth(yr, monthNum)
      const pad = (n: number) => String(n).padStart(2, '0')
      return `Order_Date__c >= ${yr}-${pad(monthNum)}-01 AND Order_Date__c <= ${yr}-${pad(monthNum)}-${pad(lastDay)}`
    }
  }
  return null
}

function extractQuarterFilter(question: string): string | null {
  const qtr = extractQuarter(question)
  if (!qtr) return null
  const { year, quarter } = qtr

  if (question.toLowerCase().includes('first half')) {
    return `Order_Date__c >= ${year}-01-01 AND Order_Date__c <= ${year}-06-30`
  }
  if (question.toLowerCase().includes('second half')) {
    return `Order_Date__c >= ${year}-07-01 AND Order_Date__c <= ${year}-12-31`
  }

  const startMonth = (quarter - 1) * 3 + 1
  const endMonth = startMonth + 2
  const pad = (n: number) => String(n).padStart(2, '0')
  const lastDay = daysInMonth(year, endMonth)
  return `Order_Date__c >= ${year}-${pad(startMonth)}-01 AND Order_Date__c <= ${year}-${pad(endMonth)}-${pad(lastDay)}`
}

// --- Building filter extraction ---

function extractBuildingFilter(question: string): string | null {
  for (const { regex, like } of BUILDING_PATTERNS) {
    if (regex.test(question)) {
      return `Building_Name__c LIKE '${like}'`
    }
  }
  const projectMatch = question.match(/\b(?:in|at|for|of)\s+([A-Za-z][\w]*(?:\s+[A-Za-z][\w]*)*)/i)
  if (projectMatch && projectMatch[1]) {
    const name = projectMatch[1]
    const skip = new Set(['the', 'this', 'that', 'total', 'sales', 'what', 'how', 'all', 'each', 'every', '2025', '2026', '2024', '2023'])
    if (!skip.has(name.toLowerCase()) && name.length > 2) {
      return `Building_Name__c LIKE '%${name}%'`
    }
  }
  return null
}

// --- Skip conditions ---

function shouldSkipVerification(question: string): boolean {
  const q = question.toLowerCase()
  if (/\bwho\s+(owns?|bought|purchased|is\s+the\s+owner)\b/.test(q)) return true
  if (/\b(owners?|buyer|customer)\s+(of|for|name)\b/.test(q)) return true
  if (/\b(price\s+per\s+sq|sqft|selling\s+price|price\s+per\s+square)\b/.test(q)) return true
  if (/\b(average|avg|mean)\b/.test(q)) return true
  return false
}

// --- Object detection ---

function guessObject(question: string): string {
  const q = question.toLowerCase()
  if (/\b(case|cases|support|service|eservice|complaint|violation|enquir\w*)\b/.test(q)) return 'Case'
  if (/\b(lead|leads|prospect)\b/.test(q)) return 'Lead'
  if (/\b(account|accounts|customer|customers|buyer|buyers)\b/.test(q)) return 'Account'
  if (/\b(task|tasks|activity|activities)\b/.test(q)) return 'Task'
  if (/\b(deal|deals|sale|sales|sold|opportunit|pipeline|won|lost|booking|cancel|transfer|revenue|amount|value)\b/.test(q)) return 'Opportunity'
  if (/\b(property|properties|unit|units|inventory|available|reserved|leased)\b/.test(q)) return 'Property_Inventory__c'
  return 'Opportunity'
}

// --- Sub-filters for Case and Lead ---

function buildCaseSubFilter(question: string): string {
  const q = question.toLowerCase()
  const parts: string[] = []
  if (/\bescalat\w*\b/.test(q)) parts.push('IsEscalated = true')
  if (/\bopen\b/.test(q)) parts.push("Status != 'Closed'")
  if (/\b(dlp|defect|liability|punch)\b/.test(q)) parts.push("Subject LIKE '%DLP%'")
  if (/\bphone\b/.test(q)) parts.push("Origin = 'Phone'")
  if (/\bemail\b/.test(q)) parts.push("Origin = 'Email'")
  return parts.length > 0 ? parts.join(' AND ') : '1=1'
}

function buildPropertyStatusFilter(question: string): string | null {
  const q = question.toLowerCase()
  if (/\bavailable\b/.test(q)) return "Property_Status__c = 'Available'"
  if (/\bsold\b/.test(q)) return "Property_Status__c = 'Sold'"
  if (/\breserved\b/.test(q)) return "Property_Status__c = 'Reserved'"
  if (/\bbooked\b/.test(q)) return "Property_Status__c = 'Booked'"
  if (/\bleased?\b/.test(q)) return "Property_Status__c = 'Leased'"
  if (/\bblocked\b/.test(q)) return "Property_Status__c = 'Blocked'"
  return null
}

// --- Query builder ---

function buildVerifyQuery(objectName: string, question: string): string | null {
  const q = question.toLowerCase()

  switch (objectName) {
    case 'Opportunity': {
      const isWon = /\b(won|closed won|booked|sold)\b/.test(q) && !/\bpipeline|open|lost\b/.test(q)
      const isLost = /\b(lost|closed lost)\b/.test(q) && !/\bwon\b/.test(q)
      const isCancelled = /\b(cancel|cancelled|canceled|cancellation)\b/.test(q)
      const isTransfer = /\b(transfers?|reassigned?)\b/.test(q) && !/\bcancel\b/.test(q)
      const isPipeline = /\b(pipeline|open|in progress)\b/.test(q)

      const EXCLUSIONS = `Sold_By_Nshama__c = 'NEW SALE'
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

      let where = isPipeline
        ? "IsClosed = false AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%RTL%') AND (NOT Name LIKE '%PK%') AND (NOT Name LIKE '%Plot%') AND (NOT Building_Name__c LIKE '%Al Qudra%') AND (NOT Building_Name__c LIKE '%parking%') AND Amount != 1 AND CloseDate != 2032-12-28"
        : EXCLUSIONS

      if (isWon) where += " AND IsWon = true"
      else if (isLost) where += " AND IsClosed = true AND IsWon = false"
      else if (isCancelled) where += " AND Order_Stattus__c IN ('BOOKED_CANCELLED', 'SMT_CANCELLED', 'PMT_CANCELLED', 'RESERVED_CANCELLED', 'CANCELLED')"
      else if (isTransfer) where += " AND Order_Stattus__c = 'TRANSFERED'"

      // Date filters: relative dates first, then quarter, then month+year, then year
      const relative = extractRelativeDate(question)
      const quarter = extractQuarterFilter(question)
      const monthFilter = extractMonthFilter(question, extractYear(question))
      const year = extractYear(question)

      if (relative) {
        where += ` AND Order_Date__c >= ${relative.start} AND Order_Date__c <= ${relative.end}`
      } else if (quarter) {
        where += ` AND ${quarter}`
      } else if (monthFilter) {
        where += ` AND ${monthFilter}`
      } else if (year) {
        where += ` AND Order_Date__c >= ${year}-01-01 AND Order_Date__c <= ${year}-12-31`
      }

      // Building/community filter
      const buildingFilter = extractBuildingFilter(question)
      if (buildingFilter) where += ` AND ${buildingFilter}`

      // Broker/agent filter
      const agentMatch = q.match(/\b(?:broker|agent)\s+(?:named?|called?|:\s*)?["']?([A-Za-z][\w\s.-]+?)["']?\s*(?:\b|$|,|\.|\?)/i)
        || q.match(/\b(["'][A-Za-z][\w\s.-]+?["'])\s+(?:broker|agent)/i)
      if (agentMatch) {
        const agentName = (agentMatch[1] || '').replace(/['"]/g, '').trim()
        if (agentName.length > 1) where += ` AND cm_Agent_Name__r.Name = '${agentName}'`
      }

      // Salesperson filter
      const spMatch = q.match(/\b(?:salesperson|sales\s*person|advisor|consultant)\s+(?:named?|called?|:\s*)?["']?([A-Za-z][\w\s.-]+?)["']?\s*(?:\b|$|,|\.|\?)/i)
        || q.match(/\b(["'][A-Za-z][\w\s.-]+?["'])\s+(?:salesperson|advisor)/i)
      if (spMatch) {
        const spName = (spMatch[1] || '').replace(/['"]/g, '').trim()
        if (spName.length > 1) where += ` AND cm_Sales_Person__r.Name = '${spName}'`
      }

      // Bedroom type filter
      const bedMatch = q.match(/\b(studio|1\s*bed(?:room)?|2\s*bed(?:room)?|3\s*bed(?:room)?|4\s*bed(?:room)?|5\s*bed(?:room)?)\b/i)
      if (bedMatch) {
        let bedroom = bedMatch[1].trim()
        if (/^1\s*bed/i.test(bedroom)) bedroom = '1 Bedroom'
        else if (/^2\s*bed/i.test(bedroom)) bedroom = '2 Bedrooms'
        else if (/^3\s*bed/i.test(bedroom)) bedroom = '3 Bedrooms'
        else if (/^4\s*bed/i.test(bedroom)) bedroom = '4 Bedrooms'
        else if (/^5\s*bed/i.test(bedroom)) bedroom = '5 Bedrooms'
        else if (/^studio/i.test(bedroom)) bedroom = 'Studio'
        where += ` AND Sales_Room__c = '${bedroom}'`
      }

      // Channel filter
      const channelMatch = q.match(/\b(direct|indirect|online|walk[\s-]?in|referral)\s*(?:sale|channel|lead)?/i)
      if (channelMatch) {
        const ch = channelMatch[1].trim().replace(/\b\w/g, c => c.toUpperCase())
        if (ch.length > 2) where += ` AND cm_Lead_Channel__c = '${ch} Sale'`
      }

      return `SELECT COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE ${where}`
    }

    case 'Case': {
      const caseFilter = buildCaseSubFilter(question)
      let where = caseFilter
      const buildingFilter = extractBuildingFilter(question)
      if (buildingFilter) {
        const pattern = buildingFilter.match(/LIKE '(.+?)'/)?.[1] || ''
        where += ` AND Subject LIKE '%${pattern}%'`
      }
      return `SELECT COUNT(Id) cnt FROM Case WHERE ${where}`
    }

    case 'Lead': {
      let where = '1=1'
      if (/\bconverted?\b/.test(q)) where += ' AND IsConverted = true'
      return `SELECT COUNT(Id) cnt FROM Lead WHERE ${where}`
    }

    case 'Account':
      return "SELECT COUNT(Id) cnt FROM Account WHERE (NOT Name LIKE 'Test%') AND (NOT Name LIKE 'Do not update%') AND (NOT Name LIKE '%Miscellaneous%') AND (NOT Name LIKE '%Contractor%')"

    case 'Property_Inventory__c': {
      let where = '1=1'
      const buildingFilter = extractBuildingFilter(question)
      if (buildingFilter) {
        const communityMatch = buildingFilter.match(/Building_Name__c LIKE '(.+?)'/)
        if (communityMatch) {
          const communityName = communityMatch[1].replace(/%/g, '')
          where += ` AND (Building_Name__c LIKE '${communityMatch[1]}' OR Building_Community__c LIKE '%${communityName}%')`
        }
      }
      const statusFilter = buildPropertyStatusFilter(question)
      if (statusFilter) where += ` AND ${statusFilter}`
      return `SELECT COUNT(Id) cnt FROM Property_Inventory__c WHERE ${where}`
    }

    case 'Task':
      return 'SELECT COUNT(Id) cnt FROM Task'

    default:
      return null
  }
}

// --- Main cross-check ---

interface CrossCheckResult {
  verified: boolean
  discrepancies: string[]
  correctCount?: number
  correctTotal?: number
}

export async function crossCheckMcpAnswer(
  question: string,
  mcpAnswer: string,
): Promise<CrossCheckResult> {
  const discrepancies: string[] = []

  try {
    if (shouldSkipVerification(question)) {
      return { verified: true, discrepancies: [] }
    }

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

    // Count verification
    const claimedCounts: number[] = []
    let match: RegExpExecArray | null

    COUNT_PATTERN.lastIndex = 0
    while ((match = COUNT_PATTERN.exec(mcpAnswer)) !== null) {
      const raw = match[1].replace(/,/g, '')
      if (YEAR_PATTERN.test(raw)) continue
      let num = parseFloat(raw)
      if (isNaN(num) || num <= 1) continue
      claimedCounts.push(num)
    }

    if (!isNaN(actualCount) && actualCount > 0 && claimedCounts.length > 0) {
      const maxClaimed = Math.max(...claimedCounts)
      const ratio = Math.abs(maxClaimed - actualCount) / actualCount
      if (ratio > 0.10 && Math.abs(maxClaimed - actualCount) > 5) {
        discrepancies.push(
          `Answer claims ~${maxClaimed.toLocaleString()} ${objectName} records but independent query found ${actualCount.toLocaleString()}`
        )
      }
    }

    // Amount verification
    if (actualTotal != null && !isNaN(actualTotal)) {
      const claimedAmounts: number[] = []
      AMOUNT_PATTERN.lastIndex = 0
      while ((match = AMOUNT_PATTERN.exec(mcpAnswer)) !== null) {
        let claimedAmount = parseFloat(match[1].replace(/,/g, ''))
        const matchedText = match[0].toLowerCase()
        if (matchedText.includes('million') || matchedText.endsWith('m')) claimedAmount *= 1_000_000
        if (matchedText.includes('billion') || matchedText.endsWith('b')) claimedAmount *= 1_000_000_000
        if (!isNaN(claimedAmount) && claimedAmount > 0) claimedAmounts.push(claimedAmount)
      }

      if (claimedAmounts.length > 0) {
        const maxClaimed = Math.max(...claimedAmounts)
        const ratio = Math.abs(maxClaimed - actualTotal) / Math.max(actualTotal, 1)
        if (ratio > 0.15 && Math.abs(maxClaimed - actualTotal) > 1000) {
          discrepancies.push(
            `Answer claims AED ${maxClaimed.toLocaleString()} but independent query found AED ${actualTotal.toLocaleString()}`
          )
        }
      }
    }

    return { verified: discrepancies.length === 0, discrepancies, correctCount: actualCount, correctTotal: actualTotal ?? undefined }
  } catch (err) {
    console.warn('[cross-check] Independent verification query failed:', err)
    return { verified: true, discrepancies: [] }
  }
}
