// Tests the External Client App's client_credentials flow against the MCP endpoint —
// same credentials/URL as before, but now via the (supposedly) properly-configured
// External Client App instead of a plain Connected App.

const TOKEN_URL = `${process.env.SALESFORCE_LOGIN_URL}/services/oauth2/token`
const MCP_URL = process.env.SALESFORCE_MCP_URL!
const CLIENT_ID = process.env.SALESFORCE_MCP_CLIENT_ID!
const CLIENT_SECRET = process.env.SALESFORCE_MCP_CLIENT_SECRET!

async function getAccessToken(): Promise<{ accessToken: string }> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  })
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const text = await res.text()
  console.log(`  [Token HTTP ${res.status}]`, text.slice(0, 600))
  if (!res.ok) throw new Error(`Token request failed ${res.status}: ${text}`)
  const data = JSON.parse(text)
  return { accessToken: data.access_token }
}

async function mcpRequest(accessToken: string, body: unknown): Promise<void> {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  console.log(`  [MCP HTTP ${res.status}]`, text.slice(0, 3000))
}

async function main() {
  console.log('═'.repeat(70))
  console.log(' MCP TEST — External Client App via client_credentials')
  console.log('═'.repeat(70))

  console.log('\n[1] Getting access token via client_credentials...')
  const { accessToken } = await getAccessToken()

  console.log('\n[2] Calling MCP initialize...')
  await mcpRequest(accessToken, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'memory-app-test', version: '1.0.0' },
    },
  })

  console.log('\n[3] Calling MCP tools/list...')
  await mcpRequest(accessToken, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  })
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
