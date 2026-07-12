// Diagnostic: inspect full response headers from the MCP endpoint, not just the body,
// to look for clues (WWW-Authenticate, trace IDs, etc.) beyond the generic "Invalid token" message.

const MCP_URL = process.env.SALESFORCE_MCP_URL!
const TOKEN_URL = `${process.env.SALESFORCE_LOGIN_URL}/services/oauth2/token`
const CLIENT_ID = process.env.SALESFORCE_MCP_CLIENT_ID!
const CLIENT_SECRET = process.env.SALESFORCE_MCP_CLIENT_SECRET!

async function main() {
  // Get a fresh token
  const tokenBody = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  })
  const tokenRes = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody,
  })
  const tokenData = await tokenRes.json()
  console.log('Access token obtained:', tokenData.access_token.slice(0, 30) + '...')
  console.log('Instance URL:', tokenData.instance_url)

  console.log('\n' + '='.repeat(70))
  console.log('Calling MCP endpoint, inspecting FULL response...')
  console.log('='.repeat(70))

  const mcpRes = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'memory-app', version: '1.0.0' } },
    }),
  })

  console.log('\nStatus:', mcpRes.status, mcpRes.statusText)
  console.log('\nHeaders:')
  for (const [key, value] of mcpRes.headers.entries()) {
    console.log(`  ${key}: ${value}`)
  }
  console.log('\nBody:')
  console.log(await mcpRes.text())

  // Also try WITHOUT the instance-specific token — using instance_url directly to see if
  // that changes anything (in case api.salesforce.com wants instance context another way)
  console.log('\n' + '='.repeat(70))
  console.log('Trying with X-Salesforce-Instance-Url header added...')
  console.log('='.repeat(70))
  const mcpRes2 = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-Salesforce-Instance-Url': tokenData.instance_url,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'memory-app', version: '1.0.0' } },
    }),
  })
  console.log('Status:', mcpRes2.status)
  console.log('Body:', await mcpRes2.text())

  // Try with the MCP-Protocol-Version HTTP header (per the official MCP spec's Streamable
  // HTTP transport — this is a REQUIRED header per spec, distinct from protocolVersion in body)
  console.log('\n' + '='.repeat(70))
  console.log('Trying with MCP-Protocol-Version HTTP header...')
  console.log('='.repeat(70))
  const mcpRes3 = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2024-11-05',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'memory-app', version: '1.0.0' } },
    }),
  })
  console.log('Status:', mcpRes3.status)
  console.log('Body:', await mcpRes3.text())

  // Try GET on the base MCP URL (some MCP servers support GET for SSE stream / discovery)
  console.log('\n' + '='.repeat(70))
  console.log('Trying GET on the MCP URL...')
  console.log('='.repeat(70))
  const mcpRes4 = await fetch(MCP_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: 'application/json, text/event-stream',
    },
  })
  console.log('Status:', mcpRes4.status)
  console.log('Body:', (await mcpRes4.text()).slice(0, 1000))

  // Try the token in a Salesforce-standard call to the SAME instance to prove the token
  // itself works fine — isolating whether this is truly an api.salesforce.com-specific issue.
  console.log('\n' + '='.repeat(70))
  console.log('Sanity check: same token against a normal Salesforce REST API call...')
  console.log('='.repeat(70))
  const sfRes = await fetch(`${tokenData.instance_url}/services/data/v60.0/limits`, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  })
  console.log('Status:', sfRes.status)
  console.log('Body (first 300 chars):', (await sfRes.text()).slice(0, 300))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

export {}
