// SOQL Validator — catches and auto-fixes common syntax errors before sending to Salesforce.
// This prevents wasted steps in the ReAct loop from MALFORMED_QUERY responses.

import { ALLOWED_OBJECTS } from './schema'

export interface SoqlValidationResult {
  /** The (possibly fixed) query */
  query: string
  /** Whether any fixes were applied */
  wasFixed: boolean
  /** Human-readable list of fixes applied */
  fixes: string[]
  /** Warnings that don't block execution */
  warnings: string[]
  /** Whether the query is structurally valid */
  valid: boolean
  /** Fatal error message if invalid */
  error?: string
}

// ─── Auto-Fix Patterns ───────────────────────────────────────────────────────

interface FixPattern {
  /** Description of the fix for logging */
  description: string
  /** Regex to match the bad pattern */
  pattern: RegExp
  /** Replacement string (use $1, $2 for captures) */
  replacement: string
}

const FIX_PATTERNS: FixPattern[] = [
  // 1. "Field NOT LIKE 'value'" → "(NOT Field LIKE 'value')"
  // Salesforce SOQL requires parentheses around NOT LIKE after AND.
  // Generic pattern: catches any identifier including dot-notation (Account.Name, RecordType.Name)
  {
    description: 'Fixed NOT LIKE syntax: added required parentheses',
    pattern: /(\b[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)\s+NOT\s+LIKE\s+('[^']*')/gi,
    replacement: '(NOT $1 LIKE $2)',
  },

  // 1b. "NOT Field LIKE 'value'" without parentheses → "(NOT Field LIKE 'value')"
  // When NOT LIKE appears after AND, parentheses are REQUIRED in SOQL.
  // This wraps any un-parenthesized NOT LIKE in parentheses.
  {
    description: 'Added required parentheses around NOT LIKE',
    pattern: /(?<!\()\bNOT\s+(\w+)\s+LIKE\s+('[^']*')/gi,
    replacement: '(NOT $1 LIKE $2)',
  },

  // 2. Double WHERE: "WHERE WHERE" → "WHERE"
  {
    description: 'Removed duplicate WHERE clause',
    pattern: /\bWHERE\s+WHERE\b/gi,
    replacement: 'WHERE',
  },

  // 3. WHERE AND: "WHERE AND" → "WHERE"
  {
    description: 'Removed stray AND after WHERE',
    pattern: /\bWHERE\s+AND\b/gi,
    replacement: 'WHERE',
  },

  // 4. AND WHERE: "AND WHERE" → "AND"
  {
    description: 'Removed stray WHERE after AND',
    pattern: /\bAND\s+WHERE\b/gi,
    replacement: 'AND',
  },

  // 5. Double AND: "AND AND" → "AND"
  {
    description: 'Removed duplicate AND',
    pattern: /\bAND\s+AND\b/gi,
    replacement: 'AND',
  },

  // 6. Double OR: "OR OR" → "OR"
  {
    description: 'Removed duplicate OR',
    pattern: /\bOR\s+OR\b/gi,
    replacement: 'OR',
  },

  // 7. LIKE without quotes: "LIKE %value%" → "LIKE '%value%'"
  {
    description: 'Added missing quotes around LIKE value',
    pattern: /\bLIKE\s+(['"]?%[^'"]*%['"]?)\b(?!\s*')/gi,
    replacement: "LIKE '$1'",
  },

  // 8. LIMIT on aggregate queries WITHOUT GROUP BY — strip LIMIT (fetch all groups for accurate totals)
  // Skip queries with GROUP BY — those need LIMIT to cap result count (e.g., "top 5 brokers")
  {
    description: 'Removed LIMIT from aggregate query',
    pattern: /^(?!.*\bGROUP\s+BY\b)(.*\b(?:COUNT|SUM|AVG|MIN|MAX)\s*\(.*?\).*?)\s+LIMIT\s+\d+\s*$/i,
    replacement: '$1',
  },
]

// ─── Validation Checks ───────────────────────────────────────────────────────

interface ValidationCheck {
  description: string
  check: (query: string) => string | null // returns error message or null
}

const VALIDATION_CHECKS: ValidationCheck[] = [
  // Must start with SELECT
  {
    description: 'Query must start with SELECT',
    check: (q) => {
      if (!/^\s*SELECT\b/i.test(q)) return 'Query must start with SELECT'
      return null
    },
  },

  // Must have FROM clause
  {
    description: 'Query must have FROM clause',
    check: (q) => {
      if (!/\bFROM\b/i.test(q)) return 'Query must include FROM clause'
      return null
    },
  },

  // FROM object must be in allowlist
  {
    description: 'FROM object must be in allowlist',
    check: (q) => {
      const fromMatch = q.match(/\bFROM\s+([a-zA-Z_][a-zA-Z0-9_]*)/i)
      if (!fromMatch) return 'Could not parse FROM object'
      const obj = fromMatch[1]
      if (!ALLOWED_OBJECTS.some(o => o.toLowerCase() === obj.toLowerCase())) {
        return `Object "${obj}" is not in the allowed objects list: ${ALLOWED_OBJECTS.join(', ')}`
      }
      return null
    },
  },

  // No DML statements
  {
    description: 'No DML statements (INSERT, UPDATE, DELETE)',
    check: (q) => {
      if (/\b(INSERT|UPDATE|DELETE|UPSERT|MERGE)\b/i.test(q)) {
        return 'DML statements (INSERT/UPDATE/DELETE) are not allowed'
      }
      return null
    },
  },

  // No semicolons
  {
    description: 'No semicolons',
    check: (q) => {
      if (q.includes(';')) return 'Semicolons are not allowed'
      return null
    },
  },

  // No SQL comments
  {
    description: 'No SQL comments',
    check: (q) => {
      if (q.includes('--') || q.includes('/*')) return 'SQL comments are not allowed'
      return null
    },
  },

  // Balanced parentheses
  {
    description: 'Balanced parentheses',
    check: (q) => {
      let depth = 0
      for (const ch of q) {
        if (ch === '(') depth++
        if (ch === ')') depth--
        if (depth < 0) return 'Unbalanced parentheses: extra closing paren'
      }
      if (depth > 0) return `Unbalanced parentheses: ${depth} unclosed paren(s)`
      return null
    },
  },

  // LIMIT cap
  {
    description: 'LIMIT should not exceed 500',
    check: (q) => {
      const limitMatch = q.match(/\bLIMIT\s+(\d+)/i)
      if (limitMatch) {
        const limit = parseInt(limitMatch[1], 10)
        if (limit > 500) return `LIMIT ${limit} exceeds maximum of 500`
      }
      return null
    },
  },

  // Building_Community__c GROUP BY on Opportunity (platform restriction)
  {
    description: 'Building_Community__c cannot be GROUP BY on Opportunity',
    check: (q) => {
      if (/\bFROM\s+Opportunity\b/i.test(q) && /\bGROUP\s+BY\s+Building_Community__c\b/i.test(q)) {
        return 'Building_Community__c cannot be used in GROUP BY on Opportunity (platform restriction). Use Building_Name__c instead, or filter with WHERE Building_Community__c = \'X\''
      }
      return null
    },
  },

  // Double WHERE clause
  {
    description: 'No duplicate WHERE clauses',
    check: (q) => {
      const whereCount = (q.match(/\bWHERE\b/gi) || []).length
      if (whereCount > 1) return 'Multiple WHERE clauses found — combine conditions with AND/OR'
      return null
    },
  },
]

// ─── Main Validation Function ────────────────────────────────────────────────

/**
 * Validate and auto-fix a SOQL query.
 *
 * Returns the (possibly fixed) query along with any fixes/warnings.
 * If the query is fatally invalid, returns valid=false with an error message.
 */
export function validateSoql(query: string): SoqlValidationResult {
  const fixes: string[] = []
  const warnings: string[] = []
  let currentQuery = query.trim()

  // ── Step 1: Apply auto-fix patterns ──
  for (const { description, pattern, replacement } of FIX_PATTERNS) {
    // Reset regex lastIndex for global patterns
    pattern.lastIndex = 0
    const before = currentQuery
    currentQuery = currentQuery.replace(pattern, replacement)
    if (currentQuery !== before) {
      fixes.push(description)
    }
  }

  // ── Step 2: Fix duplicate aliases in aggregate queries ──
  // When multiple __r.Name fields appear in SELECT, SOQL auto-aliases both to "Name"
  // causing MALFORMED_QUERY. Fix by adding explicit aliases.
  const rNameFields = currentQuery.match(/\b\w+__r\.Name\b/gi) || []
  if (rNameFields.length > 1) {
    const aliases: Record<string, string> = {}
    let aliasIdx = 0
    for (const field of rNameFields) {
      const lower = field.toLowerCase()
      if (!aliases[lower]) {
        // Derive alias from the lookup field name: cm_Agent_Name__r.Name → agentName
        const lookupMatch = field.match(/^(\w+?)__r\.Name$/i)
        if (lookupMatch) {
          // cm_Agent_Name → agentName, cm_Agency_Name → agencyName
          const lookup = lookupMatch[1]
            .replace(/^cm_/i, '')
            .replace(/_name$/i, '')
            .replace(/_/g, ' ')
            .split(' ')
            .map((w, i) => i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join('')
          aliases[lower] = lookup || `field${aliasIdx}`
        } else {
          aliases[lower] = `field${aliasIdx}`
        }
        aliasIdx++
      }
    }
    // Apply explicit aliases to SELECT fields (not in GROUP BY)
    for (const [field, alias] of Object.entries(aliases)) {
      const regex = new RegExp(`\\b${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b(?!\\s+\\w+(?:\\s*,|\\s+FROM))`, 'gi')
      currentQuery = currentQuery.replace(regex, `${field} ${alias}`)
    }
    if (Object.keys(aliases).length > 1) {
      fixes.push(`Added explicit aliases for duplicate __r.Name fields: ${Object.entries(aliases).map(([f, a]) => `${f}→${a}`).join(', ')}`)
    }
  }

  // ── Step 3: Clean up whitespace ──
  currentQuery = currentQuery
    .replace(/\s{2,}/g, ' ')           // collapse multiple spaces
    .replace(/\s*,\s*/g, ', ')         // normalize comma spacing
    .replace(/(?<![!=<>])\s*=\s*/g, ' = ') // normalize equals spacing (skip !=, >=, <=)
    .trim()

  // ── Step 4: Run validation checks ──
  for (const { description, check } of VALIDATION_CHECKS) {
    const error = check(currentQuery)
    if (error) {
      // Some checks are auto-fixable, others are fatal
      if (description === 'LIMIT should not exceed 500') {
        // Auto-fix: cap at 500
        currentQuery = currentQuery.replace(/\bLIMIT\s+\d+/i, 'LIMIT 500')
        fixes.push('Capped LIMIT at 500')
      } else if (description === 'Building_Community__c cannot be GROUP BY on Opportunity') {
        // Fatal — can't auto-fix
        return {
          query: currentQuery,
          wasFixed: fixes.length > 0,
          fixes,
          warnings,
          valid: false,
          error,
        }
      } else {
        // Fatal
        return {
          query: currentQuery,
          wasFixed: fixes.length > 0,
          fixes,
          warnings,
          valid: false,
          error,
        }
      }
    }
  }

  return {
    query: currentQuery,
    wasFixed: fixes.length > 0,
    fixes,
    warnings,
    valid: true,
  }
}

// ─── Error Parsing (for Layer 4) ─────────────────────────────────────────────

export interface SoqlErrorContext {
  /** Human-readable error summary */
  message: string
  /** Suggested fixes for the LLM */
  suggestions: string[]
  /** The problematic part of the query */
  problemArea?: string
}

/**
 * Parse a Salesforce MALFORMED_QUERY error and provide context for self-correction.
 */
export function parseSoqlError(errorContent: string): SoqlErrorContext {
  const suggestions: string[] = []

  // Parse "unexpected token: 'NOT'" — NOT LIKE requires parentheses in SOQL
  if (errorContent.includes('NOT LIKE') || errorContent.includes('NOT \'')) {
    suggestions.push(
      'NOT LIKE requires parentheses in SOQL — VERIFIED against live CRM:',
      '  ✅ WHERE (NOT Name LIKE \'%value%\') AND (NOT Name LIKE \'%other%\')',
      '  ✅ WHERE (NOT Account.Name LIKE \'Test%\' AND NOT Account.Name LIKE \'%Miscellaneous%\')',
      '  ❌ WHERE NOT Name LIKE \'%value%\' (fails when combined with AND)',
      '  ❌ WHERE Name NOT LIKE \'%value%\' (always fails)',
      'Every NOT LIKE condition must be wrapped in (NOT field LIKE \'pattern\')',
    )
    return {
      message: 'NOT LIKE requires parentheses',
      suggestions,
      problemArea: extractProblemArea(errorContent, 'NOT'),
    }
  }

  // Parse "unexpected token: 'WHERE AND'"
  if (errorContent.includes('WHERE AND')) {
    suggestions.push(
      'Invalid WHERE clause. Remove AND after WHERE:',
      '  ✅ WHERE field1 = \'value1\' AND field2 = \'value2\'',
      '  ❌ WHERE AND field1 = \'value1\''
    )
    return {
      message: 'Invalid WHERE clause — stray AND after WHERE',
      suggestions,
    }
  }

  // Parse "unexpected token: 'AND WHERE'"
  if (errorContent.includes('AND WHERE')) {
    suggestions.push(
      'Invalid WHERE placement. Remove WHERE after AND:',
      '  ✅ WHERE field1 = \'value1\' AND field2 = \'value2\'',
      '  ❌ WHERE field1 = \'value1\' AND WHERE field2 = \'value2\''
    )
    return {
      message: 'Invalid WHERE placement — stray WHERE after AND',
      suggestions,
    }
  }

  // Parse "duplicate alias" error
  if (errorContent.includes('duplicate alias') || errorContent.includes('MALFORMED_QUERY')) {
    const aliasMatch = errorContent.match(/duplicate alias:\s*(\w+)/i)
    const dupAlias = aliasMatch ? aliasMatch[1] : 'Name'
    suggestions.push(
      `Duplicate alias "${dupAlias}" — multiple __r.Name fields auto-alias to the same name.`,
      'Fix by adding explicit aliases to each field:',
      `  ✅ SELECT cm_Agent_Name__r.Name agentName, cm_Agency_Name__r.Name agencyName, COUNT(Id) cnt FROM Opportunity GROUP BY cm_Agent_Name__r.Name, cm_Agency_Name__r.Name`,
      `  ❌ SELECT cm_Agent_Name__r.Name, cm_Agency_Name__r.Name, COUNT(Id) cnt FROM Opportunity GROUP BY cm_Agent_Name__r.Name, cm_Agency_Name__r.Name`,
      'Each __r.Name field in SELECT needs a unique alias when multiple appear.',
    )
    return {
      message: `Duplicate alias: "${dupAlias}" — multiple relationship fields resolve to the same name`,
      suggestions,
      problemArea: extractProblemArea(errorContent, 'duplicate'),
    }
  }

  // Parse "non-grouped query that uses overall aggregate functions cannot also use LIMIT"
  if (errorContent.includes('LIMIT') && (errorContent.includes('aggregate') || errorContent.includes('non-grouped'))) {
    suggestions.push(
      'LIMIT cannot be used with aggregate functions (COUNT, SUM, AVG) — VERIFIED:',
      '  ✅ SELECT COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE Sold_By_Nshama__c = \'NEW SALE\'',
      '  ❌ SELECT COUNT(Id) cnt, SUM(Net_Amount__c) total FROM Opportunity WHERE ... LIMIT 10',
      'Fetch ALL groups for accurate totals. Only use LIMIT for non-aggregate display queries.'
    )
    return {
      message: 'LIMIT not allowed with aggregate functions',
      suggestions,
    }
  }

  // Parse "Invalid field for GROUP BY"
  if (errorContent.includes('GROUP BY') && errorContent.includes('Invalid field')) {
    suggestions.push(
      'The field used in GROUP BY may not be groupable. Check if the field is a standard field or a formula field.',
      'Common groupable fields on Opportunity: Building_Name__c, StageName, Order_Stattus__c, cm_Sales_Person__r.Name',
      'Building_Community__c is NOT groupable on Opportunity (platform restriction).'
    )
    return {
      message: 'Invalid field for GROUP BY',
      suggestions,
    }
  }

  // Parse "Object does not exist"
  if (errorContent.includes('does not exist') || errorContent.includes('sObject type')) {
    suggestions.push(
      'The object name may be misspelled. Check the exact API name.',
      'Common objects: Opportunity, Case, Account, Contact, Property_Inventory__c, Lead, Task'
    )
    return {
      message: 'Object does not exist or is not accessible',
      suggestions,
    }
  }

  // Generic fallback
  return {
    message: errorContent.slice(0, 200),
    suggestions: [
      'Review the SOQL query for syntax errors.',
      'NOT LIKE requires parentheses: (NOT field LIKE \'%value%\')',
      'Date literals must be UNQUOTED: WHERE Date >= 2026-01-01 (not \'2026-01-01\')',
      'Building_Community__c is NOT groupable on Opportunity — use Building_Name__c or Property_Inventory__c instead.',
      'Ensure no duplicate WHERE/AND clauses.',
      'Remove LIMIT from aggregate queries — fetch all groups for accurate totals.',
    ],
  }
}

/** Extract the problematic part from an error message around a keyword. */
function extractProblemArea(errorContent: string, keyword: string): string | undefined {
  const idx = errorContent.indexOf(keyword)
  if (idx === -1) return undefined
  const start = Math.max(0, idx - 40)
  const end = Math.min(errorContent.length, idx + keyword.length + 40)
  return errorContent.slice(start, end)
}
