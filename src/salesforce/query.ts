import { chatJson } from '@/lib/ai/provider'
import { followUpResolverPrompt } from '@/lib/ai/prompts'
import { getSalesforceConfig } from './config'
import { soql } from './client'
import { resolveSynonyms } from './synonyms'
import { matchTool } from './tool-matcher'
import { getToolByName } from './tools'
import { executeAdHocSpec } from './spec-executor'
import { validateFollowUp } from './schemas'
import { recordMetric } from './observability'
import { verifyAnswer, quickCheck } from './verifier'
import { expandQuery } from './query-expansion'
import { compressContext, quickCompress } from './context-compression'
import { understandQuery, type UnderstoodQuery } from './query-understanding'
import { executeReActLoop, needsReActLoop } from './react-loop'
import { ragFallback } from './rag-searcher'
import { answerViaMcp } from './mcp-query'
import { crossCheckMcpAnswer } from './cross-check'
import { sanitizeSOQLInput } from './guardrails'
import { features } from '@/lib/feature-flags'

// Cheap pre-filter so we only spend LLM calls when a question is plausibly about the CRM.
const CRM_HINT_RE =
  /\b(salesforce|crm|opportunit(y|ies)|pipeline|deals?|leads?|accounts?|contacts?|tasks?|activit(y|ies)|cases?|closed won|closed lost|stage|stages|sales|revenue|won|lost|quota|prospect|prospects|forecast|community|project|location|bedroom|property|unit|building|inventory|booking|cancellation|transfer|sold|buyer|developer|area|amount|price|value|channel|agent|salesperson|mortgage|milestone|handover|agency|broker|villa|apartment|townhouse|reservation|leased|available|eservice|registration|move.?in|move.?out|transfer case|document request|title deed|tenant|owner|alteration|maintenance|parking|installation|receipt|clearance|invoice|payment|settlement|net amount|net value|booking date|order date|lead source|win rate|conversion|record type|case origin|case channel|phone|email|web|portal)\b/i

export function isSalesforceQuery(query: string): boolean {
  return CRM_HINT_RE.test(query)
}

