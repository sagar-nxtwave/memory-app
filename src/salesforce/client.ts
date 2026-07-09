import { getSalesforceConfig, type SalesforceConfig } from './config'

// Thin Salesforce REST client: OAuth client_credentials token (cached in-memory) + read-only
// SOQL query execution. Auto-refreshes the token once on a 401. Read-only by design — it only
// ever calls the /query endpoint, so it cannot mutate Salesforce data.

interface TokenState {
  accessToken: string
  instanceUrl: string
}

// Module-level cache — a Salesforce access token is valid for the session lifetime, so we
// reuse it across requests instead of authenticating every query.
let cached: TokenState | null = null

async function authenticate(config: SalesforceConfig): Promise<TokenState> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret,
  })
  const res = await fetch(`${config.loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText)
    throw new Error(`Salesforce auth failed ${res.status}: ${err.slice(0, 300)}`)
  }
  const data = await res.json()
  if (!data.access_token) throw new Error('Salesforce auth returned no access_token')
  const state: TokenState = { accessToken: data.access_token, instanceUrl: data.instance_url ?? config.loginUrl }
  cached = state
  return state
}

async function getToken(config: SalesforceConfig): Promise<TokenState> {
  return cached ?? authenticate(config)
}

export interface SoqlResult {
  totalSize: number
  done: boolean
  records: Record<string, unknown>[]
}

/**
 * Execute a read-only SOQL query. Refreshes the token once on a 401 (expired/invalid session).
 * Throws on query errors (bad SOQL, etc.) so the caller can surface a graceful message.
 */
export async function soql(query: string): Promise<SoqlResult> {
  const config = getSalesforceConfig()
  if (!config.enabled) throw new Error('Salesforce is not configured')

  const run = async (token: TokenState): Promise<Response> =>
    fetch(`${token.instanceUrl}/services/data/v${config.apiVersion}/query?q=${encodeURIComponent(query)}`, {
      headers: { Authorization: `Bearer ${token.accessToken}` },
    })

  let token = await getToken(config)
  let res = await run(token)

  // Token expired/invalid → clear cache, re-auth once, retry.
  if (res.status === 401) {
    cached = null
    token = await authenticate(config)
    res = await run(token)
  }

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText)
    throw new Error(`Salesforce query failed ${res.status}: ${err.slice(0, 400)}`)
  }

  const data = await res.json()
  return { totalSize: data.totalSize ?? 0, done: data.done ?? true, records: data.records ?? [] }
}
