// ReAct Loop — Reasoning + Acting for multi-step CRM questions.
// Instead of single-pass tool execution, this loop allows the LLM to:
// 1. REASON about what tools to call
// 2. ACT by executing a tool
// 3. OBSERVE the result
// 4. REPEAT until confident or max steps reached
//
// This handles complex questions like:
// - "What's the total sales for Alton in 2024 and how does it compare to Kaya?"
// - "Show me the top 3 salespersons and their cancellation rates"
// - "Which customer has the most cases and what were their deals?"

import { chatJson } from '@/lib/ai/provider'
import { getToolByName, getToolCatalogText } from './tools'
import { getBusinessGlossaryText } from './business-glossary'
import { parseLlmJson } from './mcp-query'
import { todayStr, currentYear } from './today'

export interface ReActStep {
  thought: string       // What the LLM reasons about
  action: string        // Tool to call (or 'finish' to compose answer)
  params: Record<string, unknown>
  observation: string   // Result from tool (or final answer)
  timestamp: number
}

export interface ReActResult {
  steps: ReActStep[]
  finalAnswer: string
  confidence: 'high' | 'medium' | 'low'
  totalLatencyMs: number
  toolsUsed: string[]
}

const MAX_STEPS = 5
const STEP_TIMEOUT_MS = 60000
const TODAY = todayStr()
const CURRENT_YEAR = currentYear()

function buildReactSystemPrompt(glossary: string): string {
  return `You are a CRM reasoning agent for Nshama, a Dubai real estate developer. Today's date is ${TODAY}. The current year is ${CURRENT_YEAR}.

You have access to pre-built tools that query the CRM. Your job is to answer complex questions by reasoning step-by-step, calling tools as needed, and composing a final answer.

AVAILABLE TOOLS:
${getToolCatalogText()}

${glossary}

RULES:
1. Think step-by-step — break complex questions into sub-tasks
2. Call ONE tool at a time, wait for the result, then decide next step
3. Each tool call should be for a specific, clear purpose
4. After gathering enough data, compose a clear final answer
5. Maximum ${MAX_STEPS} tool calls — be efficient
6. If a tool returns no data, try a different approach
7. Always finish with a comprehensive answer, not just raw data
8. Use the business glossary above to understand what field names and terms map to — e.g. "Units" means count of deals, "Value" means Amount field, comparisons should use the definitions provided

CRITICAL — NEVER HALLUCINATE DATA:
- When tools return data (lists of names, communities, buildings, statuses, counts, amounts), reproduce ONLY the exact values from the tool results
- Do NOT add, invent, supplement, or "complete" any list with made-up entries
- If a tool returns 10 items, list exactly those 10 — never pad the list
- If a tool returns 0 items, say "No results found" — do not fabricate entries

RESPONSE FORMAT:
You must respond with ONLY one JSON object per step:

{
  "thought": "What I'm reasoning about and why",
  "action": "tool-name" | "finish",
  "params": { "param1": "value1", ... },
  "answer": null | "If action is 'finish', compose the final answer here"
}

For "finish" action, the "answer" field MUST contain the final response to the user.
For tool actions, "params" must match the tool's parameter schema.`
}

const OBSERVATION_PROMPT = `You are observing the result of a tool execution. Analyze the result and decide:
1. Does this answer the original question completely? If yes, compose the final answer.
2. Do you need more data? What specific tool should you call next?
3. Was there an error? Should you try a different tool or approach?

Original question: {QUESTION}
Previous steps: {STEPS}
Current tool result: {RESULT}

Respond with ONLY JSON:
{
  "thought": "What this result tells me and what I still need",
  "action": "finish" | "tool-name",
  "params": { ... },
  "answer": null | "If finishing, compose the final answer here"
}`

/**
 * Execute the ReAct loop for a complex CRM question.
 * Returns step-by-step reasoning with tool calls and observations.
 */
