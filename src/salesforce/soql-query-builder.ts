// SOQL Query Builder — structured API for building correct SOQL queries.
// The LLM can use this instead of writing raw SOQL to avoid syntax errors.
//
// Two usage modes:
// 1. LLM writes a JSON spec → builder converts to SOQL
// 2. Code uses builder functions directly for common patterns

import { ALLOWED_OBJECTS } from './schema'
import { validateSoql } from './soql-validator'

// ─── Types ───────────────────────────────────────────────────────────────────

export type SoqlOperator =
  | '=' | '!=' | '>' | '<' | '>=' | '<='
  | 'LIKE' | 'NOT LIKE'
  | 'IN' | 'NOT IN'
  | 'INCLUDES' | 'EXCLUDES'

export interface SoqlFilter {
  /** Field API name (e.g., "Name", "Sold_By_Nshama__c", "Account.Name") */
  field: string
  /** Comparison operator */
  op: SoqlOperator
  /** Value for single-value operators (=, !=, >, <, >=, <=, LIKE, NOT LIKE) */
  value?: string | number | boolean
  /** Values for multi-value operators (IN, NOT IN, INCLUDES, EXCLUDES) */
  values?: (string | number)[]
}

export interface SoqlAggregation {
  /** Aggregate function */
  function: 'COUNT' | 'COUNT_DISTINCT' | 'SUM' | 'AVG' | 'MIN' | 'MAX'
  /** Field to aggregate (use "Id" for COUNT) */
  field: string
  /** Optional alias for the result */
  alias?: string
}

export interface SoqlSortSpec {
  /** Field to sort by (or aggregation alias) */
  field: string
  /** Sort direction */
  direction: 'ASC' | 'DESC'
}

export interface SoqlQuerySpec {
  /** Object to query (e.g., "Opportunity", "Case") */
  object: string
  /** Fields to SELECT (e.g., ["Name", "Account.Name", "Net_Amount__c"]) */
  fields?: string[]
  /** Aggregations (e.g., COUNT, SUM) */
  aggregations?: SoqlAggregation[]
  /** WHERE conditions */
  filters?: SoqlFilter[]
  /** GROUP BY fields */
  groupBy?: string[]
  /** HAVING conditions (for aggregate filters) */
  having?: SoqlFilter[]
  /** ORDER BY */
  orderBy?: SoqlSortSpec
  /** LIMIT (default 200 for non-aggregate, no limit for aggregate) */
  limit?: number
}

// ─── Builder Functions ───────────────────────────────────────────────────────

/**
 * Build a SOQL query from a structured spec.
 *
 * @example
 * const soql = buildSoql({
 *   object: 'Opportunity',
 *   aggregations: [
 *     { function: 'COUNT', field: 'Id', alias: 'totalDeals' },
 *     { function: 'SUM', field: 'Net_Amount__c', alias: 'totalRevenue' }
 *   ],
 *   filters: [
 *     { field: 'Sold_By_Nshama__c', op: '=', value: 'NEW SALE' },
 *     { field: 'Name', op: 'NOT LIKE', value: '%Miscellaneous%' }
 *   ]
 * })
 * // → SELECT COUNT(Id) totalDeals, SUM(Net_Amount__c) totalRevenue
 * //   FROM Opportunity
 * //   WHERE Sold_By_Nshama__c = 'NEW SALE' AND (NOT Name LIKE '%Miscellaneous%')
 */
export function buildSoql(spec: SoqlQuerySpec): string {
  // Validate object
  const objectApi = ALLOWED_OBJECTS.find(o => o.toLowerCase() === spec.object.toLowerCase())
  if (!objectApi) {
    throw new Error(`Invalid object: "${spec.object}". Allowed: ${ALLOWED_OBJECTS.join(', ')}`)
  }

  // Validate field names
  validateFieldNames(spec)

  const parts: string[] = []

  // ── SELECT ──
  const selectParts: string[] = []

  // Regular fields
  if (spec.fields && spec.fields.length > 0) {
    selectParts.push(...spec.fields)
  }

  // Aggregations
  if (spec.aggregations && spec.aggregations.length > 0) {
    for (const agg of spec.aggregations) {
      const alias = agg.alias ? ` ${agg.alias}` : ''
      selectParts.push(`${agg.function}(${agg.field})${alias}`)
    }
  }

  // Default to Id if nothing specified
  if (selectParts.length === 0) {
    selectParts.push('Id')
  }

  parts.push(`SELECT ${selectParts.join(', ')}`)

  // ── FROM ──
  parts.push(`FROM ${objectApi}`)

  // ── WHERE ──
  const whereClause = buildWhereClause(spec.filters)
  if (whereClause) {
    parts.push(`WHERE ${whereClause}`)
  }

  // ── GROUP BY ──
  if (spec.groupBy && spec.groupBy.length > 0) {
    parts.push(`GROUP BY ${spec.groupBy.join(', ')}`)
  }

  // ── HAVING ──
  if (spec.having && spec.having.length > 0) {
    const havingClause = buildWhereClause(spec.having)
    if (havingClause) {
      parts.push(`HAVING ${havingClause}`)
    }
  }

  // ── ORDER BY ──
  if (spec.orderBy) {
    parts.push(`ORDER BY ${spec.orderBy.field} ${spec.orderBy.direction}`)
  }

  // ── LIMIT ──
  const hasAggregate = spec.aggregations && spec.aggregations.length > 0
  const hasGroupBy = spec.groupBy && spec.groupBy.length > 0

  if (hasAggregate && !hasGroupBy) {
    // Aggregate without GROUP BY → no LIMIT (Salesforce restriction)
    // Don't add LIMIT
  } else if (spec.limit !== undefined && spec.limit > 0) {
    parts.push(`LIMIT ${Math.min(spec.limit, 500)}`)
  } else if (!hasAggregate) {
    // Non-aggregate → default LIMIT 200
    parts.push('LIMIT 200')
  }

  return parts.join('\n')
}

