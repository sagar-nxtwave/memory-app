// Now that MCP auth works (JWT-based access tokens + sfap_api scope), discover the
// available tools and test the 3 known-tricky questions against them.

const MCP_URL = process.env.SALESFORCE_MCP_URL!
const TOKEN_URL = `${process.env.SALESFORCE_LOGIN_URL}/services/oauth2/token`
const CLIENT_ID = process.env.SALESFORCE_MCP_CLIENT_ID!
const CLIENT_SECRET = process.env.SALESFORCE_MCP_CLIENT_SECRET!

async function getAccessToken(): Promise<string> {
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
  const data = await res.json()
  return data.access_token
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
  try {
    result = JSON.parse(text)
  } catch {
    result = text
  }
  return { result, sessionId: newSessionId ?? undefined }
}

async function main() {
  console.log('═'.repeat(70))
  console.log(' MCP TOOL DISCOVERY + TEST')
  console.log('═'.repeat(70))

  const accessToken = await getAccessToken()

  console.log('\n[1] Initialize...')
  const init = await mcpCall(accessToken, undefined, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'memory-app', version: '1.0.0' } },
  })
  console.log(JSON.stringify(init.result))
  const sessionId = init.sessionId
  console.log('Session ID:', sessionId)

  console.log('\n[2] Sending initialized notification...')
  await mcpCall(accessToken, sessionId, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  })

  console.log('\n[3] Listing tools...')
  const toolsList = await mcpCall(accessToken, sessionId, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  })
  console.log(JSON.stringify(toolsList.result, null, 2))
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})

export {}
