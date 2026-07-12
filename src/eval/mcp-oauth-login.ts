// One-time interactive OAuth Authorization Code flow for Salesforce's Platform MCP.
// Opens a local server on localhost:3001, prints the Salesforce login URL to visit,
// waits for the callback with the authorization code, exchanges it for an access_token
// + refresh_token, then tests the MCP endpoint and prints the refresh_token to save.
import http from 'http'
import { exec } from 'child_process'

const LOGIN_URL = process.env.SALESFORCE_LOGIN_URL!
const CLIENT_ID = process.env.SALESFORCE_MCP_CLIENT_ID!
const CLIENT_SECRET = process.env.SALESFORCE_MCP_CLIENT_SECRET!
const MCP_URL = process.env.SALESFORCE_MCP_URL!
const REDIRECT_URI = 'http://localhost:3001/callback'
const PORT = 3001

const authUrl = `${LOGIN_URL}/services/oauth2/authorize?response_type=code&client_id=${encodeURIComponent(CLIENT_ID)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent('mcp_api refresh_token offline_access api')}`

async function exchangeCodeForToken(code: string): Promise<{ access_token: string; refresh_token?: string; instance_url: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
  })
  const res = await fetch(`${LOGIN_URL}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const text = await res.text()
  console.log(`  [Token exchange HTTP ${res.status}]`, text.slice(0, 800))
  if (!res.ok) throw new Error(`Token exchange failed: ${text}`)
  return JSON.parse(text)
}

async function testMcp(accessToken: string): Promise<void> {
  console.log('\n[Testing MCP with new access token]')
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'memory-app', version: '1.0.0' } },
    }),
  })
  const text = await res.text()
  console.log(`  [MCP HTTP ${res.status}]`, text.slice(0, 2000))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  if (url.pathname !== '/callback') {
    res.writeHead(404)
    res.end()
    return
  }

  const code = url.searchParams.get('code')
  const error = url.searchParams.get('error')

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(`OAuth error: ${error} — ${url.searchParams.get('error_description')}`)
    console.error('OAuth error:', error, url.searchParams.get('error_description'))
    server.close()
    process.exit(1)
  }

  if (!code) {
    res.writeHead(400)
    res.end('No code received')
    return
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('Login successful! You can close this tab and return to the terminal.')

  console.log('\n[Received authorization code, exchanging for tokens...]')
  try {
    const tokens = await exchangeCodeForToken(code)
    console.log('\n═'.repeat(70))
    console.log('SUCCESS — save this refresh_token for future use:')
    console.log('═'.repeat(70))
    console.log('REFRESH_TOKEN:', tokens.refresh_token ?? '(none returned — check scopes)')
    console.log('═'.repeat(70))

    await testMcp(tokens.access_token)
  } catch (err) {
    console.error('Error during token exchange or MCP test:', err)
  } finally {
    server.close()
    setTimeout(() => process.exit(0), 500)
  }
})

server.listen(PORT, () => {
  console.log('═'.repeat(70))
  console.log(' SALESFORCE MCP — OAUTH AUTHORIZATION CODE FLOW')
  console.log('═'.repeat(70))
  console.log(`\nListening on http://localhost:${PORT} for the OAuth callback...`)
  console.log('\nOpen this URL in your browser and log in / click Allow:\n')
  console.log(authUrl)
  console.log()

  // Try to auto-open the browser (Windows)
  exec(`start "" "${authUrl}"`, (err) => {
    if (err) console.log('(Could not auto-open browser — please open the URL above manually)')
  })
})
