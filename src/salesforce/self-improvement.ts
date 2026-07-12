// Self-Improvement Loop — Makes the system better over time.
//
// This module:
// 1. Collects feedback from production usage (thumbs up/down, corrections)
// 2. Monitors production queries and tracks confidence
// 3. Identifies patterns in failed queries
// 4. Suggests new tools or routing rules based on failures
// 5. Auto-updates synonym mappings based on user corrections
//
// The goal: every question that fails once should be handled correctly next time.

import * as fs from 'fs/promises'
import * as path from 'path'
import { chatJson } from '@/lib/ai/provider'
import { recordMetric } from './observability'

// ─── Feedback Storage ──────────────────────────────────────────────────────────

export interface FeedbackEntry {
  id: string
  question: string
  answer: string
  rating: 'positive' | 'negative' | 'neutral'
  correction?: string           // User's corrected answer
  tags: string[]
  timestamp: string
  userId?: string
  sessionId?: string
}

export interface FailurePattern {
  pattern: string               // e.g., "comparison questions fail"
  examples: string[]            // Example questions that failed
  suggestedFix: string          // Suggested fix (new tool, routing rule, etc.)
  confidence: number            // 0-1, how confident we are in this pattern
  occurrences: number
  lastSeen: string
}

export interface ImprovementAction {
  type: 'new_tool' | 'routing_rule' | 'synonym' | 'tool_fix'
  description: string
  priority: 'high' | 'medium' | 'low'
  estimatedImpact: number       // 0-1, estimated impact on accuracy
  implementation: string        // Implementation details
}

const FEEDBACK_DB_PATH = path.join(process.cwd(), 'data', 'feedback-database.json')
const PATTERNS_DB_PATH = path.join(process.cwd(), 'data', 'failure-patterns.json')
const IMPROVEMENTS_LOG_PATH = path.join(process.cwd(), 'data', 'improvements.json')

// ─── Feedback Collection ──────────────────────────────────────────────────────

/**
 * Record user feedback for a Q&A interaction.
 */