export interface SalesforceResult {
  context: string
  citation: { documentName: string }
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

// Resolve conversational follow-ups into standalone questions.
async function resolveFollowUp(query: string, history?: ChatTurn[]): Promise<string> {
  if (!history || history.length === 0) return query
  try {
    const transcript = history.slice(-4).map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content.slice(0, 500)}`).join('\n')
    const raw = await chatJson(followUpResolverPrompt(), `${transcript}\nUser: ${query}`)

    // Zod-validated parsing
    const validated = validateFollowUp(raw)
    if (validated) return validated.question.trim()

    // Fallback: raw parse
    console.warn('[salesforce] FollowUp Zod validation failed, falling back to raw parse')
    const parsed = JSON.parse(raw) as { question?: string }
    return parsed.question?.trim() || query
  } catch (err) {
    console.error('[salesforce] follow-up resolution failed, using raw query:', err)
    return query
  }
}

// Detect absolute date references — queries with these should bypass the direct fallback
// and go to the LLM tool matcher, which has proper dateFilter support.
const DATE_REF_RE = /\b(20\d{2}|last (?:month|quarter|year|week|7 days|30 days|90 days)|this (?:month|quarter|year|week)|yesterday|today|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s*[-–]?\s*20\d{2})\b/i

function hasDateReference(query: string): boolean {
  return DATE_REF_RE.test(query)
}

// Vague follow-ups that reference prior context — skip direct fallback, let follow-up resolver + tool matcher handle
const VAGUE_FOLLOWUP_RE = /^((yes|no|ok|and|what about|how about) .{0,30}|(can you |could you )?\b(list|show|show me|get|give me|tell me|display)\b\s*(them|it|those|these|that|the ones|the list|the data|the results|the records)\b)/i

function isVagueFollowUp(query: string): boolean {
  return VAGUE_FOLLOWUP_RE.test(query.trim())
}

// Queries that need the tool matcher (not direct fallback)
const TOOL_MATCHER_EXCLUSIONS_RE = /\b(cancellation rate|cancel percentage|cancel rate|recent cancelled|cancelled deals|individual vs corporate|customer type|account type|top.*customer.*revenue|highest spending|won vs lost|win.?loss|cases by channel|phone vs email|escalated cases?|case escalat|mortgage status|mortgage type|mortgaged vs|active mortgage|cancellation rate by|sales room|bedroom wise|bedroom data|room wise|call inquiries|call channel|phone inquiries|most selling|what selling|best selling|which project|most popular|bedroom.*breakdown|unit type|breakdown by customer|customer names|quarterly|quarter|project.*compare|compare.*project|bedroom.*year|year.*bedroom|communit)\b/i

function needsToolMatcher(query: string): boolean {
  return TOOL_MATCHER_EXCLUSIONS_RE.test(query)
}

// Meta/overview questions — short-circuit with canned answer.
const META_OVERVIEW_RE = /\b(what (all )?(data|information|objects?|fields?)\b.{0,20}\b(crm|salesforce)|what (can|do) you (know|have|see|tell me)\b.{0,20}\b(crm|salesforce)|overview of (the )?(crm|salesforce)|what'?s in (the )?(crm|salesforce))/i

function isMetaOverviewQuery(query: string): boolean {
  return META_OVERVIEW_RE.test(query)
}

const OBJECT_CATALOG = `
Opportunity — sales deals / property-unit sales: pipeline, stages, amounts, close dates, community/location of the unit. Each Opportunity IS one unit sale/transaction.
Property_Inventory__c — the MASTER catalog of every physical unit/property the developer has (sold, available, or rented) — ~17,000+ records.
Opportunity_Property__c — detailed per-transaction unit/property attributes.
Account — companies / customers / buyers.
Contact — individual people (usually linked to an Account).
Lead — unconverted prospects.
Task — activities: tasks, calls, meetings, to-dos.
Case — support / service cases.
`.trim()

function metaOverviewContext(): SalesforceResult {
  const context = `SALESFORCE LIVE CRM DATA — connection is ACTIVE. This is a real-estate developer's CRM. Available objects (ask a specific question about any of these for live numbers):\n${OBJECT_CATALOG}\n\nAsk a specific question to get live data.`
  return { context, citation: { documentName: 'Salesforce (live CRM)' } }
}

/**
 * Answer a CRM question against LIVE Salesforce.
 * 
 * FLOW:
 * 1. Resolve conversational follow-ups
 * 2. Meta/overview short-circuit
 * 3. Direct keyword fallback (SKIP if query has date references or is a vague follow-up)
 * 4. LLM tool matcher (handles date-aware queries properly)
 * 5. Ad-hoc spec fallback
 * 6. Clarification
 */
export async function answerSalesforceQuery(
  rawQuery: string,
  history?: ChatTurn[],
  onMcpStep?: (step: { action: string; detail: string; result?: string }) => void
): Promise<SalesforceResult | null> {
  const startTime = Date.now()
  if (!getSalesforceConfig().enabled) {
    console.error('[salesforce] Salesforce is not enabled/configured')
    return null
  }

  // 3-TIER FALLBACK ARCHITECTURE (Level 1: MCP → Level 2: 100+ tools → Level 3: Pinecone RAG)
  // Toggle with SALESFORCE_USE_MCP=true in env. When MCP is enabled, it's tried FIRST since
  // it has direct access to live Salesforce with the business glossary built in. If MCP
  // genuinely finds nothing relevant (foundInCrm: false) or errors, we fall through to the
  // existing tools+RAG pipeline below instead of giving up — this is the fix for cases like
  // "who is customer of Safi v-6" where one lookup strategy fails but another (tools/RAG)
  // might succeed. Flip SALESFORCE_USE_MCP=false to skip MCP entirely and go straight to
  // tools+RAG (the previous, pre-MCP behavior).
  if (process.env.SALESFORCE_USE_MCP === 'true') {
    console.log('[salesforce] MCP mode enabled — trying answerViaMcp() first (Level 1)')
    const mcpResult = await answerViaMcp(rawQuery, history, onMcpStep)
    recordMetric({
      timestamp: new Date().toISOString(),
      question: rawQuery,
      toolMatched: 'mcp',
      confidence: mcpResult?.foundInCrm ? 'high' : 'low',
      method: 'tool',
      latencyMs: Date.now() - startTime,
      soqlSuccess: !!mcpResult,
      guardrailBlocked: false,
      instructorRetries: 0,
      resultCount: mcpResult?.foundInCrm ? 1 : 0,
    })

    if (mcpResult && mcpResult.foundInCrm) {
      if (features.mcpVerification) {
        // ── MCP VERIFICATION ── same checks tools get, using raw observations as baseline
        const mcpRaw = mcpResult.rawObservations || mcpResult.context
        const quick = quickCheck(rawQuery, mcpRaw, 'mcp')
        if (!quick.ok) {
          console.log('[salesforce] MCP quick check flagged issue:', quick.issue)
        }
        const verification = await verifyAnswer(rawQuery, null, mcpRaw, 'mcp')
        console.log(`[salesforce] MCP verification score: ${verification.score}/100 (${verification.confidence})`)
        if (verification.issues.length > 0) {
          console.log('[salesforce] MCP verification issues:', verification.issues)
        }

        // Low-confidence MCP answer — fall through to tools/RAG which may do better
        if (verification.score < 40 && verification.recommendation !== 'return') {
          console.log('[salesforce] MCP verification low (score=' + verification.score + '), falling through to tools/RAG')
          console.log('[salesforce] MCP found nothing relevant (or errored) — falling through to Level 2 (tools) / Level 3 (RAG)')
        } else {
          if (features.mcpCrossCheck) {
            // ── INDEPENDENT CROSS-CHECK ── verify claimed numbers against a fresh SOQL
            try {
              const crossCheck = await crossCheckMcpAnswer(rawQuery, mcpResult.context)
              if (!crossCheck.verified) {
                console.warn('[salesforce] MCP cross-check discrepancies:', crossCheck.discrepancies)
                const note = `\n\n⚠ **Cross-check note:** ${crossCheck.discrepancies.join(' | ')}`
                mcpResult.context += note
              }
            } catch (err) {
              console.warn('[salesforce] MCP cross-check failed (non-blocking):', err)
            }
          }
          return mcpResult
        }
      } else {
        return mcpResult
      }
    }
    console.log('[salesforce] MCP found nothing relevant (or errored) — falling through to Level 2 (tools) / Level 3 (RAG)')
  }

  // Step 0: QUERY UNDERSTANDING — LLM "thinking" step
  // Corrects grammar, understands intent, extracts parameters, resolves references
  // ALWAYS use LLM understanding — this is the "reasoning" step before routing
  let understanding: UnderstoodQuery
  if (history && history.length > 0) {
    // With history: use LLM to understand context + resolve references
    understanding = await understandQuery(rawQuery, history)
  } else {
    // Without history: ALWAYS use LLM to correct grammar, understand intent
    understanding = await understandQuery(rawQuery)
  }
  
  // Use the clarified version for routing, but log the original
  const query = understanding.clarified || rawQuery
  if (query !== rawQuery) {
    console.log(`[salesforce] query understood: "${rawQuery}" → "${query}" (intent=${understanding.intent}, confidence=${understanding.confidence})`)
  } else {
    console.log('[salesforce] resolved query:', query)
  }

  // Step 2: Meta/overview short-circuit
  if (isMetaOverviewQuery(query)) return metaOverviewContext()

  // Step 3: DIRECT keyword fallback — BUT skip if query has date references, is a vague follow-up, or needs tool matcher
  // Check BOTH original and clarified query — query understanding may transform keywords
  const skipDirect = hasDateReference(query) || isVagueFollowUp(query) || needsToolMatcher(query) || needsToolMatcher(rawQuery)
  if (skipDirect) {
    console.log(`[salesforce] skipping direct fallback (dateRef=${hasDateReference(query)}, vagueFollowUp=${isVagueFollowUp(query)}, needsTool=${needsToolMatcher(query) || needsToolMatcher(rawQuery)})`)
  }
  if (!skipDirect) {
    const directResult = await directFallback(query)
    if (directResult) {
      console.log('[salesforce] direct fallback returned result (no LLM needed)')

      // ── CONTEXT COMPRESSION ──
      if (directResult.context.length > 3000) {
        directResult.context = await compressContext(directResult.context)
      } else {
        directResult.context = quickCompress(directResult.context)
      }

      // ── REAL-TIME VERIFICATION ──
      const quick = quickCheck(query, directResult.context, 'direct')
      if (!quick.ok) {
        console.log('[salesforce] quick check flagged issue:', quick.issue)
      }
      const verification = await verifyAnswer(query, null, directResult.context, 'direct')
      console.log(`[salesforce] verification score: ${verification.score}/100 (${verification.confidence})`)
      if (verification.issues.length > 0) {
        console.log('[salesforce] verification issues:', verification.issues)
      }

      // If verification says clarify, and we have a refined answer, use it
      if (verification.recommendation === 'clarify' && verification.refinedAnswer) {
        return { context: verification.refinedAnswer, citation: { documentName: 'Salesforce (live CRM)' } }
      }

      recordMetric({ timestamp: new Date().toISOString(), question: rawQuery, toolMatched: null, confidence: verification.confidence, method: 'direct', latencyMs: Date.now() - startTime, soqlSuccess: true, guardrailBlocked: false, instructorRetries: 0, resultCount: 1 })
      return directResult
    }
  }

  // Step 4: Synonym resolution
  const synonyms = resolveSynonyms(query)
  console.log('[salesforce] synonyms found:', synonyms.map(s => `${s.field}${s.value ? '=' + s.value : ''}`).join(', ') || 'none')

  // Step 4.5: Query expansion (break complex questions into sub-queries)
  const expansion = await expandQuery(query)
  if (expansion.expand && expansion.subQueries.length >= 2) {
    console.log('[salesforce] query expanded:', expansion.subQueries)
    // Execute each sub-query and merge results
    const subResults: string[] = []
    for (const subQ of expansion.subQueries) {
      try {
        const subMatch = await matchTool(subQ)
        if (subMatch.tool) {
          const subTool = getToolByName(subMatch.tool)
          if (subTool) {
            const subResult = await subTool.execute(subMatch.params)
            if (subResult?.context) subResults.push(subResult.context)
          }
        }
      } catch (err) {
        console.warn('[salesforce] sub-query failed:', subQ, err)
      }
    }
    if (subResults.length > 0) {
      const merged = subResults.join('\n\n')
      console.log('[salesforce] merged sub-query results')
      recordMetric({ timestamp: new Date().toISOString(), question: rawQuery, toolMatched: 'expanded', confidence: 'high', method: 'expansion', latencyMs: Date.now() - startTime, soqlSuccess: true, guardrailBlocked: false, instructorRetries: 0, resultCount: subResults.length })
      return { context: merged, citation: { documentName: 'Salesforce (live CRM)' } }
    }
  }

  // Step 5: LLM tool matcher (only if direct fallback didn't match)
  // Enrich query with extracted entities so the tool matcher can use them
  let matcherQuery = query
  if (understanding.entities.length > 0) {
    const entityStr = understanding.entities.map(e => `${e.type}: ${e.value}`).join(', ')
    matcherQuery = `${query} [entities: ${entityStr}]`
  }
  const match = await matchTool(matcherQuery)
  console.log('[salesforce] tool match:', JSON.stringify(match))

  // Step 6: Execute the matched tool
  if (match.tool && !match.clarify) {
    const tool = getToolByName(match.tool)
    if (tool) {
      console.log(`[salesforce] executing tool: ${match.tool}`)
      const enrichedParams = { ...match.params }
      // Enrich params with extracted entities from query understanding
      for (const entity of understanding.entities) {
        if (entity.type === 'project' && !enrichedParams.community) enrichedParams.community = entity.value
        if (entity.type === 'customer' && !enrichedParams.name) enrichedParams.name = entity.value
        if (entity.type === 'salesperson' && !enrichedParams.person) enrichedParams.person = entity.value
      }
      for (const syn of synonyms) {
        if (syn.value) {
          if (syn.field === 'Building_Community__c' && !enrichedParams.community) enrichedParams.community = syn.value
          if (syn.field === 'cm_Sales_Person__r.Name' && !enrichedParams.person) enrichedParams.person = syn.value
          if (syn.field === 'StageName' && !enrichedParams.stage) {
            if (syn.value === 'Closed Won') enrichedParams.stage = 'won'
            else if (syn.value === 'Closed Lost') enrichedParams.stage = 'lost'
          }
          if (syn.field === 'Order_Stattus__c' && !enrichedParams.type) {
            if (syn.value === 'BOOKED_CANCELLED' || syn.value === 'SMT_CANCELLED') enrichedParams.type = 'cancelled'
            else if (syn.value === 'TRANSFERED') enrichedParams.type = 'transferred'
          }
        }
      }

      const result = await tool.execute(enrichedParams)
      if (result) {
        console.log('[salesforce] tool returned result successfully')

        // ── CONTEXT COMPRESSION ──
        let context = result.context
        if (context.length > 3000) {
          context = await compressContext(context)
          result.context = context
        } else {
          result.context = quickCompress(context)
        }

        // ── REAL-TIME VERIFICATION ──
        const quick = quickCheck(query, result.context, 'tool')
        if (!quick.ok) {
          console.log('[salesforce] quick check flagged issue:', quick.issue)
        }
        const verification = await verifyAnswer(query, null, result.context, `tool:${match.tool}`)
        console.log(`[salesforce] verification score: ${verification.score}/100 (${verification.confidence})`)
        if (verification.issues.length > 0) {
          console.log('[salesforce] verification issues:', verification.issues)
        }

        // Only override with refinedAnswer if score is very low AND there's actual data issues
        // Don't override valid tool results with SOQL suggestions
        if (verification.recommendation === 'clarify' && verification.refinedAnswer && verification.score < 20) {
          console.log('[salesforce] verifier override (score=' + verification.score + '), using refinedAnswer')
          return { context: verification.refinedAnswer, citation: { documentName: 'Salesforce (live CRM)' } }
        }

        // If verifier says retry, fall through to ad-hoc/catch-all instead of returning
        if (verification.recommendation === 'retry' && verification.score < 40) {
          console.log('[salesforce] verifier recommends retry (score=' + verification.score + '), trying fallback')
        } else {
          recordMetric({ timestamp: new Date().toISOString(), question: rawQuery, toolMatched: match.tool, confidence: verification.confidence, method: 'tool', latencyMs: Date.now() - startTime, soqlSuccess: true, guardrailBlocked: false, instructorRetries: 0, resultCount: 1 })
          return result
        }
      }
      console.log('[salesforce] tool returned null, trying fallback')
    }
  }

  // Step 6.5: ReAct loop for complex multi-step questions
  // If the question needs multi-step reasoning, use the ReAct loop
  if (needsReActLoop(query) || needsReActLoop(rawQuery)) {
    console.log('[salesforce] question needs multi-step reasoning, using ReAct loop')
    try {
      const reactResult = await executeReActLoop(query, history)
      if (reactResult.finalAnswer && reactResult.confidence !== 'low') {
        console.log(`[salesforce] ReAct loop completed in ${reactResult.steps.length} steps (${reactResult.totalLatencyMs}ms)`)
        
        // Verify the ReAct result
        const verification = await verifyAnswer(query, null, reactResult.finalAnswer, 'react-loop')
        console.log(`[salesforce] ReAct verification score: ${verification.score}/100`)
        
        if (verification.score >= 40) {
          recordMetric({ timestamp: new Date().toISOString(), question: rawQuery, toolMatched: 'react-loop', confidence: verification.confidence, method: 'react-loop', latencyMs: Date.now() - startTime, soqlSuccess: true, guardrailBlocked: false, instructorRetries: 0, resultCount: reactResult.toolsUsed.length })
          return { context: reactResult.finalAnswer, citation: { documentName: 'Salesforce (live CRM)' } }
        }
      }
      console.log('[salesforce] ReAct loop did not produce confident result, trying fallback')
    } catch (err) {
      console.warn('[salesforce] ReAct loop failed:', err)
    }
  }

  // Step 7: Ad-hoc SOQL spec fallback
  if (match.confidence !== 'high' || !match.tool) {
    console.log('[salesforce] trying ad-hoc spec fallback')
    const fallback = await executeAdHocSpec(query)
    if (fallback) {
      console.log('[salesforce] ad-hoc spec returned result')

      // ── REAL-TIME VERIFICATION ──
      const verification = await verifyAnswer(query, null, fallback.context, 'ad-hoc')
      console.log(`[salesforce] verification score: ${verification.score}/100 (${verification.confidence})`)
      if (verification.issues.length > 0) {
        console.log('[salesforce] verification issues:', verification.issues)
      }

      if (verification.recommendation === 'clarify' && verification.refinedAnswer) {
        return { context: verification.refinedAnswer, citation: { documentName: 'Salesforce (live CRM)' } }
      }

      recordMetric({ timestamp: new Date().toISOString(), question: rawQuery, toolMatched: match.tool, confidence: verification.confidence, method: 'ad-hoc', latencyMs: Date.now() - startTime, soqlSuccess: true, guardrailBlocked: false, instructorRetries: 0, resultCount: 1 })
      return fallback
    }
  }

  // Step 8: Last resort — always return something. Try a generic SOQL query based on keywords.
  console.log('[salesforce] all methods exhausted, attempting keyword-based catch-all')
  const catchAll = await catchAllFallback(query)
  if (catchAll) {

    // ── REAL-TIME VERIFICATION ──
    const verification = await verifyAnswer(query, null, catchAll.context, 'catch-all')
    console.log(`[salesforce] verification score: ${verification.score}/100 (${verification.confidence})`)
    if (verification.issues.length > 0) {
      console.log('[salesforce] verification issues:', verification.issues)
    }

    if (verification.recommendation === 'clarify' && verification.refinedAnswer) {
      return { context: verification.refinedAnswer, citation: { documentName: 'Salesforce (live CRM)' } }
    }

    recordMetric({ timestamp: new Date().toISOString(), question: rawQuery, toolMatched: match.tool, confidence: verification.confidence, method: 'catch-all', latencyMs: Date.now() - startTime, soqlSuccess: true, guardrailBlocked: false, instructorRetries: 0, resultCount: 1 })
    return catchAll
  }

  // Step 9: RAG fallback — semantic search over indexed Salesforce data. Catches questions
  // no tool/spec/keyword-match covers (e.g. ad-hoc cross-field breakdowns) by searching
  // actual indexed records instead of giving up or asking the user to clarify.
  console.log('[salesforce] tool/spec/catch-all exhausted, trying RAG semantic search')
  const ragResult = await ragFallback(query)
  if (ragResult) {
    const verification = await verifyAnswer(query, null, ragResult.context, 'rag')
    console.log(`[salesforce] RAG verification score: ${verification.score}/100 (${verification.confidence})`)
    if (verification.issues.length > 0) {
      console.log('[salesforce] RAG verification issues:', verification.issues)
    }

    if (verification.score >= 25) {
      recordMetric({ timestamp: new Date().toISOString(), question: rawQuery, toolMatched: null, confidence: verification.confidence, method: 'fallback', latencyMs: Date.now() - startTime, soqlSuccess: true, guardrailBlocked: false, instructorRetries: 0, resultCount: 1 })
      return ragResult
    }
    console.log('[salesforce] RAG result too low confidence, falling through to final message')
  }

  // Step 10: Absolute final fallback — query all objects for any mention of the key terms
  recordMetric({ timestamp: new Date().toISOString(), question: rawQuery, toolMatched: null, confidence: 'low', method: 'fallback', latencyMs: Date.now() - startTime, soqlSuccess: false, soqlError: 'No method matched', guardrailBlocked: false, instructorRetries: 0, resultCount: 0 })
  return { context: `I couldn't find a specific match for "${query}" in the CRM. Could you rephrase your question or ask about sales, properties, cases, or customers directly?`, citation: { documentName: 'Salesforce (live CRM)' } }
}

// ─────────────────────────────────────────────────────────────────────────────
// DATA QUALITY FILTER — excludes test/placeholder records from results
// NOTE: SOQL doesn't support NOT(...) well; use individual AND conditions
// ─────────────────────────────────────────────────────────────────────────────
// SOQL-safe test record filter — mirrors isTestOpportunity() logic for direct fallback queries
// NOTE: SOQL doesn't support NOT (cond AND cond) — use separate AND NOT clauses instead
const TEST_RECORD_AND = " AND Amount != 1 AND CloseDate < 2032-01-01 AND cm_Sales_Person__r.Name != 'Salesforce Admin'"

// ─────────────────────────────────────────────────────────────────────────────
// DIRECT KEYWORD FALLBACK — runs when query has no date references and is not a vague follow-up.
// Handles the most common CRM queries with hardcoded SOQL.
// ─────────────────────────────────────────────────────────────────────────────

// Detects a likely proper-noun entity (project/community/customer name) in the ORIGINAL
// (not lowercased) query — e.g. "Address Grand Downtown", "Anil Pardesi". Used to stop generic
// keyword patterns (like "total sales") from swallowing a specific name and running an
// unfiltered aggregate instead of letting the tool-matcher/synonym layer handle it properly.
const CAPITALIZED_ENTITY_RE = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}\b/

