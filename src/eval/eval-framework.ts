// Eval Framework — Production question tracking, evaluation, and continuous improvement.
// 
// This framework:
// 1. Stores questions with expected answers and evaluation results
// 2. Supports both automated (LLM-judge) and manual evaluation
// 3. Tracks accuracy over time
// 4. Can import production questions from the client validation DB
// 5. Generates reports for monitoring system performance

import { chatJson } from '@/lib/ai/provider'
import { answerSalesforceQuery } from '../salesforce/query'
import { recordMetric } from '../salesforce/observability'
import * as fs from 'fs/promises'
import * as path from 'path'

export interface EvalQuestion {
  id: string
  question: string
  category: string
  difficulty: 'easy' | 'medium' | 'hard'
  tags: string[]
  expectedAnswer?: string       // Expected answer (for manual evaluation)
  expectedTool?: string         // Expected tool (for routing evaluation)
  expectedPatterns?: string[]   // Patterns that should appear in answer
  notExpectedPatterns?: string[] // Patterns that should NOT appear
  createdAt: string
  lastRunAt?: string
  lastResult?: EvalResult
  runCount: number
  passCount: number
}

export interface EvalResult {
  questionId: string
  timestamp: string
  actualAnswer: string
  actualTool?: string
  latencyMs: number
  score: number               // 0-100 (automated judge)
  pass: boolean
  issues: string[]
  method: 'auto' | 'manual'
  evaluator?: string
}

export interface EvalReport {
  timestamp: string
  totalQuestions: number
  passRate: number
  avgScore: number
  avgLatencyMs: number
  byCategory: Record<string, { passRate: number; count: number }>
  byDifficulty: Record<string, { passRate: number; count: number }>
  recentFailures: EvalQuestion[]
  recommendations: string[]
}

// Eval database file
const EVAL_DB_PATH = path.join(process.cwd(), 'data', 'eval-database.json')

// LLM Judge prompt for automated evaluation
const JUDGE_PROMPT = `You are a CRM answer quality judge for Nshama, a Dubai real estate developer. Today's date is ${new Date().toISOString().split('T')[0]}.

Evaluate whether the system's answer correctly addresses the user's question about Salesforce CRM data.

SCORING CRITERIA:
- RELEVANCE (0-30): Does the answer address what was asked?
- ACCURACY (0-30): Is the information factually correct based on the data?
- COMPLETENESS (0-20): Does it answer all parts of the question?
- CLARITY (0-20): Is it clear and well-structured?

RULES:
- Score >= 70: PASS (answer is good enough)
- Score < 70: FAIL (answer needs improvement)
- If the question asks for a specific metric and the answer provides it, score high
- If the answer is vague or incomplete, score low
- If the answer contains errors or wrong data, score 0-20

Respond with ONLY JSON:
{
  "score": <0-100>,
  "pass": <true|false>,
  "issues": ["list of any issues found"],
  "suggestion": null | "if failed, suggest what the correct answer should be"
}`

/**
 * Load the eval database from disk.
 */
export async function loadEvalDatabase(): Promise<EvalQuestion[]> {
  try {
    const data = await fs.readFile(EVAL_DB_PATH, 'utf-8')
    return JSON.parse(data)
  } catch {
    return []
  }
}

/**
 * Save the eval database to disk.
 */
export async function saveEvalDatabase(questions: EvalQuestion[]): Promise<void> {
  const dir = path.dirname(EVAL_DB_PATH)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(EVAL_DB_PATH, JSON.stringify(questions, null, 2))
}

/**
 * Add a new question to the eval database.
 */
export async function addEvalQuestion(question: Omit<EvalQuestion, 'id' | 'createdAt' | 'runCount' | 'passCount'>): Promise<EvalQuestion> {
  const db = await loadEvalDatabase()
  const newQuestion: EvalQuestion = {
    ...question,
    id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    runCount: 0,
    passCount: 0
  }
  db.push(newQuestion)
  await saveEvalDatabase(db)
  return newQuestion
}

/**
 * Run a single question through the system and evaluate it.
 */