export async function executeReActLoop(
  question: string,
  history?: { role: 'user' | 'assistant'; content: string }[]
): Promise<ReActResult> {
  const startTime = Date.now()
  const steps: ReActStep[] = []
  const toolsUsed: string[] = []
  let confidence: 'high' | 'medium' | 'low' = 'medium'

  // Fetch business glossary for field definitions and terminology
  const glossary = await getBusinessGlossaryText(['Account', 'Opportunity', 'Property_Inventory__c', 'Case'])
  const systemPrompt = buildReactSystemPrompt(glossary)

  // Build context with conversation history
  let context = ''
  if (history && history.length > 0) {
    const recent = history.slice(-6)
    context = recent.map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content.slice(0, 300)}`).join('\n')
    context += '\n'
  }

  const fullQuestion = context ? `${context}User: ${question}` : question

  // Initial reasoning
  let input = `Question: ${fullQuestion}\n\nReason about the first step to answer this question.`
  
  for (let stepNum = 0; stepNum < MAX_STEPS; stepNum++) {
    try {
      // Get LLM's next action
      const raw = await chatJson(systemPrompt, input)
      const decision = parseLlmJson(raw)
      if (!decision) {
        console.warn(`[react] step ${stepNum}: failed to parse LLM response (${raw.length} chars, starts with: ${raw.slice(0, 150)})`)
        confidence = 'low'
        break
      }

      const thought = String(decision.thought || '')
      const action = String(decision.action || 'finish')
      const params = (decision.params as Record<string, unknown>) || {}
      const answer = decision.answer ? String(decision.answer) : null

      const step: ReActStep = {
        thought,
        action,
        params: params as Record<string, string | number | boolean | undefined>,
        observation: '',
        timestamp: Date.now()
      }

      // If LLM wants to finish, compose final answer
      if (action === 'finish' || answer) {
        step.observation = answer || 'No answer composed'
        steps.push(step)
        break
      }

      // Execute the tool
      const tool = getToolByName(action)
      if (!tool) {
        step.observation = `Tool "${action}" not found`
        steps.push(step)
        // Let LLM know tool wasn't found and try again
        input = `Question: ${fullQuestion}\n\nSteps so far:\n${steps.map((s, i) => `${i+1}. Thought: ${s.thought}\n   Action: ${s.action}\n   Observation: ${s.observation}`).join('\n\n')}\n\nThe tool "${action}" was not found. Choose a different tool or finish with what you have.`
        continue
      }

      toolsUsed.push(action)
      
      // Execute with timeout
      const result = await Promise.race([
        tool.execute(params as Record<string, string | number | boolean | undefined>),
        new Promise<null>((_, reject) => 
          setTimeout(() => reject(new Error('Tool execution timeout')), STEP_TIMEOUT_MS)
        )
      ])

      step.observation = result?.context || 'No data returned'
      steps.push(step)

      // Prepare next step input
      input = `Question: ${fullQuestion}\n\nSteps so far:\n${steps.map((s, i) => `${i+1}. Thought: ${s.thought}\n   Action: ${s.action}\n   Observation: ${s.observation.slice(0, 500)}`).join('\n\n')}\n\nWhat should be the next step? If you have enough data, compose the final answer.`

    } catch (err) {
      console.error(`[react] step ${stepNum} failed:`, err)
      steps.push({
        thought: 'Error occurred',
        action: 'error',
        params: {},
        observation: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
        timestamp: Date.now()
      })
      confidence = 'low'
      break
    }
  }

  // Extract final answer from last step
  const lastStep = steps[steps.length - 1]
  const finalAnswer = lastStep?.observation || 'Unable to compose answer'

  // Determine confidence based on steps
  if (steps.length === 1 && steps[0].action === 'finish') {
    confidence = 'high' // Simple single-step answer
  } else if (toolsUsed.length >= 2) {
    confidence = 'high' // Multi-tool reasoning completed
  } else if (steps.some(s => s.observation.includes('Error'))) {
    confidence = 'low'
  }

  return {
    steps,
    finalAnswer,
    confidence,
    totalLatencyMs: Date.now() - startTime,
    toolsUsed
  }
}

/**
 * Check if a question needs multi-step reasoning (ReAct loop).
 * Returns true for complex questions that require multiple tool calls.
 */
export function needsReActLoop(question: string): boolean {
  const q = question.toLowerCase()
  
  // Multi-part questions (and, also, plus, as well as)
  const multiPart = /\b(and|also|plus|as well as|in addition|furthermore)\b/.test(q)
  
  // Comparison questions
  const comparison = /\b(compare|vs|versus|compared to|against|difference between)\b/.test(q)
  
  // Complex breakdowns
  const complexBreakdown = /\b(breakdown|break down|detailed|comprehensive|full)\b/.test(q) &&
    /\b(and|also|with|including)\b/.test(q)
  
  // Multi-entity lookups
  const multiEntity = (q.match(/\b(\w+)\b/g)?.length || 0) > 15
  
  // Questions asking for multiple metrics
  const multiMetric = /\b(revenue|count|total|average|rate).*(revenue|count|total|average|rate)\b/.test(q)
  
  return multiPart || comparison || complexBreakdown || multiEntity || multiMetric
}
