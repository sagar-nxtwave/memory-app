// Privacy Filter — enforces data sensitivity classifications from LLM Rules.
// Ensures the system never exposes restricted data without proper context.

import * as fs from 'fs/promises'
import * as path from 'path'

interface FieldRule {
  fieldApiName: string
  businessMeaning: string
  semanticCategory: string
  llmInterpretationAndUsage: string
  sensitiveClassification: string
  importantRules: string
}

interface ObjectRules {
  objectDescription: string
  fieldCount: number
  fields: FieldRule[]
}

let rulesCache: Record<string, ObjectRules> | null = null

async function loadRules(): Promise<Record<string, ObjectRules>> {
  if (rulesCache) return rulesCache
  try {
    const data = await fs.readFile(path.join(process.cwd(), 'data', 'llm-rules.json'), 'utf-8')
    rulesCache = JSON.parse(data)
    return rulesCache!
  } catch {
    return {}
  }
}

// Check if a field is restricted for the given context
export async function isFieldRestricted(
  fieldName: string,
  objectName: string,
  context: 'display' | 'export' | 'api'
): Promise<{ restricted: boolean; reason?: string; classification?: string }> {
  const rules = await loadRules()
  const objRules = rules[objectName]
  if (!objRules) return { restricted: false }

  const field = objRules.fields.find(f => f.fieldApiName === fieldName)
  if (!field) return { restricted: false }

  const cls = field.sensitiveClassification?.toLowerCase() || ''

  // PII fields need special handling
  if (cls.includes('pii')) {
    if (context === 'export') {
      return { restricted: true, reason: 'PII data cannot be exported', classification: field.sensitiveClassification }
    }
    if (context === 'display' && !cls.includes('business')) {
      return { restricted: true, reason: 'Personal PII requires user consent', classification: field.sensitiveClassification }
    }
  }

  // Confidential financial data
  if (cls.includes('confidential') && cls.includes('financial')) {
    if (context === 'export') {
      return { restricted: true, reason: 'Confidential financial data cannot be exported', classification: field.sensitiveClassification }
    }
  }

  // Sensitive personal data
  if (cls.includes('sensitive personal')) {
    return { restricted: true, reason: 'Sensitive personal data requires explicit authorization', classification: field.sensitiveClassification }
  }

  return { restricted: false }
}

// Get field description for tool prompts
export async function getFieldDescription(fieldName: string, objectName: string): Promise<string | null> {
  const rules = await loadRules()
  const objRules = rules[objectName]
  if (!objRules) return null

  const field = objRules.fields.find(f => f.fieldApiName === fieldName)
  if (!field) return null

  return `${field.businessMeaning}. ${field.importantRules || ''}`
}

// Get privacy summary for a query result
export async function getPrivacySummary(objectName: string): Promise<string> {
  const rules = await loadRules()
  const objRules = rules[objectName]
  if (!objRules) return ''

  const restricted = objRules.fields.filter(f => {
    const cls = f.sensitiveClassification?.toLowerCase() || ''
    return cls.includes('pii') || cls.includes('confidential') || cls.includes('sensitive')
  })

  if (restricted.length === 0) return ''

  return `PRIVACY NOTE: This object contains ${restricted.length} restricted fields (${restricted.map(f => f.sensitiveClassification).join(', ')}). Do not expose raw PII or confidential financial data without masking.`
}

// Mask sensitive data in a result string
export function maskSensitiveData(text: string): string {
  // Mask email addresses
  let masked = text.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, (email) => {
    const [local, domain] = email.split('@')
    return `${local.charAt(0)}***@${domain}`
  })

  // Mask phone numbers (UAE format)
  masked = masked.replace(/\+971[\s-]?\d[\s-]?\d{3}[\s-]?\d{4}/g, (phone) => {
    return phone.slice(0, 6) + '****'
  })

  // Mask amounts > 1M AED (show as "Confidential")
  masked = masked.replace(/AED\s*[\d,]+\.\d{2}/g, (amount) => {
    const num = parseFloat(amount.replace(/[AED\s,]/g, ''))
    if (num > 1000000) return 'AED [Confidential]'
    return amount
  })

  return masked
}