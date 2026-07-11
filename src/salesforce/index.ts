// Public entry point for the Salesforce connector. Routes import from here only.
export { answerSalesforceQuery, isSalesforceQuery, type SalesforceResult } from './query'
export { getSalesforceConfig } from './config'
export { matchTool, type ToolMatch } from './tool-matcher'
export { TOOL_CATALOG, getToolByName, type ToolResult, type ToolDefinition } from './tools'
export { resolveSynonyms, type SynonymEntry } from './synonyms'
export { getMetricsSummary, exportMetrics, recordMetric, recordError, recordGuardrailBlock } from './observability'
export { validateSOQL, validateFieldExists, sanitizeSOQLInput } from './guardrails'
