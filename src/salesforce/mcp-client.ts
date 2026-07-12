// Salesforce Platform MCP client — authenticates via the External Client App's
// client_credentials flow (issuing real JWT-based access tokens, required by the
// api.salesforce.com MCP gateway) and provides tool discovery + tool execution.
//
// This is a SEPARATE Connected/External Client App from the one used for regular SOQL
// (src/salesforce/client.ts) — see .env.local SALESFORCE_MCP_* vars.

const TOKEN_URL = () => `${process.env.SALESFORCE_LOGIN_URL}/services/oauth2/token`
const MCP_URL = () => process.env.SALESFORCE_MCP_URL!
const CLIENT_ID = () => process.env.SALESFORCE_MCP_CLIENT_ID!
const CLIENT_SECRET = () => process.env.SALESFORCE_MCP_CLIENT_SECRET!

interface McpTool {
  name: string
  title: string
  description: string
  inputSchema: {
    type: string
    properties: Record<string, { type: string; description?: string }>
    required?: string[]
  }
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
}

// Module-level caches — access tokens and MCP session IDs are reused across calls within
// the same server instance lifetime (serverless functions may cold-start and lose these,
// which is fine — they're cheap to re-establish).
let cachedToken: { accessToken: string; expiresAt: number } | null = null
let cachedSessionId: string | null = null
let cachedTools: McpTool[] | null = null

async function getAccessToken(): Promise<string> {
  const now = Date.now()
  if (cachedToken && now < cachedToken.expiresAt) return cachedToken.accessToken

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID(),
    client_secret: CLIENT_SECRET(),
  })
  const res = await fetch(TOKEN_URL(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`MCP token request failed ${res.status}: ${text.slice(0, 300)}`)
  }
  const data = await res.json()
  // Salesforce access tokens don't include an explicit expiry — cache for 15 min to be safe.
  cachedToken = { accessToken: data.access_token, expiresAt: now + 15 * 60 * 1000 }
  cachedSessionId = null // new token → old MCP session is no longer valid, force re-init
  return data.access_token
}

async function mcpRequest(body: unknown): Promise<{ result: unknown; sessionId?: string }> {
  const accessToken = await getAccessToken()
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (cachedSessionId) headers['mcp-session-id'] = cachedSessionId

  const res = await fetch(MCP_URL(), { method: 'POST', headers, body: JSON.stringify(body) })
  const newSessionId = res.headers.get('mcp-session-id')
  if (newSessionId) cachedSessionId = newSessionId

  const text = await res.text()
  let result: unknown
  try {
    result = JSON.parse(text)
  } catch {
    result = text
  }

  if (!res.ok) {
    // Session likely expired/invalid — clear cache so the next call re-initializes.
    cachedSessionId = null
    throw new Error(`MCP request failed ${res.status}: ${JSON.stringify(result).slice(0, 300)}`)
  }

  return { result, sessionId: newSessionId ?? undefined }
}

async function ensureSession(): Promise<void> {
  if (cachedSessionId) return

  await mcpRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'memory-app', version: '1.0.0' } },
  })
  await mcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' })
}

/** Returns the list of tools this MCP server exposes (cached after first fetch). */
export async function getMcpTools(): Promise<McpTool[]> {
  if (cachedTools) return cachedTools
  await ensureSession()
  const { result } = await mcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  const tools = (result as { result?: { tools?: McpTool[] } })?.result?.tools ?? []
  cachedTools = tools
  return tools
}

export interface McpToolCallResult {
  isError: boolean
  content: string // flattened text content from the tool result
  raw: unknown
}

/** Calls a specific MCP tool by name with the given arguments. */
export async function callMcpTool(toolName: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
  await ensureSession()
  const { result } = await mcpRequest({
    jsonrpc: '2.0',
    id: Math.floor(Math.random() * 100000),
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  })

  const r = (result as { result?: { content?: { type: string; text?: string }[]; isError?: boolean } })?.result
  const isError = r?.isError ?? false
  const content = (r?.content ?? [])
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text)
    .join('\n')

  return { isError, content, raw: result }
}

/** Formats the MCP tool catalog as text for an LLM prompt, similar to getToolCatalogText(). */
export async function getMcpToolCatalogText(): Promise<string> {
  const tools = await getMcpTools()
  // Exclude write tools (create/update/delete) — this is a read-only Q&A assistant.
  const readOnlyTools = tools.filter((t) => t.annotations?.readOnlyHint !== false)
  return readOnlyTools
    .map((t) => {
      const params = Object.entries(t.inputSchema.properties || {})
        .map(([name, def]) => `${name}${t.inputSchema.required?.includes(name) ? '' : '?'}: ${def.type}${def.description ? ` — ${def.description}` : ''}`)
        .join(', ')
      return `- ${t.name}(${params})\n  ${t.description.split('\n')[0]}`
    })
    .join('\n')
}
