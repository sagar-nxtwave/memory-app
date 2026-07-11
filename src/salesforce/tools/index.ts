import { soql, type SoqlResult } from '../client'
import { currentYear } from '../today'

export interface ToolResult {
  context: string
  citation: { documentName: string }
}

export interface ToolParam {
  name: string
  type: 'string' | 'number' | 'date' | 'boolean'
  description: string
  required: boolean
  examples?: string[]
}

export interface ToolDefinition {
  name: string
  description: string
  params: ToolParam[]
  keywords: string[]
  execute: (params: Record<string, string | number | boolean | undefined>) => Promise<ToolResult | null>
}

function formatResult(result: SoqlResult, maxRows: number = 50): string {
  if (result.records.length === 0) {
    if (/count\s*\(\s*\)/i.test(JSON.stringify(result))) return `${result.totalSize}`
    return 'No matching records found.'
  }
  const rows = result.records.slice(0, maxRows).map((r) => {
    const { attributes, ...fields } = r as Record<string, unknown>
    void attributes
    return Object.entries(fields)
      .filter(([k]) => k !== 'attributes')
      .map(([k, v]) => {
        // Clean up field names — remove __c, __r suffixes
        const cleanKey = k.replace(/__c$|__r$/, '').replace(/_/g, ' ')
        let val = v
        if (typeof val === 'object' && val !== null) {
          // Handle nested objects (like Account.Name)
          if ((val as Record<string, unknown>).Name) {
            val = (val as Record<string, unknown>).Name
          } else {
            val = JSON.stringify(val)
          }
        }
        return val == null ? '' : `${cleanKey}: ${val}`
      })
      .filter(([k]) => k !== '')
      .join(' | ')
  })
  const more = result.records.length > maxRows
    ? `\n… and ${result.records.length - maxRows} more`
    : ''
  return rows.join('\n')
}

const MONTH_MAP: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3,
  april: 4, apr: 4, may: 5, june: 6, jun: 6,
  july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9,
  october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
}

const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
}