export async function runEvalQuestion(
  question: EvalQuestion,
  history?: { role: 'user' | 'assistant'; content: string }[]
): Promise<EvalResult> {
  const startTime = Date.now()
  
  try {
    // Execute the question
    const result = await answerSalesforceQuery(question.question, history)
    const latencyMs = Date.now() - startTime
    const actualAnswer = result?.context || 'No answer returned'
    
    // Use LLM judge to evaluate
    const judgeInput = `User Question: ${question.question}
Expected Answer: ${question.expectedAnswer || 'Not specified'}
Expected Tool: ${question.expectedTool || 'Any'}
Expected Patterns: ${question.expectedPatterns?.join(', ') || 'None'}
NOT Expected Patterns: ${question.notExpectedPatterns?.join(', ') || 'None'}

System Answer:
${actualAnswer.slice(0, 2000)}`
    
    const raw = await chatJson(JUDGE_PROMPT, judgeInput)
    let judgeResult: Record<string, unknown>
    try {
      judgeResult = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>)
    } catch {
      judgeResult = { score: 50, pass: false, issues: ['Failed to parse judge response'], suggestion: null }
    }
    
    const score = Math.min(100, Math.max(0, (judgeResult.score as number) || 0))
    const pass = score >= 70
    
    const evalResult: EvalResult = {
      questionId: question.id,
      timestamp: new Date().toISOString(),
      actualAnswer,
      latencyMs,
      score,
      pass,
      issues: (judgeResult.issues as string[]) || [],
      method: 'auto'
    }
    
    // Update the question in database
    const db = await loadEvalDatabase()
    const idx = db.findIndex(q => q.id === question.id)
    if (idx >= 0) {
      db[idx].lastRunAt = new Date().toISOString()
      db[idx].lastResult = evalResult
      db[idx].runCount++
      if (pass) db[idx].passCount++
      await saveEvalDatabase(db)
    }
    
    // Record metric
    recordMetric({
      timestamp: new Date().toISOString(),
      question: question.question,
      toolMatched: result?.citation?.documentName || null,
      confidence: pass ? 'high' : 'low',
      method: 'eval',
      latencyMs,
      soqlSuccess: true,
      guardrailBlocked: false,
      instructorRetries: 0,
      resultCount: 1
    })
    
    return evalResult
    
  } catch (err) {
    const latencyMs = Date.now() - startTime
    return {
      questionId: question.id,
      timestamp: new Date().toISOString(),
      actualAnswer: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
      latencyMs,
      score: 0,
      pass: false,
      issues: [`Execution failed: ${err}`],
      method: 'auto'
    }
  }
}

/**
 * Run all questions in the eval database.
 */
export async function runFullEval(): Promise<EvalReport> {
  const db = await loadEvalDatabase()
  console.log(`\nRunning eval on ${db.length} questions...\n`)
  
  const results: EvalResult[] = []
  for (let i = 0; i < db.length; i++) {
    const q = db[i]
    console.log(`[${i + 1}/${db.length}] ${q.question}`)
    const result = await runEvalQuestion(q)
    results.push(result)
    const icon = result.pass ? '✓' : '✗'
    console.log(`  ${icon} Score: ${result.score}/100 (${result.latencyMs}ms)`)
    if (result.issues.length > 0) {
      console.log(`  Issues: ${result.issues.join(', ')}`)
    }
  }
  
  return generateReport(db, results)
}

/**
 * Generate an eval report from results.
 */
function generateReport(questions: EvalQuestion[], results: EvalResult[]): EvalReport {
  const total = results.length
  const passed = results.filter(r => r.pass).length
  const avgScore = results.reduce((sum, r) => sum + r.score, 0) / total
  const avgLatency = results.reduce((sum, r) => sum + r.latencyMs, 0) / total
  
  // By category
  const byCategory: Record<string, { passRate: number; count: number }> = {}
  for (const q of questions) {
    const result = results.find(r => r.questionId === q.id)
    if (!result) continue
    if (!byCategory[q.category]) byCategory[q.category] = { passRate: 0, count: 0 }
    byCategory[q.category].count++
    if (result.pass) byCategory[q.category].passRate++
  }
  for (const cat of Object.keys(byCategory)) {
    byCategory[cat].passRate = byCategory[cat].passRate / byCategory[cat].count
  }
  
  // By difficulty
  const byDifficulty: Record<string, { passRate: number; count: number }> = {}
  for (const q of questions) {
    const result = results.find(r => r.questionId === q.id)
    if (!result) continue
    if (!byDifficulty[q.difficulty]) byDifficulty[q.difficulty] = { passRate: 0, count: 0 }
    byDifficulty[q.difficulty].count++
    if (result.pass) byDifficulty[q.difficulty].passRate++
  }
  for (const diff of Object.keys(byDifficulty)) {
    byDifficulty[diff].passRate = byDifficulty[diff].passRate / byDifficulty[diff].count
  }
  
  // Recent failures
  const recentFailures = questions
    .filter(q => q.lastResult && !q.lastResult.pass)
    .sort((a, b) => (b.lastRunAt || '').localeCompare(a.lastRunAt || ''))
    .slice(0, 10)
  
  // Generate recommendations
  const recommendations: string[] = []
  if (avgScore < 70) recommendations.push('Overall accuracy is below 70% — review failing questions and improve tools')
  if (avgLatency > 10000) recommendations.push('Average latency is high — consider optimizing tool execution')
  for (const [cat, stats] of Object.entries(byCategory)) {
    if (stats.passRate < 0.6) recommendations.push(`Category "${cat}" has low pass rate (${(stats.passRate * 100).toFixed(0)}%) — needs attention`)
  }
  
  return {
    timestamp: new Date().toISOString(),
    totalQuestions: total,
    passRate: passed / total,
    avgScore,
    avgLatencyMs: avgLatency,
    byCategory,
    byDifficulty,
    recentFailures,
    recommendations
  }
}