// ─── WHERE Clause Builder ────────────────────────────────────────────────────

function buildWhereClause(filters?: SoqlFilter[]): string | null {
  if (!filters || filters.length === 0) return null

  const conditions: string[] = []
  for (const filter of filters) {
    conditions.push(buildFilterCondition(filter))
  }

  return conditions.join(' AND ')
}

function buildFilterCondition(filter: SoqlFilter): string {
  const field = filter.field

  switch (filter.op) {
    case '=':
    case '!=':
    case '>':
    case '<':
    case '>=':
    case '<=':
      return `${field} ${filter.op} ${formatValue(filter.value!)}`

    case 'LIKE':
      return `${field} LIKE ${formatValue(filter.value!)}`

    case 'NOT LIKE': {
      // CRITICAL: NOT LIKE requires parentheses in SOQL after AND.
      // WHERE (NOT field LIKE 'value') — NOT WHERE NOT field LIKE 'value'
      return `(NOT ${field} LIKE ${formatValue(filter.value!)})`
    }

    case 'IN':
      return `${field} IN (${filter.values!.map(formatValue).join(', ')})`

    case 'NOT IN': {
      // CRITICAL: NOT IN must use "NOT field IN" syntax
      return `NOT ${field} IN (${filter.values!.map(formatValue).join(', ')})`
    }

    case 'INCLUDES':
      return `${field} INCLUDES (${filter.values!.map(formatValue).join(', ')})`

    case 'EXCLUDES':
      return `${field} EXCLUDES (${filter.values!.map(formatValue).join(', ')})`

    default:
      throw new Error(`Unknown operator: ${filter.op}`)
  }
}