function monthYearDateFilter(field: string, period: string): string | null {
  const p = period.toLowerCase()
  // "jan 2026", "january 2026", "jan-2026", etc.
  const match = p.match(/^(\w+)\s*[-–]?\s*(\d{4})$/)
  if (match) {
    const month = MONTH_MAP[match[1]]
    const year = parseInt(match[2], 10)
    if (month && year) {
      const lastDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month]
      return ` AND ${field} >= ${year}-${String(month).padStart(2, '0')}-01 AND ${field} <= ${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
    }
  }
  // Bare year: "2026", "2025"
  const yearMatch = p.match(/^(\d{4})$/)
  if (yearMatch) {
    const year = parseInt(yearMatch[1], 10)
    if (year >= 2000 && year <= 2100) {
      return ` AND ${field} >= ${year}-01-01 AND ${field} <= ${year}-12-31`
    }
  }
  return null
}

function dateFilter(field: string, period?: string): string {
  if (!period) return ''
  const p = period.toLowerCase()
  if (p === 'today') return ` AND ${field} = TODAY`
  if (p === 'yesterday') return ` AND ${field} = YESTERDAY`
  if (p === 'this week') return ` AND ${field} = THIS_WEEK`
  if (p === 'last week') return ` AND ${field} = LAST_WEEK`
  if (p === 'this month') return ` AND ${field} = THIS_MONTH`
  if (p === 'last month') return ` AND ${field} = LAST_MONTH`
  if (p === 'this quarter') return ` AND ${field} = THIS_QUARTER`
  if (p === 'last quarter') return ` AND ${field} = LAST_QUARTER`
  if (p === 'this year') return ` AND ${field} = THIS_YEAR`
  if (p === 'last year') return ` AND ${field} = LAST_YEAR`
  if (p === 'last 7 days') return ` AND ${field} = LAST_N_DAYS:7`
  if (p === 'last 30 days') return ` AND ${field} = LAST_N_DAYS:30`
  if (p === 'last 90 days') return ` AND ${field} = LAST_N_DAYS:90`
  const abs = monthYearDateFilter(field, period)
  if (abs) return abs
  return ''
}

const SALESFORCE_NOTE = ''

// Tool 1: get-sales-summary
const getSalesSummary: ToolDefinition = {
  name: 'get-sales-summary',
  description: 'Get total sales count and revenue for a time period. Use for "how many deals", "total revenue", "how much did we sell", "what was the total amount".',
  params: [
    { name: 'period', type: 'string', description: 'Time period — relative ("this month", "last quarter", "this year") or absolute ("2026", "jan 2026")', required: false, examples: ['this month', 'last quarter', 'this year', '2026', 'jan 2026', 'last 30 days'] },
    { name: 'stage', type: 'string', description: 'Filter by stage ("won", "lost", "all")', required: false, examples: ['won', 'lost', 'all'] },
  ],
  keywords: ['how many deals', 'total revenue', 'total sales', 'how much', 'total amount', 'revenue', 'total'],
  execute: async (params) => {
    const period = params.period as string | undefined
    const stage = (params.stage as string) || 'won'
    let where = 'WHERE IsClosed = true'
    if (stage === 'won') where += ' AND IsWon = true'
    else if (stage === 'lost') where += ' AND IsWon = false'
    where += dateFilter('CloseDate', period)
    const query = `SELECT COUNT(Id) cnt, SUM(Amount) total FROM Opportunity ${where}`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 2: get-sales-by-building
const getSalesByBuilding: ToolDefinition = {
  name: 'get-sales-by-building',
  description: 'Get sales broken down by building name. Use for "sales by building", "which building has most sales", "revenue by building".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
    { name: 'limit', type: 'number', description: 'Max buildings to return', required: false },
  ],
  keywords: ['sales by building', 'building sales', 'revenue by building', 'which building', 'building breakdown'],
  execute: async (params) => {
    const period = params.period as string | undefined
    const limit = (params.limit as number) || 10
    let where = "WHERE Building_Name__c != null AND StageName = 'Closed Won'"
    where += dateFilter('CloseDate', period)
    const query = `SELECT Building_Name__c, COUNT(Id) cnt, SUM(Amount) total FROM Opportunity ${where} GROUP BY Building_Name__c ORDER BY SUM(Amount) DESC LIMIT ${limit}`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 3: get-sales-by-community
const getSalesByCommunity: ToolDefinition = {
  name: 'get-sales-by-community',
  description: 'Get sales broken down by community/project/location. Use for "sales by community", "which community has most sales", "which location has more sales", "sales in hayat".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
    { name: 'community', type: 'string', description: 'Specific community to filter', required: false },
    { name: 'limit', type: 'number', description: 'Max communities to return', required: false },
  ],
  keywords: ['sales by community', 'community sales', 'which community', 'which location', 'location sales', 'sales by location', 'project sales', 'sales by project', 'hayat', 'shams', 'hillcrest'],
  execute: async (params) => {
    const period = params.period as string | undefined
    const community = params.community as string | undefined
    const limit = (params.limit as number) || 10
    let where = "WHERE Building_Community__c != null AND StageName = 'Closed Won'"
    if (community) where += ` AND Building_Community__c = '${community}'`
    where += dateFilter('CloseDate', period)
    const query = `SELECT Building_Community__c, COUNT(Id) cnt, SUM(Amount) total FROM Opportunity ${where} GROUP BY Building_Community__c ORDER BY SUM(Amount) DESC LIMIT ${limit}`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 4: get-sales-by-person
const getSalesByPerson: ToolDefinition = {
  name: 'get-sales-by-person',
  description: 'Get sales broken down by salesperson. Use for "sales by person", "which salesperson sold most", "top performers", "sales by agent".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
    { name: 'limit', type: 'number', description: 'Max salespeople to return', required: false },
  ],
  keywords: ['sales by person', 'sales by salesperson', 'top performers', 'who sold most', 'sales by agent', 'salesperson', 'top salesperson', 'best performer'],
  execute: async (params) => {
    const period = params.period as string | undefined
    const limit = (params.limit as number) || 10
    let where = "WHERE cm_Sales_Person__r.Name != null AND StageName = 'Closed Won'"
    where += dateFilter('CloseDate', period)
    const query = `SELECT cm_Sales_Person__r.Name, COUNT(Id) cnt, SUM(Amount) total FROM Opportunity ${where} GROUP BY cm_Sales_Person__r.Name ORDER BY SUM(Amount) DESC LIMIT ${limit}`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 5: get-sales-by-channel
const getSalesByChannel: ToolDefinition = {
  name: 'get-sales-by-channel',
  description: 'Get sales broken down by lead channel. Use for "sales by channel", "which channel brings most sales", "direct vs agent sales".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
  ],
  keywords: ['sales by channel', 'channel sales', 'lead channel', 'direct vs agent', 'which channel', 'how did they find'],
  execute: async (params) => {
    const period = params.period as string | undefined
    let where = "WHERE cm_Lead_Channel__c != null AND StageName = 'Closed Won'"
    where += dateFilter('CloseDate', period)
    const query = `SELECT cm_Lead_Channel__c, COUNT(Id) cnt, SUM(Amount) total FROM Opportunity ${where} GROUP BY cm_Lead_Channel__c ORDER BY SUM(Amount) DESC`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 6: get-pipeline
const getPipeline: ToolDefinition = {
  name: 'get-pipeline',
  description: 'Get open deals by stage. Use for "pipeline", "open deals", "deals in progress", "what stages".',
  params: [
    { name: 'community', type: 'string', description: 'Filter by community', required: false },
  ],
  keywords: ['pipeline', 'open deals', 'deals in progress', 'what stages', 'active deals', 'pending'],
  execute: async (params) => {
    const community = params.community as string | undefined
    let where = "WHERE IsClosed = false"
    if (community) where += ` AND Building_Community__c = '${community}'`
    const query = `SELECT StageName, COUNT(Id) cnt, SUM(Amount) total FROM Opportunity ${where} GROUP BY StageName ORDER BY COUNT(Id) DESC`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 7: get-recent-deals
const getRecentDeals: ToolDefinition = {
  name: 'get-recent-deals',
  description: 'Get the latest deals/transactions. Use for "recent deals", "latest sales", "show me recent transactions", "list won opportunities".',
  params: [
    { name: 'limit', type: 'number', description: 'Number of deals to return', required: false },
    { name: 'stage', type: 'string', description: 'Filter by stage ("won", "lost", "all")', required: false },
    { name: 'period', type: 'string', description: 'Time period — relative ("this month", "last year") or absolute ("2026", "jan 2026")', required: false },
  ],
  keywords: ['recent deals', 'latest sales', 'recent transactions', 'show recent', 'latest deals', 'recent orders', 'list those won', 'list won', 'won opportunities', 'list deals'],
  execute: async (params) => {
    const limit = (params.limit as number) || 10
    const stage = (params.stage as string) || 'all'
    const period = params.period as string | undefined
    let where = ''
    if (stage === 'won') where = "WHERE IsWon = true"
    else if (stage === 'lost') where = "WHERE IsWon = false"
    else where = "WHERE 1=1"
    where += dateFilter('CloseDate', period)
    const query = `SELECT Name, StageName, Amount, CloseDate, Building_Name__c, Building_Community__c, cm_Sales_Person__r.Name FROM Opportunity ${where} ORDER BY CreatedDate DESC LIMIT ${limit}`
    console.log(`[salesforce:tool] get-recent-deals executing: ${query}`)
    try {
      const result = await soql(query)
      console.log(`[salesforce:tool] get-recent-deals result: ${result.totalSize} records`)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch (err) {
      console.error(`[salesforce:tool] get-recent-deals failed:`, err)
      return null
    }
  }
}

// Tool 8: lookup-customer
const lookupCustomer: ToolDefinition = {
  name: 'lookup-customer',
  description: 'Look up a customer/account and their deals. Use for "show me customer X", "what did customer Y buy", "account details".',
  params: [
    { name: 'name', type: 'string', description: 'Customer/account name to search', required: true },
  ],
  keywords: ['customer', 'account', 'buyer', 'what did', 'show me', 'lookup', 'find customer'],
  execute: async (params) => {
    const name = params.name as string
    if (!name) return null
    const query = `SELECT Name, StageName, Amount, CloseDate, Building_Name__c, Building_Community__c, cm_Sales_Person__r.Name FROM Opportunity WHERE Account.Name LIKE '%${name}%' ORDER BY CloseDate DESC LIMIT 20`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 9: get-unit-count
const getUnitCount: ToolDefinition = {
  name: 'get-unit-count',
  description: 'Get total units from property inventory. Use for "how many units", "total properties", "unit count".',
  params: [
    { name: 'status', type: 'string', description: 'Filter by status', required: false },
  ],
  keywords: ['how many units', 'total units', 'unit count', 'total properties', 'property count', 'inventory'],
  execute: async (params) => {
    const query = `SELECT COUNT(Id) FROM Property_Inventory__c`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 10: get-cancellations
const getCancellations: ToolDefinition = {
  name: 'get-cancellations',
  description: 'Get cancelled bookings and transferred units. Use for "cancellations", "cancelled deals", "transfers", "how many cancelled".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
    { name: 'type', type: 'string', description: '"cancelled", "transferred", or "all"', required: false },
  ],
  keywords: ['cancellations', 'cancelled', 'transferred', 'cancel', 'transfer', 'how many cancelled'],
  execute: async (params) => {
    const period = params.period as string | undefined
    const type = (params.type as string) || 'all'
    let where = "WHERE Order_Stattus__c IN ('BOOKED_CANCELLED', 'SMT_CANCELLED', 'TRANSFERED')"
    if (type === 'cancelled') where = "WHERE Order_Stattus__c IN ('BOOKED_CANCELLED', 'SMT_CANCELLED')"
    else if (type === 'transferred') where = "WHERE Order_Stattus__c = 'TRANSFERED'"
    const dateClause = dateFilter('CloseDate', period)
    try {
      const countQuery = `SELECT COUNT(Id) cnt FROM Opportunity ${where}${dateClause}`
      const countResult = await soql(countQuery)
      const count = countResult.records[0]?.cnt ?? countResult.totalSize
      const detailQuery = `SELECT Name, StageName, Order_Stattus__c, Amount, CloseDate, Building_Community__c FROM Opportunity ${where}${dateClause} ORDER BY CloseDate DESC LIMIT 50`
      const detailResult = await soql(detailQuery)
      let details = ''
      if (detailResult.records.length > 0) {
        details = '\n\nDetails:\n' + formatResult(detailResult)
      }
      return { context: `Total: ${count}${details}`, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 11: get-sales-by-bedroom
const getSalesByBedroom: ToolDefinition = {
  name: 'get-sales-by-bedroom',
  description: 'Get sales broken down by bedroom count/unit type. Use for "sales by bedroom", "3-bedroom sales", "which unit type sells most", "bedroom breakdown".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
  ],
  keywords: ['sales by bedroom', 'bedroom sales', 'unit type', '3 bedroom', '2 bedroom', 'bedroom breakdown', 'bhk'],
  execute: async (params) => {
    const period = params.period as string | undefined
    let where = "WHERE Sales_Room__c != null AND IsWon = true"
    where += dateFilter('CloseDate', period)
    const query = `SELECT Sales_Room__c, COUNT(Id) cnt, SUM(Amount) total FROM Opportunity ${where} GROUP BY Sales_Room__c ORDER BY SUM(Amount) DESC`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 12: get-sales-by-account
const getSalesByAccount: ToolDefinition = {
  name: 'get-sales-by-account',
  description: 'Get sales broken down by customer/account. Use for "top customers", "revenue by customer", "which customer bought most", "customer ranking".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
    { name: 'limit', type: 'number', description: 'Max accounts to return', required: false },
  ],
  keywords: ['top customers', 'revenue by customer', 'customer ranking', 'which customer', 'account sales', 'buyer ranking', 'customer revenue'],
  execute: async (params) => {
    const period = params.period as string | undefined
    const limit = (params.limit as number) || 10
    let where = "WHERE Account.Name != null AND IsWon = true"
    where += dateFilter('CloseDate', period)
    const query = `SELECT Account.Name, COUNT(Id) cnt, SUM(Amount) total FROM Opportunity ${where} GROUP BY Account.Name ORDER BY SUM(Amount) DESC LIMIT ${limit}`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 13: get-avg-deal-value
const getAvgDealValue: ToolDefinition = {
  name: 'get-avg-deal-value',
  description: 'Get the average deal/sale value. Use for "average deal size", "average sale price", "average transaction value", "mean deal value".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
    { name: 'stage', type: 'string', description: 'Filter by stage ("won", "lost", "all")', required: false },
  ],
  keywords: ['average deal', 'average sale', 'average price', 'mean deal', 'avg deal', 'average transaction', 'average value'],
  execute: async (params) => {
    const period = params.period as string | undefined
    const stage = (params.stage as string) || 'won'
    let where = 'WHERE IsClosed = true'
    if (stage === 'won') where += ' AND IsWon = true'
    else if (stage === 'lost') where += ' AND IsWon = false'
    where += dateFilter('CloseDate', period)
    const query = `SELECT AVG(Amount) avgVal, COUNT(Id) cnt FROM Opportunity ${where}`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 14: get-lost-deals
const getLostDeals: ToolDefinition = {
  name: 'get-lost-deals',
  description: 'Get lost/closed-lost deals. Use for "lost deals", "lost opportunities", "deals we lost", "why are we losing".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
    { name: 'limit', type: 'number', description: 'Max deals to return', required: false },
  ],
  keywords: ['lost deals', 'lost opportunities', 'deals we lost', 'closed lost', 'lost revenue', 'why losing'],
  execute: async (params) => {
    const period = params.period as string | undefined
    const limit = (params.limit as number) || 20
    let where = "WHERE IsClosed = true AND IsWon = false"
    where += dateFilter('CloseDate', period)
    const query = `SELECT Name, Amount, CloseDate, Building_Community__c, cm_Sales_Person__r.Name FROM Opportunity ${where} ORDER BY CloseDate DESC LIMIT ${limit}`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 15: get-leads-summary
const getLeadsSummary: ToolDefinition = {
  name: 'get-leads-summary',
  description: 'Get leads count and status breakdown. Use for "how many leads", "lead summary", "lead status", "leads by status".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
  ],
  keywords: ['how many leads', 'lead summary', 'lead status', 'leads by status', 'total leads', 'lead count', 'unconverted leads'],
  execute: async (params) => {
    const period = params.period as string | undefined
    let where = ''
    if (period) {
      where = 'WHERE ' + dateFilter('CreatedDate', period).replace(/^ AND /, '')
    }
    const countQuery = `SELECT COUNT(Id) cnt FROM Lead ${where}`
    const statusQuery = `SELECT Status, COUNT(Id) cnt FROM Lead ${where} GROUP BY Status ORDER BY COUNT(Id) DESC`
    try {
      const countResult = await soql(countQuery)
      const statusResult = await soql(statusQuery)
      const total = countResult.records[0]?.cnt ?? countResult.totalSize
      const statusBody = formatResult(statusResult)
      return { context: `${SALESFORCE_NOTE}Total leads: ${total}\n\n${statusBody}`, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 16: get-leads-by-source
const getLeadsBySource: ToolDefinition = {
  name: 'get-leads-by-source',
  description: 'Get leads broken down by lead source. Use for "leads by source", "where do leads come from", "lead source breakdown", "which channel brings leads".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
  ],
  keywords: ['leads by source', 'lead source', 'where leads come from', 'lead channel', 'source breakdown', 'lead origin'],
  execute: async (params) => {
    const period = params.period as string | undefined
    let where = 'WHERE LeadSource != null'
    if (period) where += dateFilter('CreatedDate', period)
    const query = `SELECT LeadSource, COUNT(Id) cnt FROM Lead ${where} GROUP BY LeadSource ORDER BY COUNT(Id) DESC`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 17: get-accounts-summary
const getAccountsSummary: ToolDefinition = {
  name: 'get-accounts-summary',
  description: 'Get total account/customer count. Use for "how many customers", "how many accounts", "total customers", "account count".',
  params: [],
  keywords: ['how many customers', 'how many accounts', 'total customers', 'account count', 'customer count', 'total accounts'],
  execute: async () => {
    const query = `SELECT COUNT(Id) cnt FROM Account`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 18: get-tasks-summary
const getTasksSummary: ToolDefinition = {
  name: 'get-tasks-summary',
  description: 'Get tasks count and status breakdown. Use for "how many tasks", "task summary", "pending tasks", "open tasks", "activities".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
  ],
  keywords: ['how many tasks', 'task summary', 'pending tasks', 'open tasks', 'activities', 'task status', 'todo'],
  execute: async (params) => {
    const period = params.period as string | undefined
    let where = ''
    if (period) {
      where = 'WHERE ' + dateFilter('CreatedDate', period).replace(/^ AND /, '')
    }
    const countQuery = `SELECT COUNT(Id) cnt FROM Task ${where}`
    const statusQuery = `SELECT Status, COUNT(Id) cnt FROM Task ${where} GROUP BY Status ORDER BY COUNT(Id) DESC`
    try {
      const countResult = await soql(countQuery)
      const statusResult = await soql(statusQuery)
      const total = countResult.records[0]?.cnt ?? countResult.totalSize
      const statusBody = formatResult(statusResult)
      return { context: `${SALESFORCE_NOTE}Total tasks: ${total}\n\nBreakdown by status:\n${statusBody}`, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 19: get-tasks-open
const getTasksOpen: ToolDefinition = {
  name: 'get-tasks-open',
  description: 'Get open/pending tasks. Use for "open tasks", "pending activities", "overdue tasks", "what needs to be done".',
  params: [
    { name: 'limit', type: 'number', description: 'Max tasks to return', required: false },
  ],
  keywords: ['open tasks', 'pending tasks', 'overdue tasks', 'what needs to be done', 'pending activities', 'unfinished tasks'],
  execute: async (params) => {
    const limit = (params.limit as number) || 20
    const query = `SELECT Subject, Status, Priority, ActivityDate, OwnerId FROM Task WHERE Status != 'Completed' ORDER BY ActivityDate ASC LIMIT ${limit}`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 20: get-case-breakdown-by-type
const getCaseBreakdownByType: ToolDefinition = {
  name: 'get-case-breakdown-by-type',
  description: 'Get cases broken down by type/category. Use for "case types", "types of cases", "what type of cases", "case category breakdown".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
  ],
  keywords: ['case types', 'types of cases', 'case type', 'case category', 'what type', 'case breakdown by type'],
  execute: async (params) => {
    const period = params.period as string | undefined
    let where = ''
    if (period) {
      where = 'WHERE ' + dateFilter('CreatedDate', period).replace(/^ AND /, '')
    }
    const query = `SELECT Type, COUNT(Id) cnt FROM Case ${where} GROUP BY Type ORDER BY COUNT(Id) DESC`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 21: get-case-breakdown-by-status
const getCaseBreakdownByStatus: ToolDefinition = {
  name: 'get-case-breakdown-by-status',
  description: 'Get cases broken down by status. Use for "case status", "open vs closed cases", "case status breakdown", "how many open cases".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
  ],
  keywords: ['case status', 'open cases', 'closed cases', 'case status breakdown', 'open vs closed', 'case status'],
  execute: async (params) => {
    const period = params.period as string | undefined
    let where = ''
    if (period) {
      where = 'WHERE ' + dateFilter('CreatedDate', period).replace(/^ AND /, '')
    }
    const query = `SELECT Status, COUNT(Id) cnt FROM Case ${where} GROUP BY Status ORDER BY COUNT(Id) DESC`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 22: get-case-breakdown-by-priority
const getCaseBreakdownByPriority: ToolDefinition = {
  name: 'get-case-breakdown-by-priority',
  description: 'Get cases broken down by priority. Use for "case priority", "escalated cases", "high priority cases", "case priority breakdown".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
  ],
  keywords: ['case priority', 'escalated cases', 'high priority', 'case priority breakdown', 'urgent cases', 'priority breakdown'],
  execute: async (params) => {
    const period = params.period as string | undefined
    let where = ''
    if (period) {
      where = 'WHERE ' + dateFilter('CreatedDate', period).replace(/^ AND /, '')
    }
    const query = `SELECT Priority, COUNT(Id) cnt FROM Case ${where} GROUP BY Priority ORDER BY COUNT(Id) DESC`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 23: get-property-by-community
const getPropertyByCommunity: ToolDefinition = {
  name: 'get-property-by-community',
  description: 'Get property inventory broken down by community. Use for "units by community", "inventory by location", "property breakdown", "how many units in hayat".',
  params: [
    { name: 'community', type: 'string', description: 'Specific community to filter', required: false },
  ],
  keywords: ['units by community', 'inventory by community', 'property by community', 'inventory breakdown', 'units by location', 'property count by community'],
  execute: async (params) => {
    const community = params.community as string | undefined
    let where = 'WHERE Building_Community__c != null'
    if (community) where += ` AND Building_Community__c = '${community}'`
    const query = `SELECT Building_Community__c, COUNT(Id) cnt FROM Property_Inventory__c ${where} GROUP BY Building_Community__c ORDER BY COUNT(Id) DESC`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 24: get-case-count
const getCaseCount: ToolDefinition = {
  name: 'get-case-count',
  description: 'Get total case count. Use for "how many cases", "total cases", "case count".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
  ],
  keywords: ['how many cases', 'total cases', 'case count', 'number of cases', 'support cases'],
  execute: async (params) => {
    const period = params.period as string | undefined
    let where = ''
    if (period) {
      where = 'WHERE ' + dateFilter('CreatedDate', period).replace(/^ AND /, '')
    }
    const query = `SELECT COUNT(Id) cnt FROM Case ${where}`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool 25: get-sales-by-month
const getSalesByMonth: ToolDefinition = {
  name: 'get-sales-by-month',
  description: 'Get sales broken down by month/year. Use for "sales by month", "monthly sales trend", "which month had most sales", "bookings by month", "monthly revenue".',
  params: [
    { name: 'year', type: 'string', description: 'Year to filter (e.g. "2026", "2025"). If omitted, returns all years.', required: false },
    { name: 'stage', type: 'string', description: 'Filter by stage ("won", "lost", "all")', required: false },
  ],
  keywords: ['sales by month', 'monthly sales', 'monthly trend', 'bookings by month', 'which month', 'monthly revenue', 'monthly bookings'],
  execute: async (params) => {
    const year = params.year as string | undefined
    const stage = (params.stage as string) || 'won'
    let where = "WHERE IsClosed = true"
    if (stage === 'won') where += ' AND IsWon = true'
    else if (stage === 'lost') where += ' AND IsWon = false'
    if (year) where += dateFilter('CloseDate', year)
    const query = `SELECT CALENDAR_MONTH(CloseDate) month, CALENDAR_YEAR(CloseDate) year, COUNT(Id) cnt, SUM(Amount) total FROM Opportunity ${where} GROUP BY CALENDAR_YEAR(CloseDate), CALENDAR_MONTH(CloseDate) ORDER BY CALENDAR_YEAR(CloseDate), CALENDAR_MONTH(CloseDate)`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 26: get-win-rate
const getWinRate: ToolDefinition = {
  name: 'get-win-rate',
  description: 'Get win rate (won vs lost vs total). Use for "win rate", "what percentage of deals do we win", "conversion rate", "how many won vs lost".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
  ],
  keywords: ['win rate', 'conversion rate', 'won vs lost', 'percentage won', 'win percentage', 'how many won'],
  execute: async (params) => {
    const period = params.period as string | undefined
    let where = 'WHERE IsClosed = true'
    where += dateFilter('CloseDate', period)
    const query = `SELECT IsWon, COUNT(Id) cnt, SUM(Amount) total FROM Opportunity ${where} GROUP BY IsWon`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 27: get-sales-by-source
const getSalesBySource: ToolDefinition = {
  name: 'get-sales-by-source',
  description: 'Get sales broken down by LeadSource. Use for "sales by source", "which source brings most sales", "referral vs website", "lead source performance".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
    { name: 'limit', type: 'number', description: 'Max sources to return', required: false },
  ],
  keywords: ['sales by source', 'lead source performance', 'which source', 'referral sales', 'website sales', 'source breakdown'],
  execute: async (params) => {
    const period = params.period as string | undefined
    const limit = (params.limit as number) || 15
    let where = "WHERE LeadSource != null AND IsWon = true"
    where += dateFilter('CloseDate', period)
    const query = `SELECT LeadSource, COUNT(Id) cnt, SUM(Amount) total FROM Opportunity ${where} GROUP BY LeadSource ORDER BY SUM(Amount) DESC LIMIT ${limit}`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 28: get-property-status-breakdown
const getPropertyStatusBreakdown: ToolDefinition = {
  name: 'get-property-status-breakdown',
  description: 'Get inventory units broken down by status (Available, Reserved, Booked, Sold, Blocked, Leased, Online Blocked). Use for "how many available units", "sold vs available", "inventory status", "units by status".',
  params: [
    { name: 'community', type: 'string', description: 'Filter by community', required: false },
  ],
  keywords: ['inventory status', 'available units', 'sold units', 'units by status', 'how many available', 'how many sold', 'reserved units', 'leased units'],
  execute: async (params) => {
    const community = params.community as string | undefined
    let where = 'WHERE Property_Status__c != null'
    if (community) where += ` AND Building_Community__c = '${community}'`
    const query = `SELECT Property_Status__c, COUNT(Id) cnt FROM Property_Inventory__c ${where} GROUP BY Property_Status__c ORDER BY COUNT(Id) DESC`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 29: get-property-by-type
const getPropertyByType: ToolDefinition = {
  name: 'get-property-by-type',
  description: 'Get inventory units broken down by physical type (Villa, Apartment, Townhouse, etc). Use for "how many villas", "units by type", "villas vs apartments", "property type breakdown".',
  params: [
    { name: 'status', type: 'string', description: 'Filter by status (e.g. "Available", "Sold")', required: false },
  ],
  keywords: ['units by type', 'how many villas', 'how many apartments', 'villas vs apartments', 'property type', 'townhouse', 'physical type'],
  execute: async (params) => {
    const status = params.status as string | undefined
    let where = 'WHERE Type__c != null'
    if (status) where += ` AND Property_Status__c = '${status}'`
    const query = `SELECT Type__c, COUNT(Id) cnt FROM Property_Inventory__c ${where} GROUP BY Type__c ORDER BY COUNT(Id) DESC`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 30: get-inventory-pricing
const getInventoryPricing: ToolDefinition = {
  name: 'get-inventory-pricing',
  description: 'Get inventory pricing summary (average selling price, price per sq ft). Use for "average price", "price per square foot", "inventory value", "average selling price".',
  params: [
    { name: 'status', type: 'string', description: 'Filter by status (e.g. "Available", "Sold")', required: false },
    { name: 'community', type: 'string', description: 'Filter by community', required: false },
    { name: 'type', type: 'string', description: 'Filter by property type (Villa, Apartment, Townhouse)', required: false },
  ],
  keywords: ['average price', 'price per square foot', 'inventory value', 'average selling price', 'avg price', 'pricing'],
  execute: async (params) => {
    const status = params.status as string | undefined
    const community = params.community as string | undefined
    const type = params.type as string | undefined
    let where = 'WHERE Selling_Price__c != null'
    if (status) where += ` AND Property_Status__c = '${status}'`
    if (community) where += ` AND Building_Community__c = '${community}'`
    if (type) where += ` AND Type__c = '${type}'`
    const query = `SELECT AVG(Selling_Price__c) avgPrice, AVG(Selling_Price_Per_Sq_Ft__c) avgPricePerSqFt, COUNT(Id) cnt FROM Property_Inventory__c ${where}`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 31: get-case-breakdown-by-origin
const getCaseBreakdownByOrigin: ToolDefinition = {
  name: 'get-case-breakdown-by-origin',
  description: 'Get cases broken down by intake channel (Phone, Email, Web, etc). Use for "cases by channel", "how do customers contact us", "phone vs email cases", "case origin breakdown".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
  ],
  keywords: ['cases by origin', 'cases by channel', 'case origin', 'phone cases', 'email cases', 'web cases', 'how do customers contact'],
  execute: async (params) => {
    const period = params.period as string | undefined
    let where = 'WHERE Origin != null'
    if (period) where += dateFilter('CreatedDate', period)
    const query = `SELECT Origin, COUNT(Id) cnt FROM Case ${where} GROUP BY Origin ORDER BY COUNT(Id) DESC`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 32: get-case-count-by-eservice
const getCaseCountByEservice: ToolDefinition = {
  name: 'get-case-count-by-eservice',
  description: 'Get cases broken down by eService/service category. Use for "cases by service", "service categories", "which service has most cases", "registration cases", "transfer cases", "move-in cases".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
    { name: 'limit', type: 'number', description: 'Max categories to return', required: false },
  ],
  keywords: ['cases by service', 'service categories', 'eservice', 'registration cases', 'transfer cases', 'move-in', 'tenant registration', 'mortgage registration'],
  execute: async (params) => {
    const period = params.period as string | undefined
    const limit = (params.limit as number) || 20
    let where = 'WHERE eService_Admin_Name__c != null'
    if (period) where += dateFilter('CreatedDate', period)
    const query = `SELECT eService_Admin_Name__c, COUNT(Id) cnt FROM Case ${where} GROUP BY eService_Admin_Name__c ORDER BY COUNT(Id) DESC LIMIT ${limit}`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 33: get-case-count-by-record-type
const getCaseCountByRecordType: ToolDefinition = {
  name: 'get-case-count-by-record-type',
  description: 'Get cases broken down by RecordType (Contact Centre vs others). Use for "cases by record type", "contact centre cases", "case classification".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
  ],
  keywords: ['cases by record type', 'contact centre cases', 'case classification', 'record type breakdown'],
  execute: async (params) => {
    const period = params.period as string | undefined
    let where = 'WHERE RecordType.Name != null'
    if (period) where += dateFilter('CreatedDate', period)
    const query = `SELECT RecordType.Name, COUNT(Id) cnt FROM Case ${where} GROUP BY RecordType.Name ORDER BY COUNT(Id) DESC`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 34: get-leads-conversion
const getLeadsConversion: ToolDefinition = {
  name: 'get-leads-conversion',
  description: 'Get lead conversion stats (converted vs unconverted). Use for "lead conversion rate", "how many leads converted", "unconverted leads", "leads conversion".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
  ],
  keywords: ['lead conversion', 'conversion rate', 'unconverted leads', 'converted leads', 'how many leads converted'],
  execute: async (params) => {
    const period = params.period as string | undefined
    let where = ''
    if (period) where = 'WHERE ' + dateFilter('CreatedDate', period).replace(/^ AND /, '')
    const query = `SELECT IsConverted, COUNT(Id) cnt FROM Lead ${where} GROUP BY IsConverted`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 35: get-mortgage-status
const getMortgageStatus: ToolDefinition = {
  name: 'get-mortgage-status',
  description: 'Get opportunities broken down by mortgage status. Use for "mortgage status", "how many mortgaged", "not mortgaged", "terminated mortgages", "mortgage breakdown".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
  ],
  keywords: ['mortgage status', 'mortgaged', 'not mortgaged', 'terminated mortgage', 'mortgage breakdown', 'valid mortgage'],
  execute: async (params) => {
    const period = params.period as string | undefined
    let where = "WHERE Current_Mortgage_Status__c != null AND IsWon = true"
    where += dateFilter('CloseDate', period)
    const query = `SELECT Current_Mortgage_Status__c, COUNT(Id) cnt FROM Opportunity ${where} GROUP BY Current_Mortgage_Status__c ORDER BY COUNT(Id) DESC`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 36: get-milestone-status
const getMilestoneStatus: ToolDefinition = {
  name: 'get-milestone-status',
  description: 'Get opportunities broken down by milestone/handover status. Use for "handover status", "milestone status", "how many completed handover", "properties ready for handover".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
    { name: 'limit', type: 'number', description: 'Max milestones to return', required: false },
  ],
  keywords: ['milestone status', 'handover status', 'completed handover', 'ready for inspection', 'deep cleaning', 'key release', 'customer informed', 'blocked by legal'],
  execute: async (params) => {
    const period = params.period as string | undefined
    const limit = (params.limit as number) || 20
    let where = "WHERE Milestone_Current_Status__c != null AND IsWon = true"
    where += dateFilter('CloseDate', period)
    const query = `SELECT Milestone_Current_Status__c, COUNT(Id) cnt FROM Opportunity ${where} GROUP BY Milestone_Current_Status__c ORDER BY COUNT(Id) DESC LIMIT ${limit}`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 37: get-sales-by-agency
const getSalesByAgency: ToolDefinition = {
  name: 'get-sales-by-agency',
  description: 'Get sales broken down by agency. Use for "sales by agency", "which agency has most sales", "agency performance", "agency ranking".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
    { name: 'limit', type: 'number', description: 'Max agencies to return', required: false },
  ],
  keywords: ['sales by agency', 'agency performance', 'which agency', 'agency ranking', 'agency sales'],
  execute: async (params) => {
    const period = params.period as string | undefined
    const limit = (params.limit as number) || 10
    let where = "WHERE cm_Agency_Name__r.Name != null AND IsWon = true"
    where += dateFilter('CloseDate', period)
    const query = `SELECT cm_Agency_Name__r.Name, COUNT(Id) cnt, SUM(Amount) total FROM Opportunity ${where} GROUP BY cm_Agency_Name__r.Name ORDER BY SUM(Amount) DESC LIMIT ${limit}`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 38: get-sales-by-agent
const getSalesByAgent: ToolDefinition = {
  name: 'get-sales-by-agent',
  description: 'Get sales broken down by external agent/broker. Use for "sales by agent", "which agent sold most", "agent performance", "broker ranking".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
    { name: 'limit', type: 'number', description: 'Max agents to return', required: false },
  ],
  keywords: ['sales by agent', 'agent performance', 'which agent', 'agent ranking', 'broker performance', 'broker sales'],
  execute: async (params) => {
    const period = params.period as string | undefined
    const limit = (params.limit as number) || 10
    let where = "WHERE cm_Agent_Name__r.Name != null AND IsWon = true"
    where += dateFilter('CloseDate', period)
    const query = `SELECT cm_Agent_Name__r.Name, COUNT(Id) cnt, SUM(Amount) total FROM Opportunity ${where} GROUP BY cm_Agent_Name__r.Name ORDER BY SUM(Amount) DESC LIMIT ${limit}`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 39: get-booking-trend
const getBookingTrend: ToolDefinition = {
  name: 'get-booking-trend',
  description: 'Get booking trend using Property_Booked_Date__c (more accurate than CloseDate). Use for "booking trend", "when were properties booked", "bookings by month", "booking patterns".',
  params: [
    { name: 'year', type: 'string', description: 'Year to filter', required: false },
  ],
  keywords: ['booking trend', 'booking date', 'bookings by month', 'when booked', 'booking pattern', 'property booked'],
  execute: async (params) => {
    const year = params.year as string | undefined
    let where = "WHERE Property_Booked_Date__c != null"
    if (year) where += dateFilter('Property_Booked_Date__c', year)
    const query = `SELECT CALENDAR_MONTH(Property_Booked_Date__c) month, CALENDAR_YEAR(Property_Booked_Date__c) year, COUNT(Id) cnt, SUM(Amount) total FROM Opportunity ${where} GROUP BY CALENDAR_YEAR(Property_Booked_Date__c), CALENDAR_MONTH(Property_Booked_Date__c) ORDER BY CALENDAR_YEAR(Property_Booked_Date__c), CALENDAR_MONTH(Property_Booked_Date__c)`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 40: get-top-customers-by-transaction
const getTopCustomersByTransaction: ToolDefinition = {
  name: 'get-top-customers-by-transaction',
  description: 'Get customers ranked by number of transactions. Use for "which customer has most properties", "customers with multiple transactions", "repeat buyers".',
  params: [
    { name: 'minTransactions', type: 'number', description: 'Minimum number of transactions (default 1)', required: false },
    { name: 'limit', type: 'number', description: 'Max customers to return', required: false },
  ],
  keywords: ['top customers', 'most transactions', 'repeat buyers', 'customers with most properties', 'multiple transactions'],
  execute: async (params) => {
    const minTransactions = (params.minTransactions as number) || 1
    const limit = (params.limit as number) || 10
    const query = `SELECT Account.Name, COUNT(Id) cnt, SUM(Amount) total FROM Opportunity WHERE Account.Name != null AND IsWon = true GROUP BY Account.Name HAVING COUNT(Id) >= ${minTransactions} ORDER BY COUNT(Id) DESC LIMIT ${limit}`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 41: get-account-by-type
const getAccountByType: ToolDefinition = {
  name: 'get-account-by-type',
  description: 'Get accounts broken down by RecordType (Individual/Corporate/Retail). Use for "how many individual customers", "corporate vs retail", "customer type breakdown".',
  params: [],
  keywords: ['customer type', 'individual customers', 'corporate customers', 'retail customers', 'account type', 'individual vs corporate'],
  execute: async () => {
    const query = `SELECT RecordType.Name, COUNT(Id) cnt FROM Account WHERE RecordType.Name != null GROUP BY RecordType.Name ORDER BY COUNT(Id) DESC`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 42: get-cancellations-by-community
const getCancellationsByCommunity: ToolDefinition = {
  name: 'get-cancellations-by-community',
  description: 'Get cancellations/transfers broken down by community. Use for "cancellations by community", "which community has most cancellations", "transfer by location".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
    { name: 'type', type: 'string', description: '"cancelled", "transferred", or "all"', required: false },
  ],
  keywords: ['cancellations by community', 'cancelled by location', 'transfer by community', 'which community cancelled', 'cancellation by project'],
  execute: async (params) => {
    const period = params.period as string | undefined
    const type = (params.type as string) || 'all'
    let where = "WHERE Order_Stattus__c IN ('BOOKED_CANCELLED', 'SMT_CANCELLED', 'TRANSFERED') AND Building_Community__c != null"
    if (type === 'cancelled') where = "WHERE Order_Stattus__c IN ('BOOKED_CANCELLED', 'SMT_CANCELLED') AND Building_Community__c != null"
    else if (type === 'transferred') where = "WHERE Order_Stattus__c = 'TRANSFERED' AND Building_Community__c != null"
    where += dateFilter('CloseDate', period)
    const query = `SELECT Building_Community__c, COUNT(Id) cnt FROM Opportunity ${where} GROUP BY Building_Community__c ORDER BY COUNT(Id) DESC`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTACT TOOLS
// ─────────────────────────────────────────────────────────────────────────────

// Tool 43: get-contact-by-account
const getContactByAccount: ToolDefinition = {
  name: 'get-contact-by-account',
  description: 'Get contacts linked to a customer/account. Use for "show me contacts for this customer", "who are the contacts at this account", "contact details for customer X".',
  params: [
    { name: 'accountName', type: 'string', description: 'Account name to search', required: true },
  ],
  keywords: ['contact for', 'contacts at', 'contact details', 'who is the contact', 'contact person', 'contact for customer', 'contacts for account'],
  execute: async (params) => {
    const name = params.accountName as string
    if (!name) return null
    const query = `SELECT Id, Name, FirstName, LastName, Email, Phone, Title, AccountId FROM Contact WHERE Account.Name LIKE '%${name}%' LIMIT 20`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 44: get-contact-by-name
const getContactByName: ToolDefinition = {
  name: 'get-contact-by-name',
  description: 'Look up a contact by name. Use for "find contact John", "show me contact details for Sarah", "lookup contact".',
  params: [
    { name: 'name', type: 'string', description: 'Contact name to search', required: true },
  ],
  keywords: ['find contact', 'lookup contact', 'contact details', 'show me contact', 'contact named', 'contact person named'],
  execute: async (params) => {
    const name = params.name as string
    if (!name) return null
    const query = `SELECT Id, Name, FirstName, LastName, Email, Phone, Title, Account.Name FROM Contact WHERE Name LIKE '%${name}%' LIMIT 20`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 45: get-contacts-summary
const getContactsSummary: ToolDefinition = {
  name: 'get-contacts-summary',
  description: 'Get total contact count. Use for "how many contacts", "total contacts", "contact count".',
  params: [],
  keywords: ['how many contacts', 'total contacts', 'contact count', 'number of contacts'],
  execute: async () => {
    const query = `SELECT COUNT(Id) cnt FROM Contact`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LEAD TOOLS (enhanced beyond basic summary/source)
// ─────────────────────────────────────────────────────────────────────────────

// Tool 46: get-lead-by-account
const getLeadByAccount: ToolDefinition = {
  name: 'get-lead-by-account',
  description: 'Get leads that converted to a specific account/opportunity. Use for "which leads converted to this customer", "lead history for this account", "converted leads for customer X".',
  params: [
    { name: 'accountName', type: 'string', description: 'Account name to search', required: true },
  ],
  keywords: ['leads for', 'converted leads', 'lead history', 'which leads', 'lead for customer', 'leads converted to'],
  execute: async (params) => {
    const name = params.accountName as string
    if (!name) return null
    const query = `SELECT Id, Name, Company, Status, IsConverted, ConvertedAccountId, ConvertedOpportunityId, LeadSource, CreatedDate FROM Lead WHERE ConvertedAccountId IN (SELECT Id FROM Account WHERE Name LIKE '%${name}%') LIMIT 20`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 47: get-lead-by-name
const getLeadByName: ToolDefinition = {
  name: 'get-lead-by-name',
  description: 'Look up a lead by name. Use for "find lead John", "show me lead details", "lookup lead named Sarah".',
  params: [
    { name: 'name', type: 'string', description: 'Lead name to search', required: true },
  ],
  keywords: ['find lead', 'lookup lead', 'lead details', 'show me lead', 'lead named'],
  execute: async (params) => {
    const name = params.name as string
    if (!name) return null
    const query = `SELECT Id, Name, Company, Status, Email, Phone, LeadSource, IsConverted, ConvertedAccountId FROM Lead WHERE Name LIKE '%${name}%' LIMIT 20`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 48: get-lead-by-status
const getLeadByStatus: ToolDefinition = {
  name: 'get-lead-by-status',
  description: 'Get leads broken down by status. Use for "leads by status", "how many open leads", "lead pipeline", "lead status breakdown".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
  ],
  keywords: ['leads by status', 'lead status', 'lead pipeline', 'open leads', 'status breakdown', 'lead stages'],
  execute: async (params) => {
    const period = params.period as string | undefined
    let where = ''
    if (period) where = 'WHERE ' + dateFilter('CreatedDate', period).replace(/^ AND /, '')
    const query = `SELECT Status, COUNT(Id) cnt FROM Lead ${where} GROUP BY Status ORDER BY COUNT(Id) DESC`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TASK TOOLS (enhanced beyond basic summary/open)
// ─────────────────────────────────────────────────────────────────────────────

// Tool 49: get-tasks-by-account
const getTasksByAccount: ToolDefinition = {
  name: 'get-tasks-by-account',
  description: 'Get tasks/activities linked to a customer/account or opportunity. Use for "tasks for this customer", "activities for customer X", "what tasks are linked to this account".',
  params: [
    { name: 'accountName', type: 'string', description: 'Account name to search', required: true },
    { name: 'limit', type: 'number', description: 'Max tasks to return', required: false },
  ],
  keywords: ['tasks for', 'activities for', 'task for customer', 'activities for account', 'tasks linked to'],
  execute: async (params) => {
    const name = params.accountName as string
    const limit = (params.limit as number) || 20
    if (!name) return null
    const query = `SELECT Id, Subject, Status, Priority, ActivityDate, WhatId, WhoId, OwnerId FROM Task WHERE WhatId IN (SELECT Id FROM Account WHERE Name LIKE '%${name}%') OR WhatId IN (SELECT Id FROM Opportunity WHERE Account.Name LIKE '%${name}%') ORDER BY ActivityDate DESC LIMIT ${limit}`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 50: get-tasks-by-case
const getTasksByCase: ToolDefinition = {
  name: 'get-tasks-by-case',
  description: 'Get tasks linked to a case. Use for "tasks for this case", "activities on case X", "what tasks are on this case".',
  params: [
    { name: 'caseNumber', type: 'string', description: 'Case number to search', required: true },
  ],
  keywords: ['tasks for case', 'activities on case', 'tasks linked to case', 'case tasks'],
  execute: async (params) => {
    const caseNum = params.caseNumber as string
    if (!caseNum) return null
    const query = `SELECT Id, Subject, Status, Priority, ActivityDate, WhatId, OwnerId FROM Task WHERE WhatId IN (SELECT Id FROM Case WHERE CaseNumber = '${caseNum}') ORDER BY ActivityDate DESC LIMIT 20`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 51: get-tasks-by-owner
const getTasksByOwner: ToolDefinition = {
  name: 'get-tasks-by-owner',
  description: 'Get tasks broken down by owner/assignee. Use for "tasks by person", "who has most tasks", "task assignment", "tasks by owner".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
    { name: 'limit', type: 'number', description: 'Max owners to return', required: false },
  ],
  keywords: ['tasks by owner', 'tasks by person', 'who has most tasks', 'task assignment', 'tasks by assignee', 'who has most pending tasks'],
  execute: async (params) => {
    const period = params.period as string | undefined
    const limit = (params.limit as number) || 10
    let where = ''
    if (period) where = 'WHERE ' + dateFilter('CreatedDate', period).replace(/^ AND /, '')
    const query = `SELECT OwnerId, COUNT(Id) cnt FROM Task ${where} GROUP BY OwnerId ORDER BY COUNT(Id) DESC LIMIT ${limit}`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 52: get-tasks-by-status
const getTasksByStatus: ToolDefinition = {
  name: 'get-tasks-by-status',
  description: 'Get tasks broken down by status. Use for "tasks by status", "completed vs pending tasks", "task status breakdown", "how many tasks completed".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
  ],
  keywords: ['tasks by status', 'completed tasks', 'pending tasks', 'task status', 'tasks completed', 'how many tasks completed'],
  execute: async (params) => {
    const period = params.period as string | undefined
    let where = ''
    if (period) where = 'WHERE ' + dateFilter('CreatedDate', period).replace(/^ AND /, '')
    const query = `SELECT Status, COUNT(Id) cnt FROM Task ${where} GROUP BY Status ORDER BY COUNT(Id) DESC`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 53: get-tasks-overdue
const getTasksOverdue: ToolDefinition = {
  name: 'get-tasks-overdue',
  description: 'Get overdue tasks (past due date, not completed). Use for "overdue tasks", "past due tasks", "tasks past deadline", "what is overdue".',
  params: [
    { name: 'limit', type: 'number', description: 'Max tasks to return', required: false },
  ],
  keywords: ['overdue tasks', 'past due', 'tasks past deadline', 'what is overdue', 'late tasks', 'missed tasks'],
  execute: async (params) => {
    const limit = (params.limit as number) || 20
    const query = `SELECT Id, Subject, Status, Priority, ActivityDate, OwnerId FROM Task WHERE ActivityDate < TODAY AND Status != 'Completed' ORDER BY ActivityDate ASC LIMIT ${limit}`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 54: get-tasks-by-priority
const getTasksByPriority: ToolDefinition = {
  name: 'get-tasks-by-priority',
  description: 'Get tasks broken down by priority. Use for "tasks by priority", "high priority tasks", "urgent tasks", "task priority breakdown".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
  ],
  keywords: ['tasks by priority', 'high priority tasks', 'urgent tasks', 'priority breakdown', 'task priority'],
  execute: async (params) => {
    const period = params.period as string | undefined
    let where = ''
    if (period) where = 'WHERE ' + dateFilter('CreatedDate', period).replace(/^ AND /, '')
    const query = `SELECT Priority, COUNT(Id) cnt FROM Task ${where} GROUP BY Priority ORDER BY COUNT(Id) DESC`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 55: get-cases-for-deal
const getCasesForDeal: ToolDefinition = {
  name: 'get-cases-for-deal',
  description: 'Get support cases linked to a specific deal/opportunity. Use for "cases for deal X", "support tickets for this sale", "any issues with this deal".',
  params: [
    { name: 'deal_name', type: 'string', description: 'Deal/opportunity name or number (e.g. "TS LXT-5-515")', required: true },
  ],
  keywords: ['cases for deal', 'support for deal', 'issues with deal', 'tickets for opportunity', 'case for sale'],
  execute: async (params) => {
    const dealName = (params.deal_name as string).replace(/'/g, "")
    // Step 1: Find the opportunity ID
    const oppResult = await soql(`SELECT Id FROM Opportunity WHERE Name LIKE '%${dealName}%' LIMIT 1`)
    if (oppResult.records.length === 0) return { context: `No deal found matching "${dealName}".`, citation: { documentName: 'Salesforce (live CRM)' } }
    const oppId = oppResult.records[0].Id
    // Step 2: Find cases linked via Opportunity_Name__c or New_Opportunity__c
    try {
      const r1 = await soql(`SELECT CaseNumber, Subject, Status, Priority, Type, CreatedDate FROM Case WHERE Opportunity_Name__c = '${oppId}' ORDER BY CreatedDate DESC LIMIT 20`)
      if (r1.records.length > 0) return { context: `Cases for deal "${dealName}":\n${formatResult(r1)}`, citation: { documentName: 'Salesforce (live CRM)' } }
      const r2 = await soql(`SELECT CaseNumber, Subject, Status, Priority, Type, CreatedDate FROM Case WHERE New_Opportunity__c = '${oppId}' ORDER BY CreatedDate DESC LIMIT 20`)
      if (r2.records.length > 0) return { context: `Cases for deal "${dealName}":\n${formatResult(r2)}`, citation: { documentName: 'Salesforce (live CRM)' } }
      return { context: `No cases found for deal "${dealName}".`, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 56: get-tasks-for-deal
const getTasksForDeal: ToolDefinition = {
  name: 'get-tasks-for-deal',
  description: 'Get tasks/activities linked to a specific deal/opportunity. Use for "tasks for deal X", "activities for this sale", "what happened with this deal".',
  params: [
    { name: 'deal_name', type: 'string', description: 'Deal/opportunity name or number', required: true },
  ],
  keywords: ['tasks for deal', 'activities for deal', 'what happened with deal', 'follow up on deal', 'calls for deal'],
  execute: async (params) => {
    const dealName = (params.deal_name as string).replace(/'/g, "")
    // Step 1: Find the opportunity ID
    const oppResult = await soql(`SELECT Id FROM Opportunity WHERE Name LIKE '%${dealName}%' LIMIT 1`)
    if (oppResult.records.length === 0) return { context: `No deal found matching "${dealName}".`, citation: { documentName: 'Salesforce (live CRM)' } }
    const oppId = oppResult.records[0].Id
    // Step 2: Find tasks linked to this opportunity
    try {
      const result = await soql(`SELECT Subject, Status, Priority, ActivityDate, Type, Description FROM Task WHERE WhatId = '${oppId}' ORDER BY ActivityDate DESC LIMIT 20`)
      if (result.records.length === 0) return { context: `No tasks found for deal "${dealName}".`, citation: { documentName: 'Salesforce (live CRM)' } }
      return { context: `Tasks for deal "${dealName}":\n${formatResult(result)}`, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 57: get-deal-financials
const getDealFinancials: ToolDefinition = {
  name: 'get-deal-financials',
  description: 'Get full financial breakdown for a deal. Use for "payment details for deal X", "financial summary", "DLD fees", "deposit status", "how much paid".',
  params: [
    { name: 'deal_name', type: 'string', description: 'Deal/opportunity name or number', required: true },
  ],
  keywords: ['financial', 'payment', 'DLD', 'deposit', 'fees', 'how much paid', 'outstanding', 'receipt', 'financial breakdown'],
  execute: async (params) => {
    const dealName = params.deal_name as string
    const query = `SELECT Name, Amount, Net_Amount__c, cm_Cash_Amount__c, DLD_Amount__c, DLD_Received__c, DLD_Balance__c, DP_Amount__c, DP_Received__c, DP_Balance__c, Service_Fees__c, Service_Fee_Amount__c, Service_Fee_Outstanding__c, Authority_Fees__c, Mortgage_Amount_AED__c, Total_Payments__c, Receipt_On_Account_Amount__c, Down_payment_receipt_amount__c, Security_Cheque_Amount__c, Late_Payment_Fees__c FROM Opportunity WHERE Name LIKE '%${dealName.replace(/'/g, "")}%' LIMIT 1`
    try {
      const result = await soql(query)
      if (result.records.length === 0) return { context: `No deal found matching "${dealName}".`, citation: { documentName: 'Salesforce (live CRM)' } }
      const r = result.records[0]
      const lines: string[] = []
      lines.push(`Financial Summary: ${r.Name}`)
      lines.push(`  Deal Amount: AED ${Number(r.Amount ?? 0).toLocaleString()}`)
      lines.push(`  Net Amount: AED ${Number(r.Net_Amount__c ?? 0).toLocaleString()}`)
      lines.push(`  Cash Amount: AED ${Number(r.cm_Cash_Amount__c ?? 0).toLocaleString()}`)
      lines.push(`  DLD: AED ${Number(r.DLD_Amount__c ?? 0).toLocaleString()} (Received: ${Number(r.DLD_Received__c ?? 0).toLocaleString()}, Balance: ${Number(r.DLD_Balance__c ?? 0).toLocaleString()})`)
      lines.push(`  Down Payment: AED ${Number(r.DP_Amount__c ?? 0).toLocaleString()} (Received: ${Number(r.DP_Received__c ?? 0).toLocaleString()}, Balance: ${Number(r.DP_Balance__c ?? 0).toLocaleString()})`)
      lines.push(`  Service Fees: ${Number(r.Service_Fees__c ?? 0).toLocaleString()} (Amount: AED ${Number(r.Service_Fee_Amount__c ?? 0).toLocaleString()}, Outstanding: AED ${Number(r.Service_Fee_Outstanding__c ?? 0).toLocaleString()})`)
      lines.push(`  Authority Fees: AED ${Number(r.Authority_Fees__c ?? 0).toLocaleString()}`)
      lines.push(`  Mortgage: AED ${Number(r.Mortgage_Amount_AED__c ?? 0).toLocaleString()}`)
      lines.push(`  Total Paid: AED ${Number(r.Total_Payments__c ?? 0).toLocaleString()}`)
      lines.push(`  Receipts on Account: AED ${Number(r.Receipt_On_Account_Amount__c ?? 0).toLocaleString()}`)
      lines.push(`  Security Cheque: AED ${Number(r.Security_Cheque_Amount__c ?? 0).toLocaleString()}`)
      lines.push(`  Late Payment Fees: AED ${Number(r.Late_Payment_Fees__c ?? 0).toLocaleString()}`)
      return { context: lines.join('\n'), citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 58: get-lead-conversion-timeline
const getLeadConversionTimeline: ToolDefinition = {
  name: 'get-lead-conversion-timeline',
  description: 'Get lead conversion stats and timeline. Use for "how long to convert leads", "lead conversion time", "average days to convert", "lead conversion rate by source".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
  ],
  keywords: ['lead conversion time', 'conversion timeline', 'days to convert', 'lead conversion rate', 'how fast leads convert'],
  execute: async (params) => {
    const period = params.period as string | undefined
    const dateClause = dateFilter('CreatedDate', period)
    const where = dateClause ? `WHERE ${dateClause.slice(5)}` : ''
    const query = `SELECT COUNT(Id) total, SUM(CASE WHEN IsConverted = true THEN 1 ELSE 0 END) converted FROM Lead ${where}`
    try {
      const result = await soql(query)
      const r = result.records[0]
      const total = (r?.total as number) ?? 0
      const converted = (r?.converted as number) ?? 0
      const rate = total > 0 ? ((converted / total) * 100).toFixed(1) : '0'

      // Get conversion by source
      const sourceQuery = `SELECT LeadSource src, COUNT(Id) total, SUM(CASE WHEN IsConverted = true THEN 1 ELSE 0 END) converted FROM Lead WHERE LeadSource != null ${dateClause} GROUP BY LeadSource ORDER BY COUNT(Id) DESC LIMIT 10`
      const sourceResult = await soql(sourceQuery)
      const sourceLines = sourceResult.records.map((sr: Record<string, unknown>) => {
        const srcTotal = (sr.total as number) ?? 0
        const srcConverted = (sr.converted as number) ?? 0
        const srcRate = srcTotal > 0 ? ((srcConverted / srcTotal) * 100).toFixed(1) : '0'
        return `  ${sr.src}: ${srcConverted}/${srcTotal} (${srcRate}%)`
      })

      return {
        context: `Lead Conversion Summary:\n  Total: ${total} | Converted: ${converted} | Rate: ${rate}%\n\nBy Source:\n${sourceLines.join('\n') || '  No source data'}`,
        citation: { documentName: 'Salesforce (live CRM)' }
      }
    } catch { return null }
  }
}

// Tool 59: get-deals-filtered (multi-filter composite)
const getDealsFiltered: ToolDefinition = {
  name: 'get-deals-filtered',
  description: 'Search deals with multiple filters at once. Use for "deals in Hayat with 3 bedrooms this year", "villas sold by Ahmed in 2025", "pending deals in Address Grand Downtown".',
  params: [
    { name: 'community', type: 'string', description: 'Community/location filter', required: false },
    { name: 'bedroom', type: 'string', description: 'Bedroom count filter (e.g. "3", "2", "studio")', required: false },
    { name: 'period', type: 'string', description: 'Time period', required: false },
    { name: 'stage', type: 'string', description: 'Stage filter (won, lost, pending, all)', required: false },
    { name: 'salesperson', type: 'string', description: 'Salesperson name filter', required: false },
    { name: 'limit', type: 'number', description: 'Max results', required: false },
  ],
  keywords: ['deals with filter', 'search deals', 'find deals', 'filtered deals', 'specific deals'],
  execute: async (params) => {
    const community = params.community as string | undefined
    const bedroom = params.bedroom as string | undefined
    const period = params.period as string | undefined
    const stage = (params.stage as string) || 'all'
    const salesperson = params.salesperson as string | undefined
    const limit = (params.limit as number) || 20

    const conditions: string[] = []
    if (community) conditions.push(`Building_Community__c LIKE '%${community.replace(/'/g, "")}%'`)
    if (bedroom) {
      // Map common bedroom terms
      const b = bedroom.toLowerCase()
      if (b === 'studio' || b === '0') conditions.push("(Sales_Room__c = 'Studio' OR CM_No_of_Bedrooms__c = 'Studio')")
      else if (b === '1' || b === '1br' || b === '1 bedroom') conditions.push("(Sales_Room__c = '1' OR CM_No_of_Bedrooms__c = '1')")
      else if (b === '2' || b === '2br' || b === '2 bedroom') conditions.push("(Sales_Room__c = '2' OR CM_No_of_Bedrooms__c = '2')")
      else if (b === '3' || b === '3br' || b === '3 bedroom') conditions.push("(Sales_Room__c = '3' OR CM_No_of_Bedrooms__c = '3')")
      else if (b === '4' || b === '4br' || b === '4 bedroom') conditions.push("(Sales_Room__c = '4' OR CM_No_of_Bedrooms__c = '4')")
      else if (b === '5' || b === '5br' || b === '5 bedroom') conditions.push("(Sales_Room__c = '5' OR CM_No_of_Bedrooms__c = '5')")
      else conditions.push(`(Sales_Room__c = '${bedroom.replace(/'/g, "")}' OR CM_No_of_Bedrooms__c = '${bedroom.replace(/'/g, "")}')`)
    }
    if (salesperson) conditions.push(`cm_Sales_Person__r.Name LIKE '%${salesperson.replace(/'/g, "")}%'`)
    if (stage === 'won') conditions.push('IsWon = true')
    else if (stage === 'lost') conditions.push('IsClosed = true AND IsWon = false')
    else if (stage === 'pending') conditions.push('IsClosed = false')

    const dateClause = dateFilter('CloseDate', period)
    if (dateClause) conditions.push(dateClause.slice(5))

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const query = `SELECT Name, StageName, Amount, CloseDate, Building_Community__c, Sales_Room__c, cm_Sales_Person__r.Name FROM Opportunity ${where} ORDER BY CloseDate DESC LIMIT ${limit}`
    try {
      const result = await soql(query)
      if (result.records.length === 0) return { context: 'No deals match the specified filters.', citation: { documentName: 'Salesforce (live CRM)' } }
      return { context: `Filtered deals (${result.totalSize} total):\n${formatResult(result)}`, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 60: get-advisor-performance
const getAdvisorPerformance: ToolDefinition = {
  name: 'get-advisor-performance',
  description: 'Get sales advisor performance metrics. Use for "advisor performance", "salesperson ranking", "who is the best advisor", "advisor leaderboard".',
  params: [
    { name: 'period', type: 'string', description: 'Time period', required: false },
    { name: 'limit', type: 'number', description: 'Max advisors to return', required: false },
  ],
  keywords: ['advisor performance', 'salesperson ranking', 'best advisor', 'leaderboard', 'advisor leaderboard', 'top advisor'],
  execute: async (params) => {
    const period = params.period as string | undefined
    const limit = (params.limit as number) || 10
    let where = "WHERE cm_Sales_Person__r.Name != null AND IsWon = true"
    where += dateFilter('CloseDate', period)
    const query = `SELECT cm_Sales_Person__r.Name advisor, COUNT(Id) deals, SUM(Amount) revenue, AVG(Amount) avgDeal FROM Opportunity ${where} GROUP BY cm_Sales_Person__r.Name ORDER BY SUM(Amount) DESC LIMIT ${limit}`
    try {
      const result = await soql(query)
      const body = formatResult(result)
      return { context: `Advisor Performance:\n${body}`, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 61: get-deal-timeline
const getDealTimeline: ToolDefinition = {
  name: 'get-deal-timeline',
  description: 'Get key dates/milestones for a deal. Use for "timeline for deal X", "key dates", "booking to handover timeline", "deal milestones".',
  params: [
    { name: 'deal_name', type: 'string', description: 'Deal/opportunity name or number', required: true },
  ],
  keywords: ['timeline', 'milestones', 'key dates', 'booking date', 'handover date', 'deal progress'],
  execute: async (params) => {
    const dealName = params.deal_name as string
    const query = `SELECT Name, CreatedDate, Property_Booked_Date__c, Order_Date__c, SPA_Signed_Date__c, SPA_Printed_Date__c, Target_Handover_Date__c, Official_Handover_Date__c, Handover_Completion_Date__c, Title_Deed_Reg_Date__c, CloseDate, StageName FROM Opportunity WHERE Name LIKE '%${dealName.replace(/'/g, "")}%' LIMIT 1`
    try {
      const result = await soql(query)
      if (result.records.length === 0) return { context: `No deal found matching "${dealName}".`, citation: { documentName: 'Salesforce (live CRM)' } }
      const r = result.records[0]
      const lines: string[] = [`Timeline for: ${r.Name} (${r.StageName})`]
      const dates: [string, unknown][] = [
        ['Created', r.CreatedDate],
        ['Booked', r.Property_Booked_Date__c],
        ['Order Date', r.Order_Date__c],
        ['SPA Signed', r.SPA_Signed_Date__c],
        ['SPA Printed', r.SPA_Printed_Date__c],
        ['Close Date', r.CloseDate],
        ['Target Handover', r.Target_Handover_Date__c],
        ['Official Handover', r.Official_Handover_Date__c],
        ['Handover Complete', r.Handover_Completion_Date__c],
        ['Title Deed Reg', r.Title_Deed_Reg_Date__c],
      ]
      for (const [label, val] of dates) {
        if (val) lines.push(`  ${label}: ${String(val).slice(0, 10)}`)
      }
      return { context: lines.join('\n'), citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// Tool 55 (renumbered): compare-years
const compareYears: ToolDefinition = {
  name: 'compare-years',
  description: 'Compare sales metrics between two years. Use for "compare 2024 and 2025", "year over year", "yoy comparison", "how did we do last year vs this year".',
  params: [
    { name: 'year1', type: 'string', description: 'First year to compare (e.g. "2024")', required: true },
    { name: 'year2', type: 'string', description: 'Second year to compare (e.g. "2025")', required: false },
    { name: 'metric', type: 'string', description: 'What to compare: "all" (default), "revenue", "count", "avg"', required: false },
  ],
  keywords: ['compare', 'year over year', 'yoy', 'vs', 'versus', '2024 vs 2025', 'last year vs this year', 'annual comparison'],
  execute: async (params) => {
    const year1 = (params.year1 as string) || '2024'
    const year2 = (params.year2 as string) || String(currentYear() - 1)
    const metric = (params.metric as string) || 'all'

    try {
      const results: string[] = []

      // Won deals
      const q1 = `SELECT COUNT(Id) cnt, SUM(Amount) total FROM Opportunity WHERE IsWon = true AND CloseDate >= ${year1}-01-01 AND CloseDate <= ${year1}-12-31`
      const q2 = `SELECT COUNT(Id) cnt, SUM(Amount) total FROM Opportunity WHERE IsWon = true AND CloseDate >= ${year2}-01-01 AND CloseDate <= ${year2}-12-31`
      const [r1, r2] = await Promise.all([soql(q1), soql(q2)])

      const c1 = r1.records[0]
      const c2 = r2.records[0]
      const cnt1 = (c1?.cnt as number) ?? 0
      const cnt2 = (c2?.cnt as number) ?? 0
      const total1 = (c1?.total as number) ?? 0
      const total2 = (c2?.total as number) ?? 0
      const avg1 = cnt1 > 0 ? Math.round(total1 / cnt1) : 0
      const avg2 = cnt2 > 0 ? Math.round(total2 / cnt2) : 0

      const pctChange = (a: number, b: number) => {
        if (a === 0) return b > 0 ? '+100%' : 'N/A'
        const change = ((b - a) / a) * 100
        return change >= 0 ? `+${change.toFixed(1)}%` : `${change.toFixed(1)}%`
      }

      results.push(`${year1} vs ${year2} — Won Deals Comparison:`)
      results.push(`  ${year1}: ${cnt1} deals | AED ${(total1 / 1_000_000).toFixed(1)}M | Avg AED ${(avg1 / 1_000_000).toFixed(2)}M`)
      results.push(`  ${year2}: ${cnt2} deals | AED ${(total2 / 1_000_000).toFixed(1)}M | Avg AED ${(avg2 / 1_000_000).toFixed(2)}M`)
      results.push(`  Change: ${pctChange(cnt1, cnt2)} deals | ${pctChange(total1, total2)} revenue | ${pctChange(avg1, avg2)} avg deal`)

      // Lost deals
      const q3 = `SELECT COUNT(Id) cnt FROM Opportunity WHERE IsClosed = true AND IsWon = false AND CloseDate >= ${year1}-01-01 AND CloseDate <= ${year1}-12-31`
      const q4 = `SELECT COUNT(Id) cnt FROM Opportunity WHERE IsClosed = true AND IsWon = false AND CloseDate >= ${year2}-01-01 AND CloseDate <= ${year2}-12-31`
      const [r3, r4] = await Promise.all([soql(q3), soql(q4)])
      const lost1 = (r3.records[0]?.cnt as number) ?? 0
      const lost2 = (r4.records[0]?.cnt as number) ?? 0

      const totalClosed1 = cnt1 + lost1
      const totalClosed2 = cnt2 + lost2
      const wr1 = totalClosed1 > 0 ? ((cnt1 / totalClosed1) * 100).toFixed(1) : '0'
      const wr2 = totalClosed2 > 0 ? ((cnt2 / totalClosed2) * 100).toFixed(1) : '0'

      results.push(`  ${year1}: ${lost1} lost deals | Win rate: ${wr1}%`)
      results.push(`  ${year2}: ${lost2} lost deals | Win rate: ${wr2}%`)

      // Top building comparison
      const qb1 = `SELECT Building_Name__c bld, COUNT(Id) cnt FROM Opportunity WHERE IsWon = true AND Building_Name__c != null AND CloseDate >= ${year1}-01-01 AND CloseDate <= ${year1}-12-31 GROUP BY Building_Name__c ORDER BY COUNT(Id) DESC LIMIT 3`
      const qb2 = `SELECT Building_Name__c bld, COUNT(Id) cnt FROM Opportunity WHERE IsWon = true AND Building_Name__c != null AND CloseDate >= ${year2}-01-01 AND CloseDate <= ${year2}-12-31 GROUP BY Building_Name__c ORDER BY COUNT(Id) DESC LIMIT 3`
      const [rb1, rb2] = await Promise.all([soql(qb1), soql(qb2)])

      results.push(`  Top buildings ${year1}: ${rb1.records.map((r: Record<string, unknown>) => `${r.bld} (${r.cnt})`).join(', ')}`)
      results.push(`  Top buildings ${year2}: ${rb2.records.map((r: Record<string, unknown>) => `${r.bld} (${r.cnt})`).join(', ')}`)

      return { context: results.join('\n'), citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { return null }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXISTING TOOLS CONTINUE
// ─────────────────────────────────────────────────────────────────────────────

export const TOOL_CATALOG: ToolDefinition[] = [
  getSalesSummary,
  getSalesByBuilding,
  getSalesByCommunity,
  getSalesByPerson,
  getSalesByChannel,
  getPipeline,
  getRecentDeals,
  lookupCustomer,
  getUnitCount,
  getCancellations,
  getSalesByBedroom,
  getSalesByAccount,
  getAvgDealValue,
  getLostDeals,
  getLeadsSummary,
  getLeadsBySource,
  getAccountsSummary,
  getTasksSummary,
  getTasksOpen,
  getCaseBreakdownByType,
  getCaseBreakdownByStatus,
  getCaseBreakdownByPriority,
  getPropertyByCommunity,
  getCaseCount,
  getSalesByMonth,
  getWinRate,
  getSalesBySource,
  getPropertyStatusBreakdown,
  getPropertyByType,
  getInventoryPricing,
  getCaseBreakdownByOrigin,
  getCaseCountByEservice,
  getCaseCountByRecordType,
  getLeadsConversion,
  getMortgageStatus,
  getMilestoneStatus,
  getSalesByAgency,
  getSalesByAgent,
  getBookingTrend,
  getTopCustomersByTransaction,
  getAccountByType,
  getCancellationsByCommunity,
  // Contact tools
  getContactByAccount,
  getContactByName,
  getContactsSummary,
  // Lead tools (enhanced)
  getLeadByAccount,
  getLeadByName,
  getLeadByStatus,
  // Task tools (enhanced)
  getTasksByAccount,
  getTasksByCase,
  getTasksByOwner,
  getTasksByStatus,
  getTasksOverdue,
  getTasksByPriority,
  // Cross-object & enhanced tools (55-61)
  getCasesForDeal,
  getTasksForDeal,
  getDealFinancials,
  getLeadConversionTimeline,
  getDealsFiltered,
  getAdvisorPerformance,
  getDealTimeline,
  compareYears,
]

export function getToolByName(name: string): ToolDefinition | undefined {
  return TOOL_CATALOG.find(t => t.name === name)
}