/**
 * Import questions from production usage.
 * Call this periodically to capture real user questions.
 */
export async function importProductionQuestions(
  productionQuestions: { question: string; answer: string; score?: number }[]
): Promise<number> {
  const db = await loadEvalDatabase()
  let added = 0
  
  for (const pq of productionQuestions) {
    // Skip if question already exists
    if (db.some(q => q.question.toLowerCase() === pq.question.toLowerCase())) continue
    
    // Auto-categorize
    const category = autoCategorize(pq.question)
    const difficulty = autoDifficulty(pq.question)
    
    await addEvalQuestion({
      question: pq.question,
      category,
      difficulty,
      tags: extractTags(pq.question),
      expectedAnswer: pq.answer,
      expectedPatterns: [],
      notExpectedPatterns: []
    })
    added++
  }
  
  return added
}

/**
 * Auto-categorize a question based on keywords.
 */
function autoCategorize(question: string): string {
  const q = question.toLowerCase()
  if (/\b(sales|revenue|deal|sold|closed won)\b/.test(q)) return 'sales'
  if (/\b(cancell|cancel|transfer)\b/.test(q)) return 'cancellations'
  if (/\b(case|ticket|support|escalat)\b/.test(q)) return 'cases'
  if (/\b(lead|prospect|inquiry)\b/.test(q)) return 'leads'
  if (/\b(task|todo|pending|overdue)\b/.test(q)) return 'tasks'
  if (/\b(property|unit|inventory|building)\b/.test(q)) return 'property'
  if (/\b(customer|account|buyer)\b/.test(q)) return 'customers'
  if (/\b(pipeline|forecast|open deal)\b/.test(q)) return 'pipeline'
  if (/\b(mortgage|payment|financial)\b/.test(q)) return 'financial'
  if (/\b(compare|vs|versus)\b/.test(q)) return 'comparison'
  if (/\b(trend|over time|monthly|quarterly)\b/.test(q)) return 'trends'
  return 'general'
}

/**
 * Auto-difficulty based on question complexity.
 */
function autoDifficulty(question: string): 'easy' | 'medium' | 'hard' {
  const q = question.toLowerCase()
  const wordCount = q.split(/\s+/).length
  
  // Simple questions
  if (wordCount < 6 && !/[?,]/.test(q)) return 'easy'
  
  // Complex questions
  if (wordCount > 15 || (q.includes('and') && q.includes('?')) || /compare|breakdown|detailed/.test(q)) return 'hard'
  
  return 'medium'
}

/**
 * Extract tags from a question for better filtering.
 */
function extractTags(question: string): string[] {
  const tags: string[] = []
  const q = question.toLowerCase()
  
  if (/\b(this month|this quarter|this year|today|yesterday)\b/.test(q)) tags.push('current-period')
  if (/\b(last month|last quarter|last year|yesterday)\b/.test(q)) tags.push('previous-period')
  if (/\b(compare|vs|versus)\b/.test(q)) tags.push('comparison')
  if (/\b(top \d+|highest|best|most)\b/.test(q)) tags.push('ranking')
  if (/\b(how many|count|total)\b/.test(q)) tags.push('counting')
  if (/\b(list|show|display)\b/.test(q)) tags.push('listing')
  if (/\b(breakdown|by \w+)\b/.test(q)) tags.push('breakdown')
  
  return tags
}

/**
 * Print a formatted eval report to console.
 */
export function printEvalReport(report: EvalReport): void {
  console.log('\n' + '═'.repeat(70))
  console.log('EVAL REPORT')
  console.log('═'.repeat(70))
  console.log(`Timestamp: ${report.timestamp}`)
  console.log(`Total Questions: ${report.totalQuestions}`)
  console.log(`Pass Rate: ${(report.passRate * 100).toFixed(1)}%`)
  console.log(`Average Score: ${report.avgScore.toFixed(1)}/100`)
  console.log(`Average Latency: ${report.avgLatencyMs.toFixed(0)}ms`)
  
  console.log('\nBy Category:')
  for (const [cat, stats] of Object.entries(report.byCategory)) {
    console.log(`  ${cat}: ${(stats.passRate * 100).toFixed(0)}% (${stats.count} questions)`)
  }
  
  console.log('\nBy Difficulty:')
  for (const [diff, stats] of Object.entries(report.byDifficulty)) {
    console.log(`  ${diff}: ${(stats.passRate * 100).toFixed(0)}% (${stats.count} questions)`)
  }
  
  if (report.recentFailures.length > 0) {
    console.log('\nRecent Failures:')
    for (const q of report.recentFailures) {
      console.log(`  - "${q.question}" (score: ${q.lastResult?.score || 0})`)
    }
  }
  
  if (report.recommendations.length > 0) {
    console.log('\nRecommendations:')
    for (const rec of report.recommendations) {
      console.log(`  - ${rec}`)
    }
  }
  
  console.log('\n' + '═'.repeat(70))
}
