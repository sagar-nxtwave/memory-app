// Salesforce connector configuration — all from environment (no hardcoded secrets).

export interface SalesforceConfig {
  enabled: boolean
  loginUrl: string
  clientId: string
  clientSecret: string
  apiVersion: string
}

export function getSalesforceConfig(): SalesforceConfig {
  const loginUrl = (process.env.SALESFORCE_LOGIN_URL ?? '').replace(/\/$/, '')
  const clientId = process.env.SALESFORCE_CLIENT_ID ?? ''
  const clientSecret = process.env.SALESFORCE_CLIENT_SECRET ?? ''
  const flagOn = /^(1|true|yes|on)$/i.test((process.env.SALESFORCE_ENABLED ?? '').trim())

  return {
    // Enabled only when explicitly on AND all creds present — otherwise the connector
    // silently no-ops and chat continues without it (never errors).
    enabled: flagOn && !!loginUrl && !!clientId && !!clientSecret,
    loginUrl,
    clientId,
    clientSecret,
    apiVersion: process.env.SALESFORCE_API_VERSION ?? '60.0',
  }
}
