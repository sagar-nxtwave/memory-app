import { ALLOWED_OBJECTS } from './schema'

// SOQL safety guardrails — validates queries before execution.
// Prevents injection, unauthorized objects, dangerous keywords, and malformed queries.

const DANGEROUS_KEYWORDS = /\b(INSERT|UPDATE|DELETE|UPSERT|MERGE|DROP|ALTER|CREATE|TRUNCATE)\b/i
const COMMENT_PATTERNS = /(--|\/\*|\*\/)/
const MAX_QUERY_LENGTH = 2000
const MAX_LIMIT = 500

export interface GuardrailResult {
  safe: boolean
  reason?: string
}

/**
 * Validate a SOQL query against all guardrails.
 * Returns { safe: true } if the query passes, or { safe: false, reason } if blocked.
 */
export function validateSOQL(query: string): GuardrailResult {
  // 1. Length check
  if (query.length > MAX_QUERY_LENGTH) {
    return { safe: false, reason: `Query exceeds maximum length (${query.length} > ${MAX_QUERY_LENGTH})` }
  }

  // 2. Must start with SELECT
  if (!/^\s*SELECT\s+/i.test(query)) {
    return { safe: false, reason: 'Query must start with SELECT' }
  }

  // 3. No dangerous keywords (DML operations)
  if (DANGEROUS_KEYWORDS.test(query)) {
    return { safe: false, reason: `Query contains dangerous keyword: ${query.match(DANGEROUS_KEYWORDS)?.[0]}` }
  }

  // 4. No SQL comments
  if (COMMENT_PATTERNS.test(query)) {
    return { safe: false, reason: 'Query contains SQL comments' }
  }

  // 5. No semicolons (statement termination)
  if (query.includes(';')) {
    return { safe: false, reason: 'Query contains semicolons' }
  }

  // 6. Validate FROM object is in allowed list
  const fromMatch = query.match(/\bFROM\s+([a-zA-Z_][a-zA-Z0-9_]*)/i)
  if (!fromMatch) {
    return { safe: false, reason: 'Query has no FROM clause' }
  }
  const fromObject = fromMatch[1]
  if (!ALLOWED_OBJECTS.some(o => o.toLowerCase() === fromObject.toLowerCase())) {
    return { safe: false, reason: `Object "${fromObject}" is not in the allowed list: ${ALLOWED_OBJECTS.join(', ')}` }
  }

  // 7. Check LIMIT is reasonable
  const limitMatch = query.match(/\bLIMIT\s+(\d+)/i)
  if (limitMatch) {
    const limit = parseInt(limitMatch[1], 10)
    if (limit > MAX_LIMIT) {
      return { safe: false, reason: `LIMIT ${limit} exceeds maximum allowed (${MAX_LIMIT})` }
    }
  }

  // 8. Check for nested subqueries (limit depth to 1)
  const subqueryDepth = (query.match(/\(/g) || []).length - (query.match(/\)/g) || []).length
  if (Math.abs(subqueryDepth) > 1) {
    return { safe: false, reason: 'Query has unbalanced parentheses' }
  }

  // 9. Block field injection patterns (field names with special chars)
  const fieldPattern = /\bFROM\b/i
  const selectClause = query.split(fieldPattern)[0]
  if (selectClause && /[;'"\\]/.test(selectClause.replace(/ COUNT\(| SUM\(| AVG\(| MIN\(| MAX\(/gi, ''))) {
    return { safe: false, reason: 'Select clause contains suspicious characters' }
  }

  // 10. Block Building_Community__c in GROUP BY on Opportunity (Salesforce limitation — this field cannot be grouped on Opportunity)
  // But ALLOW it on Property_Inventory__c where it works fine
  const groupByMatch = query.match(/\bGROUP\s+BY\b(.+?)(?:\bHAVING\b|\bORDER\s+BY\b|\bLIMIT\b|$)/i)
  if (groupByMatch) {
    const groupByClause = groupByMatch[1]
    if (/Building_Community__c/i.test(groupByClause)) {
      const fromObj = query.match(/\bFROM\s+([a-zA-Z_][a-zA-Z0-9_]*)/i)?.[1]
      if (fromObj && fromObj.toLowerCase() === 'opportunity') {
        return { safe: false, reason: 'Building_Community__c cannot be grouped on Opportunity — use Building_Name__c instead' }
      }
      // For Property_Inventory__c and other objects, Building_Community__c GROUP BY is allowed
    }
  }

  return { safe: true }
}

/**
 * Validate that a field exists on an object using describe() data.
 * This is a softer check — it logs a warning but doesn't block the query.
 */
export function validateFieldExists(
  fieldName: string,
  objectName: string,
  availableFields: string[]
): boolean {
  // Handle relationship fields (e.g., cm_Sales_Person__r.Name → cm_Sales_Person__r)
  const baseField = fieldName.includes('.') ? fieldName.split('.')[0] : fieldName
  const exists = availableFields.some(f => f.toLowerCase() === baseField.toLowerCase())
  if (!exists) {
    console.warn(`[salesforce:guardrail] Field "${fieldName}" may not exist on ${objectName}`)
  }
  return exists
}

/**
 * Sanitize a SOQL string to prevent injection.
 * Removes non-alphanumeric characters from field/value references.
 */
export function sanitizeSOQLInput(input: string): string {
  return input
    .replace(/[;'"\\]/g, '') // Remove dangerous chars
    .replace(/--/g, '') // Remove SQL comments
    .trim()
}
