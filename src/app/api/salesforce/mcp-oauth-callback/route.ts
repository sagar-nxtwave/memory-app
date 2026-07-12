import { NextRequest, NextResponse } from 'next/server'

// One-time OAuth Authorization Code callback for Salesforce's Platform MCP.
// This is a PUBLIC endpoint (no auth check) since Salesforce redirects the user's browser
// here directly after login — there's no session/cookie to check at this point. It only
// ever does something when a valid Salesforce `code` param is present, and exchanges it
// for tokens using our server-side client secret (never exposed to the browser).
//
// NOTE: this is a manual, one-time setup utility — not part of the regular app flow.
// After running this once and saving the resulting refresh_token, this route is no longer
// needed for day-to-day operation (the refresh_token is used server-side going forward).

const LOGIN_URL = process.env.SALESFORCE_LOGIN_URL!
const CLIENT_ID = process.env.SALESFORCE_MCP_CLIENT_ID!
const CLIENT_SECRET = process.env.SALESFORCE_MCP_CLIENT_SECRET!
// PKCE code_verifier — must match the code_challenge embedded in the authorization URL
// (this External Client App enforces PKCE, confirmed via "missing required code challenge" error).
const PKCE_VERIFIER = process.env.SALESFORCE_MCP_PKCE_VERIFIER!

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  const error = req.nextUrl.searchParams.get('error')
  const errorDescription = req.nextUrl.searchParams.get('error_description')

  if (error) {
    return NextResponse.json({ error, errorDescription }, { status: 400 })
  }

  if (!code) {
    return new NextResponse('No authorization code received.', { status: 400 })
  }

  const redirectUri = `${req.nextUrl.origin}/api/salesforce/mcp-oauth-callback`

  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: redirectUri,
      code_verifier: PKCE_VERIFIER,
    })
    const tokenRes = await fetch(`${LOGIN_URL}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    const tokenText = await tokenRes.text()
    if (!tokenRes.ok) {
      return new NextResponse(`Token exchange failed (${tokenRes.status}):\n${tokenText}`, { status: 500 })
    }
    const tokens = JSON.parse(tokenText)

    // Test the MCP endpoint immediately with the fresh access token, so we can confirm
    // success/failure right here in the browser response instead of needing separate steps.
    let mcpResult = ''
    try {
      const mcpRes = await fetch(process.env.SALESFORCE_MCP_URL!, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
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
      mcpResult = `MCP test: HTTP ${mcpRes.status}\n${await mcpRes.text()}`
    } catch (err) {
      mcpResult = `MCP test failed: ${err instanceof Error ? err.message : String(err)}`
    }

    // Log server-side (visible in Vercel function logs) so the refresh_token isn't only
    // shown in the browser response — reduces risk of it being lost.
    console.log('[mcp-oauth-callback] SUCCESS — refresh_token:', tokens.refresh_token)

    return new NextResponse(
      `Login successful!\n\n` +
        `refresh_token (save this):\n${tokens.refresh_token ?? '(none returned — check scopes include refresh_token/offline_access)'}\n\n` +
        `access_token (short-lived, for reference only):\n${tokens.access_token}\n\n` +
        `instance_url: ${tokens.instance_url}\n\n` +
        `${'='.repeat(70)}\n${mcpResult}`,
      { status: 200, headers: { 'Content-Type': 'text/plain' } }
    )
  } catch (err) {
    return new NextResponse(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`, { status: 500 })
  }
}