function formatValue(value: string | number | boolean): string {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  // String — escape single quotes
  const escaped = String(value).replace(/'/g, "\\'")
  return `'${escaped}'`
}

// ─── Field Validation ────────────────────────────────────────────────────────

// Known fields per object (subset of common fields to validate against)
const KNOWN_FIELDS: Record<string, Set<string>> = {
  Opportunity: new Set([
    'Id', 'Name', 'AccountId', 'Account.Name', 'Account.Phone', 'Account.Email__c',
    'StageName', 'Amount', 'Net_Amount__c', 'CloseDate', 'Order_Date__c',
    'Property_Booked_Date__c', 'Sold_By_Nshama__c', 'IsWon', 'IsClosed',
    'Building_Name__c', 'Building_Community__c', 'Sales_Room__c',
    'Order_Stattus__c', 'Milestone_Current_Status__c', 'Current_Mortgage_Status__c',
    'cm_Sales_Person__r.Name', 'cm_Agency_Name__r.Name', 'cm_Agent_Name__r.Name',
    'cm_Lead_Channel__c', 'LeadSource', 'New_Selling_Price_AED__c',
    'Owner.Name', 'CreatedDate', 'LastModifiedDate',
  ]),
  Case: new Set([
    'Id', 'CaseNumber', 'Subject', 'Status', 'Priority', 'Origin', 'Type',
    'AccountId', 'ContactId', 'ParentId', 'CreatedDate', 'ClosedDate',
    'eService_Admin_Name__c', 'RecordType.Name', 'Case_Type__c',
    'Civil_Sub_Category__c', 'Carpentry_Sub_category__c', 'Painting_Sub_Category__c',
    'Mechanical_Sub_category__c', 'Electrical_Sub_Category__c', 'Plumbing_Sub_Category__c',
    'Opporutniy_Name__c', 'Violation_Incident_Date__c', 'Violation_Category__c',
  ]),
  Account: new Set([
    'Id', 'Name', 'Industry', 'BillingCity', 'BillingCountry', 'BillingState',
    'Phone', 'Email__c', 'RecordType.Name', 'cm_Nationality__pc', 'Age__c',
    'Country_of_Residence_Billing_country__c', 'Primary_Contact__r.Name',
    'Opportunity_Count__c',
  ]),
  Property_Inventory__c: new Set([
    'Id', 'Name', 'Building_Community__c', 'Building_Name__c', 'Property_Status__c',
    'Property_Type__c', 'Type__c', 'Actual_Rent_Aed__c', 'Advertised_Rent_Aed__c',
    'Assignable_Area__c', 'Selling_Price__c', 'Net_Selling_Price__c',
    'Estimated_Completion_Date__c', 'Property_Usage__c',
  ]),
}

function validateFieldNames(spec: SoqlQuerySpec): void {
  const objectFields = KNOWN_FIELDS[spec.object]
  if (!objectFields) return // Unknown object — skip validation

  const warnings: string[] = []

  // Check SELECT fields
  if (spec.fields) {
    for (const field of spec.fields) {
      if (!objectFields.has(field) && !field.startsWith('Id')) {
        warnings.push(`Field "${field}" may not exist on ${spec.object}`)
      }
    }
  }

  // Check filter fields
  if (spec.filters) {
    for (const filter of spec.filters) {
      if (!objectFields.has(filter.field)) {
        warnings.push(`Filter field "${filter.field}" may not exist on ${spec.object}`)
      }
    }
  }

  // Check GROUP BY fields
  if (spec.groupBy) {
    for (const field of spec.groupBy) {
      if (!objectFields.has(field)) {
        warnings.push(`GROUP BY field "${field}" may not exist on ${spec.object}`)
      }
    }
  }

  // Log warnings (don't block — let Salesforce validate)
  if (warnings.length > 0) {
    console.warn('[soql-query-builder] Field validation warnings:', warnings)
  }
}

// ─── Pre-built Query Patterns ────────────────────────────────────────────────

/**
 * Build a sales summary query for Opportunity.
 * Applies mandatory exclusions and default filters automatically.
 */
export function buildOpportunityQuery(overrides?: {
  fields?: string[]
  aggregations?: SoqlAggregation[]
  filters?: SoqlFilter[]
  groupBy?: string[]
  orderBy?: SoqlSortSpec
  limit?: number
}): string {
  const defaultFilters: SoqlFilter[] = [
    // Default sales filter
    { field: 'Sold_By_Nshama__c', op: '=', value: 'NEW SALE' },
    // Mandatory exclusions
    { field: 'Name', op: 'NOT LIKE', value: '%Miscellaneous%' },
    { field: 'Name', op: 'NOT LIKE', value: '%RTL%' },
    { field: 'Name', op: 'NOT LIKE', value: '%PK%' },
    { field: 'Name', op: 'NOT LIKE', value: '%Plot%' },
    { field: 'Building_Name__c', op: 'NOT LIKE', value: '%Al Qudra%' },
    { field: 'Building_Name__c', op: 'NOT LIKE', value: '%Alqudra%' },
    { field: 'Building_Name__c', op: 'NOT LIKE', value: '%ALQDR%' },
    { field: 'Building_Name__c', op: 'NOT LIKE', value: '%parking%' },
    // Test record exclusions
    { field: 'Amount', op: '!=', value: 1 },
    { field: 'CloseDate', op: '!=', value: '2032-12-28' },
  ]

  const spec: SoqlQuerySpec = {
    object: 'Opportunity',
    fields: overrides?.fields,
    aggregations: overrides?.aggregations,
    filters: [...defaultFilters, ...(overrides?.filters || [])],
    groupBy: overrides?.groupBy,
    orderBy: overrides?.orderBy || { field: 'Order_Date__c', direction: 'DESC' },
    limit: overrides?.limit,
  }

  return buildSoql(spec)
}

/**
 * Build a case query with common filters.
 */
export function buildCaseQuery(overrides?: {
  fields?: string[]
  filters?: SoqlFilter[]
  groupBy?: string[]
  orderBy?: SoqlSortSpec
  limit?: number
}): string {
  const spec: SoqlQuerySpec = {
    object: 'Case',
    fields: overrides?.fields || ['Id', 'CaseNumber', 'Subject', 'Status', 'Priority', 'Origin'],
    filters: overrides?.filters,
    groupBy: overrides?.groupBy,
    orderBy: overrides?.orderBy || { field: 'CreatedDate', direction: 'DESC' },
    limit: overrides?.limit || 100,
  }

  return buildSoql(spec)
}

/**
 * Build a property inventory query with common filters.
 */
export function buildPropertyQuery(overrides?: {
  fields?: string[]
  filters?: SoqlFilter[]
  groupBy?: string[]
  orderBy?: SoqlSortSpec
  limit?: number
}): string {
  const spec: SoqlQuerySpec = {
    object: 'Property_Inventory__c',
    fields: overrides?.fields || ['Id', 'Name', 'Building_Community__c', 'Property_Status__c', 'Type__c'],
    filters: overrides?.filters,
    groupBy: overrides?.groupBy,
    orderBy: overrides?.orderBy || { field: 'Name', direction: 'ASC' },
    limit: overrides?.limit || 200,
  }

  return buildSoql(spec)
}

// ─── JSON Spec Parser (for LLM output) ──────────────────────────────────────

/**
 * Parse a JSON spec from the LLM and convert to SOQL.
 * This is the bridge between the LLM's JSON output and the query builder.
 *
 * @example
 * const spec = {
 *   object: "Opportunity",
 *   aggregations: [{ function: "COUNT", field: "Id", alias: "cnt" }],
 *   filters: [{ field: "Sold_By_Nshama__c", op: "=", value: "NEW SALE" }]
 * }
 * const soql = buildFromJsonSpec(spec)
 */
export function buildFromJsonSpec(spec: Record<string, unknown>): { soql: string; error?: string } {
  try {
    // Validate required fields
    if (!spec.object || typeof spec.object !== 'string') {
      return { soql: '', error: 'Missing required field: object' }
    }

    // Validate object exists
    const objectName = String(spec.object)
    const objectApi = ALLOWED_OBJECTS.find(o => o.toLowerCase() === objectName.toLowerCase())
    if (!objectApi) {
      return { soql: '', error: `Invalid object: "${objectName}". Allowed: ${ALLOWED_OBJECTS.join(', ')}` }
    }

    // Parse fields
    const fields = Array.isArray(spec.fields) ? spec.fields.filter(f => typeof f === 'string') : undefined

    // Parse aggregations
    const aggregations: SoqlAggregation[] = []
    if (Array.isArray(spec.aggregations)) {
      for (const agg of spec.aggregations) {
        if (agg && typeof agg === 'object' && typeof agg.function === 'string' && typeof agg.field === 'string') {
          aggregations.push({
            function: agg.function.toUpperCase() as SoqlAggregation['function'],
            field: agg.field,
            alias: typeof agg.alias === 'string' ? agg.alias : undefined,
          })
        }
      }
    }

    // Parse filters
    const filters: SoqlFilter[] = []
    if (Array.isArray(spec.filters)) {
      for (const f of spec.filters) {
        if (f && typeof f === 'object' && typeof f.field === 'string' && typeof f.op === 'string') {
          filters.push({
            field: f.field,
            op: f.op as SoqlOperator,
            value: f.value,
            values: Array.isArray(f.values) ? f.values : undefined,
          })
        }
      }
    }

    // Parse groupBy
    const groupBy = Array.isArray(spec.groupBy) ? spec.groupBy.filter(g => typeof g === 'string') : undefined

    // Parse orderBy
    let orderBy: SoqlSortSpec | undefined
    if (spec.orderBy && typeof spec.orderBy === 'object') {
      const ob = spec.orderBy as Record<string, unknown>
      if (typeof ob.field === 'string' && typeof ob.direction === 'string') {
        orderBy = {
          field: ob.field,
          direction: ob.direction.toUpperCase() === 'DESC' ? 'DESC' : 'ASC',
        }
      }
    }

    // Parse limit
    const limit = typeof spec.limit === 'number' ? spec.limit : undefined

    // Build query
    const soql = buildSoql({
      object: objectApi,
      fields,
      aggregations: aggregations.length > 0 ? aggregations : undefined,
      filters: filters.length > 0 ? filters : undefined,
      groupBy,
      orderBy,
      limit,
    })

    return { soql }
  } catch (err) {
    return { soql: '', error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Build and validate a SOQL query from a spec.
 * Returns the validated query or an error.
 */
export function buildAndValidate(spec: SoqlQuerySpec): { soql: string; error?: string } {
  try {
    const soql = buildSoql(spec)
    const validation = validateSoql(soql)

    if (!validation.valid) {
      return { soql: validation.query, error: validation.error }
    }

    if (validation.wasFixed) {
      console.warn('[soql-query-builder] Auto-fixed query:', validation.fixes)
    }

    return { soql: validation.query }
  } catch (err) {
    return { soql: '', error: err instanceof Error ? err.message : String(err) }
  }
}
