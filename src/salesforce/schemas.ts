import { z } from 'zod'

// Schema for tool-matcher LLM output
export const ToolMatchSchema = z.object({
  tool: z.string().nullable().describe('The tool name to execute, or null if no match'),
  confidence: z.enum(['high', 'medium', 'low']).describe('Confidence level'),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).describe('Tool parameters extracted from the question'),
  clarify: z.string().nullable().describe('Clarification question (always null - never ask)'),
})

export type ValidatedToolMatch = z.infer<typeof ToolMatchSchema>

// Schema for follow-up resolver LLM output
export const FollowUpSchema = z.object({
  question: z.string().describe('The resolved standalone question'),
})

export type ValidatedFollowUp = z.infer<typeof FollowUpSchema>

// Schema for ad-hoc SOQL spec output
const FieldSpecSchema = z.object({
  field: z.string().describe('Field API name'),
  alias: z.string().optional().describe('Optional alias for the field'),
})

const AggregationSchema = z.object({
  function: z.enum(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']).describe('Aggregation function'),
  field: z.string().describe('Field to aggregate (use Id for COUNT)'),
  alias: z.string().describe('Alias for the aggregated result'),
})

const SortSpecSchema = z.object({
  field: z.string().describe('Field to sort by'),
  direction: z.enum(['ASC', 'DESC']).describe('Sort direction'),
})

export const AdHocSpecSchema = z.object({
  object: z.string().describe('The primary Salesforce object to query'),
  fields: z.array(FieldSpecSchema).optional().describe('Fields to select'),
  aggregations: z.array(AggregationSchema).optional().describe('Aggregation functions'),
  filters: z.array(z.string()).optional().describe('SOQL WHERE conditions without the WHERE keyword'),
  groupBy: z.array(z.string()).optional().describe('GROUP BY fields'),
  having: z.array(z.string()).optional().describe('HAVING conditions without the HAVING keyword'),
  orderBy: SortSpecSchema.optional().describe('Sort specification'),
  limit: z.number().optional().describe('Maximum rows to return (max 200)'),
})

export type ValidatedAdHocSpec = z.infer<typeof AdHocSpecSchema>

// Schema for intent classification (if needed in future)
export const IntentSchema = z.object({
  intent: z.enum(['salesforce', 'general', 'ambiguous']).describe('Classified intent'),
  confidence: z.number().min(0).max(1).describe('Confidence score'),
  reasoning: z.string().optional().describe('Brief reasoning'),
})

// Validate a tool match from raw LLM JSON
export function validateToolMatch(raw: string): ValidatedToolMatch | null {
  try {
    const parsed = JSON.parse(raw)
    const result = ToolMatchSchema.safeParse(parsed)
    if (result.success) {
      return result.data
    }
    console.error('[salesforce:validation] ToolMatch validation failed:', result.error.issues)
    return null
  } catch (err) {
    console.error('[salesforce:validation] JSON parse failed:', err)
    return null
  }
}

// Validate a follow-up resolution from raw LLM JSON
export function validateFollowUp(raw: string): ValidatedFollowUp | null {
  try {
    const parsed = JSON.parse(raw)
    const result = FollowUpSchema.safeParse(parsed)
    if (result.success) {
      return result.data
    }
    console.error('[salesforce:validation] FollowUp validation failed:', result.error.issues)
    return null
  } catch (err) {
    console.error('[salesforce:validation] JSON parse failed:', err)
    return null
  }
}

// Validate an ad-hoc SOQL spec from raw LLM JSON
export function validateAdHocSpec(raw: string): ValidatedAdHocSpec | null {
  try {
    const parsed = JSON.parse(raw)
    const result = AdHocSpecSchema.safeParse(parsed)
    if (result.success) {
      return result.data
    }
    console.error('[salesforce:validation] AdHocSpec validation failed:', result.error.issues)
    return null
  } catch (err) {
    console.error('[salesforce:validation] JSON parse failed:', err)
    return null
  }
}