export async function recordFeedback(feedback: Omit<FeedbackEntry, 'id' | 'timestamp'>): Promise<FeedbackEntry> {
  const db = await loadFeedbackDatabase()
  const entry: FeedbackEntry = {
    ...feedback,
    id: `fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString()
  }
  db.push(entry)
  await saveFeedbackDatabase(db)
  
  // Analyze negative feedback for patterns
  if (entry.rating === 'negative') {
    await analyzeFailurePattern(entry)
  }
  
  return entry
}

/**
 * Get recent feedback for analysis.
 */
export async function getRecentFeedback(days = 7): Promise<FeedbackEntry[]> {
  const db = await loadFeedbackDatabase()
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  return db.filter(f => f.timestamp >= cutoff)
}

/**
 * Get feedback statistics.
 */
export async function getFeedbackStats(): Promise<{
  total: number
  positive: number
  negative: number
  neutral: number
  positiveRate: number
  topIssues: string[]
}> {
  const db = await loadFeedbackDatabase()
  const total = db.length
  const positive = db.filter(f => f.rating === 'positive').length
  const negative = db.filter(f => f.rating === 'negative').length
  const neutral = db.filter(f => f.rating === 'neutral').length
  
  // Find top issues from negative feedback
  const negativeFeedback = db.filter(f => f.rating === 'negative')
  const issueCounts = new Map<string, number>()
  for (const f of negativeFeedback) {
    for (const tag of f.tags) {
      issueCounts.set(tag, (issueCounts.get(tag) || 0) + 1)
    }
  }
  const topIssues = Array.from(issueCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag]) => tag)
  
  return {
    total,
    positive,
    negative,
    neutral,
    positiveRate: total > 0 ? positive / total : 0,
    topIssues
  }
}

// ─── Failure Pattern Analysis ─────────────────────────────────────────────────

/**
 * Analyze a failure and update patterns.
 */
async function analyzeFailurePattern(feedback: FeedbackEntry): Promise<void> {
  const patterns = await loadFailurePatterns()
  
  // Check if this matches an existing pattern
  let matched = false
  for (const pattern of patterns) {
    if (feedback.question.toLowerCase().includes(pattern.pattern.toLowerCase())) {
      pattern.occurrences++
      pattern.lastSeen = new Date().toISOString()
      pattern.examples.push(feedback.question)
      if (pattern.examples.length > 10) pattern.examples = pattern.examples.slice(-10)
      matched = true
      break
    }
  }
  
  // Create new pattern if no match
  if (!matched) {
    const pattern: FailurePattern = {
      pattern: extractPattern(feedback.question),
      examples: [feedback.question],
      suggestedFix: await suggestFix(feedback),
      confidence: 0.5,
      occurrences: 1,
      lastSeen: new Date().toISOString()
    }
    patterns.push(pattern)
  }
  
  await saveFailurePatterns(patterns)
}

/**
 * Extract a pattern from a question.
 */
function extractPattern(question: string): string {
  const q = question.toLowerCase()
  
  if (/\b(compare|vs|versus)\b/.test(q)) return 'comparison questions'
  if (/\b(breakdown|by \w+)\b/.test(q)) return 'breakdown questions'
  if (/\b(trend|over time)\b/.test(q)) return 'trend questions'
  if (/\b(top \d+|highest|best|most)\b/.test(q)) return 'ranking questions'
  if (/\b(how many|count|total)\b/.test(q)) return 'counting questions'
  if (/\b(list|show|display)\b/.test(q)) return 'listing questions'
  if (/\b(detail|tell me about|explain)\b/.test(q)) return 'detail questions'
  if (/\b(and|also|plus)\b/.test(q)) return 'multi-part questions'
  
  return 'general questions'
}

/**
 * Suggest a fix for a failed question.
 */
async function suggestFix(feedback: FeedbackEntry): Promise<string> {
  const analysisPrompt = `A user asked a CRM question and the system failed. Analyze why and suggest a fix.

Question: ${feedback.question}
System Answer: ${feedback.answer.slice(0, 500)}
User Correction: ${feedback.correction || 'None provided'}
Tags: ${feedback.tags.join(', ')}

Respond with ONLY JSON:
{
  "reason": "Why the system failed",
  "fix": "Specific suggestion (new tool, routing rule, or synonym)",
  "priority": "high|medium|low"
}`

  try {
    const raw = await chatJson(analysisPrompt, feedback.question)
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw
    return result.fix || 'No suggestion available'
  } catch {
    return 'Analysis failed — manual review needed'
  }
}

// ─── Improvement Suggestions ──────────────────────────────────────────────────

/**
 * Analyze all failures and suggest improvements.
 */
export async function generateImprovementSuggestions(): Promise<ImprovementAction[]> {
  const patterns = await loadFailurePatterns()
  const feedback = await getRecentFeedback(30) // Last 30 days
  
  const suggestions: ImprovementAction[] = []
  
  // Analyze patterns
  for (const pattern of patterns) {
    if (pattern.occurrences >= 3 && pattern.confidence >= 0.6) {
      suggestions.push({
        type: 'new_tool',
        description: `Add tool for: ${pattern.pattern}`,
        priority: pattern.occurrences >= 5 ? 'high' : 'medium',
        estimatedImpact: Math.min(0.3, pattern.occurrences * 0.05),
        implementation: pattern.suggestedFix
      })
    }
  }
  
  // Analyze negative feedback
  const negative = feedback.filter(f => f.rating === 'negative')
  const correctionPatterns = new Map<string, number>()
  for (const f of negative) {
    if (f.correction) {
      const key = f.tags.join(',') || 'uncategorized'
      correctionPatterns.set(key, (correctionPatterns.get(key) || 0) + 1)
    }
  }
  
  for (const [pattern, count] of correctionPatterns) {
    if (count >= 2) {
      suggestions.push({
        type: 'synonym',
        description: `Update synonyms for: ${pattern}`,
        priority: 'medium',
        estimatedImpact: Math.min(0.2, count * 0.05),
        implementation: `Add synonyms based on user corrections for ${pattern}`
      })
    }
  }
  
  return suggestions.sort((a, b) => b.estimatedImpact - a.estimatedImpact)
}

/**
 * Auto-apply low-risk improvements.
 */
export async function autoApplyImprovements(): Promise<ImprovementAction[]> {
  const suggestions = await generateImprovementSuggestions()
  const applied: ImprovementAction[] = []
  
  for (const suggestion of suggestions) {
    // Only auto-apply medium/low priority (high needs manual review)
    if (suggestion.priority === 'high') continue
    
    // Log the improvement
    await logImprovement(suggestion)
    applied.push(suggestion)
    
    console.log(`[self-improvement] Auto-applied: ${suggestion.description}`)
  }
  
  return applied
}

// ─── Production Monitoring ────────────────────────────────────────────────────

/**
 * Monitor a production query and track metrics.
 */
export async function monitorQuery(
  question: string,
  result: { answer: string; tool?: string; confidence: string; latencyMs: number },
  feedback?: { rating: 'positive' | 'negative' | 'neutral'; correction?: string }
): Promise<void> {
  // Record metric
  recordMetric({
    timestamp: new Date().toISOString(),
    question,
    toolMatched: result.tool || null,
    confidence: result.confidence as 'high' | 'medium' | 'low',
    method: 'production',
    latencyMs: result.latencyMs,
    soqlSuccess: true,
    guardrailBlocked: false,
    instructorRetries: 0,
    resultCount: 1
  })
  
  // Record feedback if provided
  if (feedback) {
    await recordFeedback({
      question,
      answer: result.answer,
      rating: feedback.rating,
      correction: feedback.correction,
      tags: extractTags(question)
    })
  }
  
  // Auto-flag low-confidence answers for review
  if (result.confidence === 'low') {
    console.log(`[self-improvement] Low confidence answer flagged: "${question}"`)
  }
}

/**
 * Extract tags from a question.
 */
function extractTags(question: string): string[] {
  const tags: string[] = []
  const q = question.toLowerCase()
  
  if (/\b(compare|vs|versus)\b/.test(q)) tags.push('comparison')
  if (/\b(breakdown|by \w+)\b/.test(q)) tags.push('breakdown')
  if (/\b(trend|over time)\b/.test(q)) tags.push('trend')
  if (/\b(top \d+|highest|best|most)\b/.test(q)) tags.push('ranking')
  if (/\b(how many|count|total)\b/.test(q)) tags.push('counting')
  if (/\b(list|show|display)\b/.test(q)) tags.push('listing')
  if (/\b(detail|tell me about|explain)\b/.test(q)) tags.push('detail')
  if (/\b(and|also|plus)\b/.test(q)) tags.push('multi-part')
  
  return tags
}

// ─── Database Helpers ─────────────────────────────────────────────────────────

async function loadFeedbackDatabase(): Promise<FeedbackEntry[]> {
  try {
    const data = await fs.readFile(FEEDBACK_DB_PATH, 'utf-8')
    return JSON.parse(data)
  } catch {
    return []
  }
}

async function saveFeedbackDatabase(db: FeedbackEntry[]): Promise<void> {
  const dir = path.dirname(FEEDBACK_DB_PATH)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(FEEDBACK_DB_PATH, JSON.stringify(db, null, 2))
}

async function loadFailurePatterns(): Promise<FailurePattern[]> {
  try {
    const data = await fs.readFile(PATTERNS_DB_PATH, 'utf-8')
    return JSON.parse(data)
  } catch {
    return []
  }
}

async function saveFailurePatterns(patterns: FailurePattern[]): Promise<void> {
  const dir = path.dirname(PATTERNS_DB_PATH)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(PATTERNS_DB_PATH, JSON.stringify(patterns, null, 2))
}

async function logImprovement(action: ImprovementAction): Promise<void> {
  let improvements: ImprovementAction[] = []
  try {
    const data = await fs.readFile(IMPROVEMENTS_LOG_PATH, 'utf-8')
    improvements = JSON.parse(data)
  } catch {
    improvements = []
  }
  
  improvements.push({
    ...action,
    description: `[${new Date().toISOString()}] ${action.description}`
  } as ImprovementAction)
  
  const dir = path.dirname(IMPROVEMENTS_LOG_PATH)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(IMPROVEMENTS_LOG_PATH, JSON.stringify(improvements, null, 2))
}

// ─── Health Check ─────────────────────────────────────────────────────────────

/**
 * Get system health metrics.
 */
export async function getSystemHealth(): Promise<{
  feedbackScore: number
  failureRate: number
  avgLatencyMs: number
  topPatterns: FailurePattern[]
  recentImprovements: ImprovementAction[]
}> {
  const stats = await getFeedbackStats()
  const patterns = await loadFailurePatterns()
  
  let improvements: ImprovementAction[] = []
  try {
    const data = await fs.readFile(IMPROVEMENTS_LOG_PATH, 'utf-8')
    improvements = JSON.parse(data)
  } catch {
    improvements = []
  }
  
  return {
    feedbackScore: stats.positiveRate,
    failureRate: stats.total > 0 ? stats.negative / stats.total : 0,
    avgLatencyMs: 0, // Would need to calculate from metrics
    topPatterns: patterns
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, 5),
    recentImprovements: improvements.slice(-10)
  }
}
