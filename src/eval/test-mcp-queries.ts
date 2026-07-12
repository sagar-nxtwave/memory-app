// Test MCP's soqlQuery + getObjectSchema tools against our known tricky questions.

const MCP_URL = process.env.SALESFORCE_MCP_URL!
const TOKEN_URL = `${process.env.SALESFORCE_LOGIN_URL}/services/oauth2/token`
const CLIENT_ID = process.env.SALESFORCE_MCP_CLIENT_ID!
const CLIENT_SECRET = process.env.SALESFORCE_MCP_CLIENT_SECRET!

async function getAccessToken(): Promise<string> {
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
  return (await res.json()).access_token
}

async function mcpCall(accessToken: string, sessionId: string | undefined, body: unknown): Promise<{ result: unknown; sessionId?: string }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (sessionId) headers['mcp-session-id'] = sessionId
  const res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) })
  const newSessionId = res.headers.get('mcp-session-id') ?? sessionId
  const text = await res.text()
  let result: unknown
  try { result = JSON.parse(text) } catch { result = text }
  return { result, sessionId: newSessionId ?? undefined }
}

async function callTool(accessToken: string, sessionId: string, id: number, toolName: string, args: Record<string, unknown>) {
  const res = await mcpCall(accessToken, sessionId, {
    jsonrpc: '2.0', id, method: 'tools/call', params: { name: toolName, arguments: args },
  })
  return res.result
}

async function main() {
  const accessToken = await getAccessToken()
  const init = await mcpCall(accessToken, undefined, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'memory-app', version: '1.0.0' } },
  })
  const sessionId = init.sessionId!
  await mcpCall(accessToken, sessionId, { jsonrpc: '2.0', method: 'notifications/initialized' })

  console.log('═'.repeat(70))
  console.log('TEST 1: getObjectSchema for Property_Inventory__c (check for admin guidance)')
  console.log('═'.repeat(70))
  const schema = await callTool(accessToken, sessionId, 2, 'getObjectSchema', { objects: 'Property_Inventory__c' })
  console.log(JSON.stringify(schema, null, 2).slice(0, 3000))

  console.log('\n' + '═'.repeat(70))
  console.log('TEST 2: List all communities (previously hallucinated 34 fake names)')
  console.log('═'.repeat(70))
  const communities = await callTool(accessToken, sessionId, 3, 'soqlQuery', {
    q: "SELECT Building_Community__c comm, COUNT(Id) cnt FROM Property_Inventory__c WHERE Building_Community__c != null GROUP BY Building_Community__c ORDER BY Building_Community__c LIMIT 100",
  })
  console.log(JSON.stringify(communities, null, 2).slice(0, 3000))

  console.log('\n' + '═'.repeat(70))
  console.log('TEST 3: Top 10 customers by revenue (previously hit SOQL bug)')
  console.log('═'.repeat(70))
  const topCustomers = await callTool(accessToken, sessionId, 4, 'soqlQuery', {
    q: "SELECT Account.Name name, COUNT(Id) cnt, SUM(Amount) total FROM Opportunity WHERE Account.Name != null AND IsWon = true AND Amount != null GROUP BY Account.Name ORDER BY SUM(Amount) DESC LIMIT 10",
  })
  console.log(JSON.stringify(topCustomers, null, 2).slice(0, 3000))

  console.log('\n' + '═'.repeat(70))
  console.log('TEST 4: Address Grand Downtown sales (our recently fixed bug)')
  console.log('═'.repeat(70))
  const addressGrand = await callTool(accessToken, sessionId, 5, 'soqlQuery', {
    q: "SELECT COUNT(Id) cnt, SUM(Amount) total FROM Opportunity WHERE (Building_Name__c LIKE '%Address Grand%' OR Building_Community__c LIKE '%Address Grand%') AND IsWon = true",
  })
  console.log(JSON.stringify(addressGrand, null, 2).slice(0, 2000))
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})

export {}