function hasLikelyEntityName(query: string): boolean {
  return CAPITALIZED_ENTITY_RE.test(query)
}

async function directFallback(query: string): Promise<SalesforceResult | null> {
  const q = query.toLowerCase()
  const hasEntity = hasLikelyEntityName(query)

  // Extract "top N" limit from query
  const topMatch = q.match(/\btop\s+(\d+)/)
  const limit = topMatch ? parseInt(topMatch[1], 10) : 20

  // ── COMMUNITY LISTING (highest priority — user wants community names) ──
  if (q.includes('communit') && (q.includes('list') || q.includes('show') || q.includes('give') || q.includes('all') || q.includes('available') || q.includes('what'))) {
    const result = await soql(`SELECT Building_Community__c FROM Property_Inventory__c WHERE Building_Community__c != null GROUP BY Building_Community__c ORDER BY Building_Community__c`)
    return formatDirectResult(result, 'Property_Inventory__c')
  }

  // ── LIST / SHOW QUERIES (highest priority — user wants records, not aggregates) ──

  // List/show won opportunities
  if (q.includes('won') && (q.includes('list') || q.includes('show') || q.includes('opportunit') || q.includes('deal') || q.includes('sale'))) {
    const result = await soql(`SELECT Name, StageName, Amount, CloseDate, Building_Name__c, Building_Community__c, cm_Sales_Person__r.Name FROM Opportunity WHERE IsWon = true${TEST_RECORD_AND} ORDER BY CloseDate DESC LIMIT ${limit}`)
    return formatDirectResult(result, 'Opportunity')
  }

  // List/show lost opportunities — IsLost doesn't exist, use IsClosed + IsWon
  if (q.includes('lost') && (q.includes('list') || q.includes('show') || q.includes('opportunit') || q.includes('deal'))) {
    const result = await soql(`SELECT Name, StageName, Amount, CloseDate, Building_Name__c, Building_Community__c, cm_Sales_Person__r.Name FROM Opportunity WHERE IsClosed = true AND IsWon = false${TEST_RECORD_AND} ORDER BY CloseDate DESC LIMIT ${limit}`)
    return formatDirectResult(result, 'Opportunity')
  }

  // List/show opportunities (no won/lost specified — default to won) — but NOT salesperson/agent queries
  if ((q.includes('list') || q.includes('show') || q.includes('top')) && (q.includes('opportunit') || q.includes('deal') || q.includes('sale')) && !q.includes('lost') && !q.includes('pipeline') && !q.includes('open') && !q.includes('salesperson') && !q.includes('by person') && !q.includes('by agent') && !q.includes('who is the top')) {
    const result = await soql(`SELECT Name, StageName, Amount, CloseDate, Building_Name__c, Building_Community__c, cm_Sales_Person__r.Name FROM Opportunity WHERE IsWon = true${TEST_RECORD_AND} ORDER BY CloseDate DESC LIMIT ${limit}`)
    return formatDirectResult(result, 'Opportunity')
  }

  // "list them" / "show them" / "show me" — catch vague follow-ups that reference previous context
  if ((q.includes('list them') || q.includes('show them') || q.includes('show me') || q.includes('list it') || q.includes('show it')) && !q.includes('document') && !q.includes('report')) {
    const result = await soql(`SELECT Name, StageName, Amount, CloseDate, Building_Name__c, Building_Community__c, cm_Sales_Person__r.Name FROM Opportunity WHERE IsWon = true${TEST_RECORD_AND} ORDER BY CloseDate DESC LIMIT 20`)
    return formatDirectResult(result, 'Opportunity')
  }

  // List/show cancelled
  if ((q.includes('list') || q.includes('show') || q.includes('top')) && (q.includes('cancel') || q.includes('cancelled') || q.includes('canceled'))) {
    const result = await soql(`SELECT Name, Building_Community__c, Amount, Order_Stattus__c FROM Opportunity WHERE Order_Stattus__c IN ('BOOKED_CANCELLED', 'SMT_CANCELLED')${TEST_RECORD_AND} ORDER BY CloseDate DESC LIMIT ${limit}`)
    return formatDirectResult(result, 'Opportunity')
  }

  // List/show recent/latest deals — but NOT "top salesperson/agent/person" (those go to aggregate)
  if ((q.includes('list') || q.includes('show') || q.includes('recent') || q.includes('latest') || q.includes('top')) && (q.includes('deal') || q.includes('sale') || q.includes('opportunit')) && !q.includes('salesperson') && !q.includes('by person') && !q.includes('by agent') && !q.includes('who is the top')) {
    const result = await soql(`SELECT Name, StageName, Amount, CloseDate, Building_Name__c, Building_Community__c, cm_Sales_Person__r.Name FROM Opportunity WHERE StageName = 'Closed Won'${TEST_RECORD_AND} ORDER BY CreatedDate DESC LIMIT ${limit}`)
    return formatDirectResult(result, 'Opportunity')
  }

  // List/show by community — use Building_Name__c (groupable)
  if ((q.includes('list') || q.includes('show')) && (q.includes('by community') || q.includes('by location') || q.includes('by project'))) {
    const result = await soql(`SELECT Building_Name__c, COUNT(Id) cnt, SUM(Amount) total FROM Opportunity WHERE Building_Name__c != null AND StageName = 'Closed Won' GROUP BY Building_Name__c ORDER BY SUM(Amount) DESC`)
    return formatDirectResult(result, 'Opportunity')
  }

  // List/show by salesperson
  if ((q.includes('list') || q.includes('show')) && (q.includes('by person') || q.includes('by salesperson') || q.includes('by agent') || q.includes('top performer'))) {
    const result = await soql(`SELECT cm_Sales_Person__r.Name, COUNT(Id) cnt, SUM(Amount) total FROM Opportunity WHERE cm_Sales_Person__r.Name != null AND StageName = 'Closed Won' GROUP BY cm_Sales_Person__r.Name ORDER BY SUM(Amount) DESC`)
    return formatDirectResult(result, 'Opportunity')
  }

  // ── AGGREGATE QUERIES (lower priority — user wants numbers) ──

  // Total sales / revenue — but NOT if the query contains a likely project/community/customer
  // name (e.g. "how much is Address Grand Downtown sale") — in that case, fall through to the
  // tool-matcher/synonym layer instead of running an unfiltered aggregate that discards the name.
  if (!hasEntity && (q.includes('total') || q.includes('how much') || q.includes('revenue') || q.includes('sum')) && (q.includes('sale') || q.includes('revenue') || q.includes('amount'))) {
    const result = await soql(`SELECT COUNT(Id) cnt, SUM(Amount) total FROM Opportunity WHERE StageName = 'Closed Won'`)
    return formatDirectResult(result, 'Opportunity')
  }

  // Sales by community (aggregate) — use Building_Name__c (groupable) instead of Building_Community__c
  if (q.includes('by community') || q.includes('by location') || q.includes('by project') || q.includes('which community') || q.includes('most sales') || q.includes('top community') || q.includes('community has the most') || q.includes('which building') || q.includes('most revenue')) {
    const result = await soql(`SELECT Building_Name__c, COUNT(Id) cnt, SUM(Amount) total FROM Opportunity WHERE Building_Name__c != null AND StageName = 'Closed Won' GROUP BY Building_Name__c ORDER BY SUM(Amount) DESC`)
    return formatDirectResult(result, 'Opportunity')
  }

  // Sales by salesperson (aggregate)
  if (q.includes('by person') || q.includes('by salesperson') || q.includes('by agent') || q.includes('top performer') || q.includes('top salesperson') || q.includes('top person') || q.includes('who is the top') || q.includes('best salesperson') || q.includes('best performer')) {
    const result = await soql(`SELECT cm_Sales_Person__r.Name, COUNT(Id) cnt, SUM(Amount) total FROM Opportunity WHERE cm_Sales_Person__r.Name != null AND StageName = 'Closed Won' GROUP BY cm_Sales_Person__r.Name ORDER BY SUM(Amount) DESC`)
    return formatDirectResult(result, 'Opportunity')
  }

  // Pipeline / open deals
  if (q.includes('pipeline') || q.includes('open deal') || q.includes('in progress')) {
    const result = await soql(`SELECT StageName, COUNT(Id) cnt, SUM(Amount) total FROM Opportunity WHERE IsClosed = false GROUP BY StageName ORDER BY COUNT(Id) DESC`)
    return formatDirectResult(result, 'Opportunity')
  }

  // Recent deals (no list/show keyword)
  if (q.includes('recent') || q.includes('latest')) {
    const result = await soql(`SELECT Name, StageName, Amount, CloseDate, Building_Name__c, Building_Community__c, cm_Sales_Person__r.Name FROM Opportunity WHERE Amount != 1 AND CloseDate != 2032-12-28 ORDER BY CreatedDate DESC LIMIT 10`)
    return formatDirectResult(result, 'Opportunity')
  }

  // Cancelled — "how many" → count; otherwise → list
  if (q.includes('cancel') || q.includes('cancelled')) {
    if (q.includes('how many') || q.includes('count') || q.includes('total')) {
      const result = await soql(`SELECT COUNT(Id) cnt FROM Opportunity WHERE Order_Stattus__c IN ('BOOKED_CANCELLED', 'SMT_CANCELLED')${TEST_RECORD_AND}`)
      return formatDirectResult(result, 'Opportunity')
    }
    const result = await soql(`SELECT Name, Building_Community__c, Amount, Order_Stattus__c FROM Opportunity WHERE Order_Stattus__c IN ('BOOKED_CANCELLED', 'SMT_CANCELLED')${TEST_RECORD_AND} ORDER BY CloseDate DESC LIMIT 20`)
    return formatDirectResult(result, 'Opportunity')
  }

  // Unit count
  if ((q.includes('how many unit') || q.includes('total unit') || q.includes('unit count')) && !q.includes('sold')) {
    const result = await soql(`SELECT COUNT(Id) FROM Property_Inventory__c`)
    return formatDirectResult(result, 'Property_Inventory__c')
  }

  // Case queries — "all cases" returns count + records — BUT skip cross-object queries ("cases for deal X")
  if ((q.includes('case') || q.includes('cases') || q.includes('support') || q.includes('service')) && !q.includes('for deal') && !q.includes('for opportunity') && !q.includes('for this')) {
    if (q.includes('list') || q.includes('show') || q.includes('all') || q.includes('top')) {
      const countResult = await soql(`SELECT COUNT(Id) cnt FROM Case`)
      const listResult = await soql(`SELECT CaseNumber, Subject, Status, Type, Priority, CreatedDate FROM Case ORDER BY CreatedDate DESC LIMIT ${limit}`)
      const count = countResult.records[0]?.cnt ?? countResult.totalSize
      const rows = listResult.records.map(r => {
        const { attributes, ...fields } = r; void attributes
        return Object.entries(fields).filter(([k]) => k !== 'attributes').map(([k, v]) => {
          const cleanKey = k.replace(/__c$|__r$/, '').replace(/_/g, ' ')
          return v == null ? '' : `${cleanKey}: ${v}`
        }).filter(([, v]) => v !== '').join(' | ')
      })
      return { context: `Total cases: ${count}\n\n${rows.join('\n')}`, citation: { documentName: 'Salesforce (live CRM)' } }
    }
    // Case breakdown by type/status/priority
    if (q.includes('type') || q.includes('category')) {
      const result = await soql(`SELECT Type, COUNT(Id) cnt FROM Case GROUP BY Type ORDER BY COUNT(Id) DESC`)
      return formatDirectResult(result, 'Case')
    }
    if (q.includes('status') || q.includes('open') || q.includes('closed')) {
      const result = await soql(`SELECT Status, COUNT(Id) cnt FROM Case GROUP BY Status ORDER BY COUNT(Id) DESC`)
      return formatDirectResult(result, 'Case')
    }
    if (q.includes('priority') || q.includes('urgent')) {
      const result = await soql(`SELECT Priority, COUNT(Id) cnt FROM Case GROUP BY Priority ORDER BY COUNT(Id) DESC`)
      return formatDirectResult(result, 'Case')
    }
    const result = await soql(`SELECT COUNT(Id) cnt FROM Case`)
    return formatDirectResult(result, 'Case')
  }

  // Lead queries — BUT skip conversion rate queries (those go to tool matcher)
  if ((q.includes('lead') || q.includes('leads') || q.includes('prospect') || q.includes('prospects')) && !q.includes('conversion') && !q.includes('convert')) {
    if (q.includes('source') || q.includes('where') || q.includes('channel')) {
      const result = await soql(`SELECT LeadSource, COUNT(Id) cnt FROM Lead WHERE LeadSource != null GROUP BY LeadSource ORDER BY COUNT(Id) DESC`)
      return formatDirectResult(result, 'Lead')
    }
    const result = await soql(`SELECT COUNT(Id) cnt FROM Lead`)
    return formatDirectResult(result, 'Lead')
  }

  // Account/customer queries — extract name if present, else count
  if (q.includes('account') || q.includes('accounts') || q.includes('customer') || q.includes('customers') || q.includes('buyer') || q.includes('buyers')) {
    // Only extract name for lookup-style queries, NOT count/list queries
    const isLookup = q.includes('tell me about') || q.includes('show me') || q.includes('lookup') || q.includes('search for') || q.includes('find') || q.includes('info on') || q.includes('details on') || q.includes('information about')
    if (isLookup) {
      const nameMatch = q.match(/(?:customer|account|buyer)s?\s+(?:named?|called?|info(?:rmation)?(?:\s+on)?|about|details?\s+on)?\s*(.+)/i)
      if (nameMatch && nameMatch[1].trim().length > 1) {
        const searchName = sanitizeSOQLInput(nameMatch[1].trim().replace(/[?.!]$/, ''))
        const result = await soql(`SELECT Name, Phone, Email__c, PersonEmail, RecordType.Name FROM Account WHERE Name LIKE '%${searchName}%' LIMIT 10`)
        return formatDirectResult(result, 'Account')
      }
    }
    if (q.includes('top') || q.includes('most') || q.includes('revenue') || q.includes('by')) {
      const result = await soql(`SELECT Account.Name, COUNT(Id) cnt, SUM(Amount) total FROM Opportunity WHERE Account.Name != null AND IsWon = true${TEST_RECORD_AND} GROUP BY Account.Name ORDER BY SUM(Amount) DESC LIMIT ${limit}`)
      return formatDirectResult(result, 'Opportunity')
    }
    const result = await soql(`SELECT COUNT(Id) cnt FROM Account`)
    return formatDirectResult(result, 'Account')
  }

  // Task/activity queries — BUT skip cross-object queries ("tasks for deal X")
  if ((q.includes('task') || q.includes('tasks') || q.includes('activity') || q.includes('activities') || q.includes('todo') || q.includes('to-do')) && !q.includes('for deal') && !q.includes('for opportunity') && !q.includes('for this')) {
    if (q.includes('open') || q.includes('pending') || q.includes('overdue')) {
      const result = await soql(`SELECT Subject, Status, Priority, ActivityDate FROM Task WHERE Status != 'Completed' ORDER BY ActivityDate ASC LIMIT ${limit}`)
      return formatDirectResult(result, 'Task')
    }
    if (q.includes('status') || q.includes('breakdown')) {
      const result = await soql(`SELECT Status, COUNT(Id) cnt FROM Task GROUP BY Status ORDER BY COUNT(Id) DESC`)
      return formatDirectResult(result, 'Task')
    }
    const result = await soql(`SELECT COUNT(Id) cnt FROM Task`)
    return formatDirectResult(result, 'Task')
  }

  // Average deal value — BUT skip "average cycle time" or "time to close" (goes to tool matcher)
  if ((q.includes('average') || q.includes('avg') || q.includes('mean')) && !q.includes('cycle') && !q.includes('time to close') && !q.includes('booking to close')) {
    if (q.includes('deal') || q.includes('sale') || q.includes('price') || q.includes('amount') || q.includes('value')) {
      const result = await soql(`SELECT AVG(Amount) avgVal, COUNT(Id) cnt FROM Opportunity WHERE IsWon = true`)
      return formatDirectResult(result, 'Opportunity')
    }
  }

  // Bedroom/unit type queries — BUT skip multi-filter queries ("deals in X with 3 bedrooms")
  if ((q.includes('bedroom') || q.includes('bhk') || q.includes('unit type') || q.includes('room type')) && !q.includes(' in ') && !q.includes('deals in')) {
    const result = await soql(`SELECT Sales_Room__c, COUNT(Id) cnt, SUM(Amount) total FROM Opportunity WHERE Sales_Room__c != null AND IsWon = true${TEST_RECORD_AND} GROUP BY Sales_Room__c ORDER BY SUM(Amount) DESC`)
    return formatDirectResult(result, 'Opportunity')
  }

  // Property inventory by community
  if ((q.includes('property') || q.includes('unit') || q.includes('inventory')) && (q.includes('by community') || q.includes('by location'))) {
    const result = await soql(`SELECT Building_Community__c, COUNT(Id) cnt FROM Property_Inventory__c WHERE Building_Community__c != null GROUP BY Building_Community__c ORDER BY COUNT(Id) DESC`)
    return formatDirectResult(result, 'Property_Inventory__c')
  }

  // Inventory status breakdown
  if ((q.includes('available') || q.includes('sold') || q.includes('reserved') || q.includes('leased') || q.includes('blocked')) && (q.includes('unit') || q.includes('property') || q.includes('inventory'))) {
    const result = await soql(`SELECT Property_Status__c, COUNT(Id) cnt FROM Property_Inventory__c WHERE Property_Status__c != null GROUP BY Property_Status__c ORDER BY COUNT(Id) DESC`)
    return formatDirectResult(result, 'Property_Inventory__c')
  }

  // Property type breakdown (villa, apartment, townhouse)
  if (q.includes('villa') || q.includes('apartment') || q.includes('townhouse') || (q.includes('property') && q.includes('type'))) {
    const result = await soql(`SELECT Type__c, COUNT(Id) cnt FROM Property_Inventory__c WHERE Type__c != null GROUP BY Type__c ORDER BY COUNT(Id) DESC`)
    return formatDirectResult(result, 'Property_Inventory__c')
  }

  // Win rate
  if (q.includes('win rate') || q.includes('won vs lost') || q.includes('conversion rate') || (q.includes('won') && q.includes('lost'))) {
    const result = await soql(`SELECT IsWon, COUNT(Id) cnt, SUM(Amount) total FROM Opportunity WHERE IsClosed = true GROUP BY IsWon`)
    return formatDirectResult(result, 'Opportunity')
  }

  // Mortgage status — Current_Mortgage_Status__c can't be grouped, so query raw and aggregate in code
  // BUT skip "mortgage for deal X" (goes to tool matcher)
  if ((q.includes('mortgage') || q.includes('mortgaged')) && !q.includes('for deal') && !q.includes('for opportunity')) {
    const result = await soql(`SELECT Current_Mortgage_Status__c FROM Opportunity WHERE Current_Mortgage_Status__c != null AND IsWon = true LIMIT 500`)
    const counts: Record<string, number> = {}
    for (const r of result.records) {
      const val = String(r.Current_Mortgage_Status__c || 'Unknown')
      counts[val] = (counts[val] || 0) + 1
    }
    const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`)
    return { context: `Mortgage status breakdown:\n${rows.join('\n')}`, citation: { documentName: 'Salesforce (live CRM)' } }
  }

  // Milestone/handover
  if (q.includes('milestone') || q.includes('handover') || q.includes('deep cleaning') || q.includes('key release')) {
    const result = await soql(`SELECT Milestone_Current_Status__c, COUNT(Id) cnt FROM Opportunity WHERE Milestone_Current_Status__c != null AND IsWon = true GROUP BY Milestone_Current_Status__c ORDER BY COUNT(Id) DESC`)
    return formatDirectResult(result, 'Opportunity')
  }

  // Cases by origin/channel
  if ((q.includes('case') || q.includes('cases') || q.includes('service')) && (q.includes('origin') || q.includes('channel') || q.includes('phone') || q.includes('email') || q.includes('web'))) {
    const result = await soql(`SELECT Origin, COUNT(Id) cnt FROM Case WHERE Origin != null GROUP BY Origin ORDER BY COUNT(Id) DESC`)
    return formatDirectResult(result, 'Case')
  }

  // Cases by service category / eservice
  if ((q.includes('case') || q.includes('cases') || q.includes('service')) && (q.includes('service') || q.includes('category') || q.includes('eservice') || q.includes('registration') || q.includes('transfer') || q.includes('move-in') || q.includes('move-out'))) {
    const result = await soql(`SELECT eService_Admin_Name__c, COUNT(Id) cnt FROM Case WHERE eService_Admin_Name__c != null GROUP BY eService_Admin_Name__c ORDER BY COUNT(Id) DESC LIMIT ${limit}`)
    return formatDirectResult(result, 'Case')
  }

  // Generic sales count — but check for "per/by [dimension]" patterns first
  if (q.includes('how many') || q.includes('number of') || q.includes('count')) {
    if (q.includes('deal') || q.includes('sale') || q.includes('opportunit')) {
      // "how many deals per/by salesperson/community/agent" → route to aggregate
      if (q.includes(' per ') || q.includes(' by ') || q.includes('per ') || q.includes('by ')) {
        if (q.includes('salesperson') || q.includes('person') || q.includes('advisor')) {
          const result = await soql(`SELECT cm_Sales_Person__r.Name, COUNT(Id) cnt FROM Opportunity WHERE cm_Sales_Person__r.Name != null AND StageName = 'Closed Won' GROUP BY cm_Sales_Person__r.Name ORDER BY COUNT(Id) DESC`)
          return formatDirectResult(result, 'Opportunity')
        }
        if (q.includes('community') || q.includes('project') || q.includes('location') || q.includes('building')) {
          const result = await soql(`SELECT Building_Name__c, COUNT(Id) cnt FROM Opportunity WHERE Building_Name__c != null AND Building_Name__c NOT IN ('Master Community', 'All Buildings') AND StageName = 'Closed Won' GROUP BY Building_Name__c ORDER BY COUNT(Id) DESC`)
          return formatDirectResult(result, 'Opportunity')
        }
        if (q.includes('agent') || q.includes('broker')) {
          const result = await soql(`SELECT cm_Agent_Name__r.Name, COUNT(Id) cnt FROM Opportunity WHERE cm_Agent_Name__r.Name != null AND StageName = 'Closed Won' GROUP BY cm_Agent_Name__r.Name ORDER BY COUNT(Id) DESC`)
          return formatDirectResult(result, 'Opportunity')
        }
        if (q.includes('month')) {
          const result = await soql(`SELECT CALENDAR_MONTH(CloseDate) month, COUNT(Id) cnt FROM Opportunity WHERE StageName = 'Closed Won' GROUP BY CALENDAR_MONTH(CloseDate) ORDER BY CALENDAR_MONTH(CloseDate)`)
          return formatDirectResult(result, 'Opportunity')
        }
        if (q.includes('quarter')) {
          const result = await soql(`SELECT QUARTER(CloseDate) quarter, COUNT(Id) cnt FROM Opportunity WHERE StageName = 'Closed Won' GROUP BY QUARTER(CloseDate) ORDER BY QUARTER(CloseDate)`)
          return formatDirectResult(result, 'Opportunity')
        }
      }
      // Extract community name from "how many deals in Camden" pattern
      const communityMatch = q.match(/(?:how many|number of|count)\s+(?:deals?|sales?|opportunit\w*)\s+(?:in|for)\s+(.+?)(?:\?|$)/i)
      if (communityMatch) {
        const community = sanitizeSOQLInput(communityMatch[1].trim().replace(/'/g, ""))
        const result = await soql(`SELECT COUNT(Id) cnt FROM Opportunity WHERE (Building_Name__c LIKE '%${community}%' OR Building_Community__c LIKE '%${community}%') AND StageName = 'Closed Won'`)
        return formatDirectResult(result, 'Opportunity')
      }
      const result = await soql(`SELECT COUNT(Id) cnt FROM Opportunity WHERE StageName = 'Closed Won'`)
      return formatDirectResult(result, 'Opportunity')
    }
  }

  return null
}

function formatDirectResult(result: { records: Record<string, unknown>[]; totalSize: number; done: boolean }, objectName: string): SalesforceResult {
  if (result.records.length === 0) {
    return { context: `No records found for this query.`, citation: { documentName: 'Salesforce (live CRM)' } }
  }

  // Detect COUNT queries — produce a clear summary instead of raw field names
  const firstRecord = result.records[0]
  const keys = Object.keys(firstRecord).filter(k => k !== 'attributes')
  const isCountQuery = keys.length === 1 && (keys[0] === 'cnt' || keys[0].includes('cnt'))

  if (isCountQuery) {
    const countValue = firstRecord[keys[0]]
    return { context: `Count: ${countValue}`, citation: { documentName: 'Salesforce (live CRM)' } }
  }

  // Detect SUM/COUNT combo queries (e.g. get-sales-summary) — only when keys are exactly cnt+total
  const hasCountAndTotal = keys.length === 2 && keys.includes('cnt') && keys.includes('total')
  if (hasCountAndTotal) {
    const cnt = firstRecord.cnt
    const total = firstRecord.total
    return { context: `Count: ${cnt} records\nTotal Amount: AED ${total}`, citation: { documentName: 'Salesforce (live CRM)' } }
  }

  // Regular records — format as clean table
  const rows = result.records.slice(0, 100).map((r) => {
    const { attributes, ...fields } = r
    void attributes
    return Object.entries(fields)
      .filter(([k]) => k !== 'attributes')
      .map(([k, v]) => {
        const cleanKey = k.replace(/__c$|__r$/, '').replace(/_/g, ' ')
        let val = v
        if (typeof val === 'object' && val !== null) {
          if ((val as Record<string, unknown>).Name) {
            val = (val as Record<string, unknown>).Name
          } else {
            val = JSON.stringify(val)
          }
        }
        return val == null ? '' : `${cleanKey}: ${val}`
      })
      .filter(([, v]) => v !== '')
      .join(' | ')
  })
  const body = rows.join('\n')
  return { context: body, citation: { documentName: 'Salesforce (live CRM)' } }
}

// ─────────────────────────────────────────────────────────────────────────────
// CATCH-ALL FALLBACK — keyword-based SOQL when nothing else matched.
// Always returns something — never gives up.
// ─────────────────────────────────────────────────────────────────────────────
async function catchAllFallback(query: string): Promise<SalesforceResult | null> {
  const q = query.toLowerCase()

  // Community/listing queries — catch "give me all the community available" and similar
  if (q.includes('communit')) {
    try {
      const result = await soql(`SELECT Building_Community__c FROM Property_Inventory__c WHERE Building_Community__c != null GROUP BY Building_Community__c ORDER BY Building_Community__c`)
      if (result.records && result.records.length > 0) {
        return formatDirectResult(result, 'Property_Inventory__c')
      }
      // Fallback: try by building name
      const altResult = await soql(`SELECT Building_Name__c FROM Property_Inventory__c WHERE Building_Name__c != null GROUP BY Building_Name__c ORDER BY Building_Name__c`)
      return formatDirectResult(altResult, 'Property_Inventory__c')
    } catch { /* fall through */ }
  }

  // Case/support queries
  if (q.includes('case') || q.includes('cases') || q.includes('support') || q.includes('service')) {
    try {
      const countResult = await soql(`SELECT COUNT(Id) cnt FROM Case`)
      const listResult = await soql(`SELECT CaseNumber, Subject, Status, Type, Priority, CreatedDate FROM Case ORDER BY CreatedDate DESC LIMIT 20`)
      const count = countResult.records[0]?.cnt ?? countResult.totalSize
      const rows = listResult.records.map(r => {
        const { attributes, ...fields } = r; void attributes
        return Object.entries(fields).filter(([k]) => k !== 'attributes').map(([k, v]) => {
          const cleanKey = k.replace(/__c$|__r$/, '').replace(/_/g, ' ')
          return v == null ? '' : `${cleanKey}: ${v}`
        }).filter(([, v]) => v !== '').join(' | ')
      })
      return { context: `Total cases: ${count}\n\n${rows.join('\n')}`, citation: { documentName: 'Salesforce (live CRM)' } }
    } catch { /* fall through */ }
  }

  // Lead/prospect queries
  if (q.includes('lead') || q.includes('leads') || q.includes('prospect') || q.includes('prospects')) {
    try {
      const result = await soql(`SELECT COUNT(Id) cnt FROM Lead`)
      return formatDirectResult(result, 'Lead')
    } catch { /* fall through */ }
  }

  // Account/customer queries — extract name if present, else count
  if (q.includes('account') || q.includes('accounts') || q.includes('customer') || q.includes('customers') || q.includes('buyer') || q.includes('buyers')) {
    try {
      // Only extract name for lookup-style queries, NOT count/list queries
      const isLookup = q.includes('tell me about') || q.includes('show me') || q.includes('lookup') || q.includes('search for') || q.includes('find') || q.includes('info on') || q.includes('details on') || q.includes('information about')
      if (isLookup) {
        const nameMatch = q.match(/(?:customer|account|buyer)s?\s+(?:named?|called?|info(?:rmation)?(?:\s+on)?|about|details?\s+on)?\s*(.+)/i)
        if (nameMatch && nameMatch[1].trim().length > 1) {
          const searchName = sanitizeSOQLInput(nameMatch[1].trim().replace(/[?.!]$/, ''))
          const result = await soql(`SELECT Name, Phone, Email__c, PersonEmail, RecordType.Name FROM Account WHERE Name LIKE '%${searchName}%' LIMIT 10`)
          return formatDirectResult(result, 'Account')
        }
      }
      const result = await soql(`SELECT COUNT(Id) cnt FROM Account`)
      return formatDirectResult(result, 'Account')
    } catch { /* fall through */ }
  }

  // Task/activity queries
  if (q.includes('task') || q.includes('tasks') || q.includes('activity') || q.includes('activities') || q.includes('todo') || q.includes('to-do')) {
    try {
      const result = await soql(`SELECT COUNT(Id) cnt FROM Task`)
      return formatDirectResult(result, 'Task')
    } catch { /* fall through */ }
  }

  // Opportunity queries (generic — any mention of opportunity/deal/sale/property)
  if (q.includes('opportunit') || q.includes('deal') || q.includes('sale') || q.includes('property') || q.includes('unit') || q.includes('sold') || q.includes('revenue') || q.includes('pipeline')) {
    try {
      const result = await soql(`SELECT Name, StageName, Amount, CloseDate, Building_Name__c, Building_Community__c, cm_Sales_Person__r.Name FROM Opportunity WHERE Amount != 1 AND CloseDate < 2032-01-01 ORDER BY CloseDate DESC LIMIT 20`)
      return formatDirectResult(result, 'Opportunity')
    } catch { /* fall through */ }
  }

  // Absolute last resort — just query Opportunities
  try {
    const result = await soql(`SELECT Name, StageName, Amount, CloseDate FROM Opportunity WHERE Amount != 1 AND CloseDate < 2032-01-01 ORDER BY CloseDate DESC LIMIT 10`)
    return formatDirectResult(result, 'Opportunity')
  } catch { return null }
}
