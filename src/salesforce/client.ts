import { getSalesforceConfig, type SalesforceConfig } from './config'
import { validateSOQL } from './guardrails'

// Thin Salesforce REST client: OAuth client_credentials token (cached in-memory) + read-only
// SOQL queries + object describe (for dynamic field discovery). Auto-refreshes the token once
// on a 401. Read-only by design — only calls /query and /sobjects/.../describe.

interface TokenState {
  accessToken: string
  instanceUrl: string
}

// Module-level cache — a Salesforce access token is valid for the session lifetime, so we
// reuse it across requests instead of authenticating every call.
let cached: TokenState | null = null
let authPromise: Promise<TokenState> | null = null

async function authenticate(config: SalesforceConfig): Promise<TokenState> {
  // If another request is already authenticating, wait for it
  if (authPromise) return authPromise
  
  authPromise = (async () => {
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
  })()
  
  try {
    return await authPromise
  } finally {
    authPromise = null
  }
}

// GET a Salesforce REST path (relative to /services/data/vXX). Re-auths once on 401.
// Includes retry with exponential backoff for rate limits (429) and transient errors.
async function authedGet(pathAndQuery: string, retries = 2): Promise<Response> {
  const config = getSalesforceConfig()
  if (!config.enabled) throw new Error('Salesforce is not configured')
  const base = (token: TokenState) => `${token.instanceUrl}/services/data/v${config.apiVersion}${pathAndQuery}`

  let token = cached ?? (await authenticate(config))
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 30000) // 30s timeout
      
      let res = await fetch(base(token), { 
        headers: { Authorization: `Bearer ${token.accessToken}` },
        signal: controller.signal
      })
      clearTimeout(timeout)
      
      if (res.status === 401) {
        cached = null
        token = await authenticate(config)
        res = await fetch(base(token), { headers: { Authorization: `Bearer ${token.accessToken}` } })
      }
      
      // Retry on rate limit (429) or server errors (5xx)
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = res.headers.get('Retry-After')
        const delay = retryAfter ? parseInt(retryAfter) * 1000 : Math.pow(2, attempt) * 1000
        console.log(`[salesforce] retry ${attempt + 1}/${retries} after ${delay}ms (status=${res.status})`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      
      return res
    } catch (err) {
      if (attempt === retries) throw err
      const delay = Math.pow(2, attempt) * 1000
      console.log(`[salesforce] retry ${attempt + 1}/${retries} after ${delay}ms (error)`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  
  throw new Error('Salesforce request failed after retries')
}

export interface SoqlResult {
  totalSize: number
  done: boolean
  records: Record<string, unknown>[]
}

/** Execute a read-only SOQL query. Throws on query errors so the caller can self-repair. */
export async function soql(query: string): Promise<SoqlResult> {
  // Guardrail: validate query before execution
  const guardrail = validateSOQL(query)
  if (!guardrail.safe) {
    console.error(`[salesforce:guardrail] BLOCKED: ${guardrail.reason} | Query: ${query.slice(0, 200)}`)
    throw new Error(`SOQL guardrail blocked: ${guardrail.reason}`)
  }

  const res = await authedGet(`/query?q=${encodeURIComponent(query)}`)
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText)
    throw new Error(`Salesforce query failed ${res.status}: ${err.slice(0, 400)}`)
  }
  const data = await res.json()
  return { totalSize: data.totalSize ?? 0, done: data.done ?? true, records: data.records ?? [] }
}

export interface FieldInfo {
  name: string
  label: string
  type: string
  groupable: boolean
  referenceTo: string[]   // target object(s) this lookup/reference field points to, e.g. ['Account']
}

// Describe results are cached per object — field metadata rarely changes within a session.
const describeCache = new Map<string, FieldInfo[]>()

/** Fetch the field list for an object (cached) — powers dynamic SOQL field selection. */
export async function describeObject(object: string): Promise<FieldInfo[]> {
  const cachedFields = describeCache.get(object)
  if (cachedFields) return cachedFields

  const res = await authedGet(`/sobjects/${encodeURIComponent(object)}/describe`)
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText)
    throw new Error(`Salesforce describe failed ${res.status}: ${err.slice(0, 300)}`)
  }
  const data = await res.json()
  // referenceTo tells us which object(s) a lookup field actually points to (e.g.
  // cm_Opportunity__c -> ['Opportunity']) — without this, cross-object joins only work for
  // relationships the model already knows from training (standard Account/Opportunity) or
  // ones we've hand-hinted; capturing it makes ANY custom lookup traversable.
  const fields: FieldInfo[] = (data.fields ?? []).map((f: { name: string; label: string; type: string; groupable?: boolean; referenceTo?: string[] }) => ({
    name: f.name,
    label: f.label ?? f.name,
    type: f.type ?? 'string',
    groupable: f.groupable ?? false,
    referenceTo: Array.isArray(f.referenceTo) ? f.referenceTo : [],
  }))
  describeCache.set(object, fields)
  return fields
}
