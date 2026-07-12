// Standalone test script for Salesforce's Platform MCP endpoint — NOT wired into the app.
// Uses the JWT Bearer Flow (required since the MCP gateway rejects client_credentials
// opaque tokens with "Invalid token" — confirmed earlier via probing).
//
// Goal: authenticate via JWT Bearer, discover MCP capabilities, then run the 3 known-tricky
// questions that previously failed/hallucinated in our own pipeline.
import jwt from 'jsonwebtoken'
import { readFileSync } from 'fs'
import { join } from 'path'

const LOGIN_URL = process.env.SALESFORCE_LOGIN_URL! // https://nshama--fullcopy.sandbox.my.salesforce.com
const TOKEN_URL = `${LOGIN_URL}/services/oauth2/token`
const MCP_URL = process.env.SALESFORCE_MCP_URL!
const CLIENT_ID = process.env.SALESFORCE_MCP_CLIENT_ID!
const USERNAME = 'mobileapp@nshama.ae' // from shared Postman env — the user this Connected App impersonates

const PRIVATE_KEY = readFileSync(join(process.cwd(), 'certs', 'salesforce-mcp.key'), 'utf-8')

function buildJwtAssertion(): string {
  // Sandbox orgs must use https://test.salesforce.com as audience (not login.salesforce.com)
  const audience = LOGIN_URL.includes('.sandbox.') || LOGIN_URL.includes('test.salesforce.com')
    ? 'https://test.salesforce.com'
    : 'https://login.salesforce.com'

  return jwt.sign(
    {
      iss: CLIENT_ID,
      sub: USERNAME,
      aud: audience,
    },
    PRIVATE_KEY,
    { algorithm: 'RS256', expiresIn: '3m' }
  )
}

async function getAccessTokenViaJwtBearer(): Promise<{ accessToken: string; instanceUrl: string }> {
  const assertion = buildJwtAssertion()
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  })
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const text = await res.text()
  console.log(`  [Token HTTP ${res.status}]`, text.slice(0, 500))
  if (!res.ok) {
    throw new Error(`JWT Bearer token request failed ${res.status}: ${text}`)
  }
  const data = JSON.parse(text)
  return { accessToken: data.access_token, instanceUrl: data.instance_url }
}

async function mcpRequest(accessToken: string, body: unknown): Promise<unknown> {
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
  if (!res.ok) {
    throw new Error(`MCP request failed ${res.status}: ${text}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function main() {
  console.log('═'.repeat(70))
  console.log(' SALESFORCE PLATFORM MCP — JWT BEARER FLOW TEST')
  console.log('═'.repeat(70))

  console.log('\n[1] Authenticating via JWT Bearer Flow...')
  const { accessToken } = await getAccessTokenViaJwtBearer()
  console.log('Access token obtained (JWT Bearer flow succeeded)')

  console.log('\n[1b] Attempting token exchange for api.salesforce.com scope...')
  try {
    const exchangeBody = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: accessToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      audience: 'https://api.salesforce.com',
    })
    const exchangeRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: exchangeBody,
    })
    const exchangeText = await exchangeRes.text()
    console.log(`  [Exchange HTTP ${exchangeRes.status}]`, exchangeText.slice(0, 800))
  } catch (err) {
    console.error('Token exchange attempt failed:', err)
  }

  console.log('\n[2] Sending MCP initialize handshake...')
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

  console.log('\n[3] Listing available tools...')
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
