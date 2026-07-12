#!/usr/bin/env npx tsx
// Import client questions from Questions.docx into the eval framework.
// Run: npx tsx src/eval/import-client-questions.ts

import * as fs from 'fs/promises'
import * as path from 'path'

const CLIENT_QUESTIONS_PATH = path.join(process.cwd(), 'data', 'client-questions.json')
const EVAL_DB_PATH = path.join(process.cwd(), 'data', 'eval-database.json')

interface ClientQuestion {
  question: string
  category: string
  difficulty: 'easy' | 'medium' | 'hard'
}

interface EvalQuestion {
  id: string
  question: string
  category: string
  difficulty: 'easy' | 'medium' | 'hard'
  tags: string[]
  createdAt: string
  runCount: number
  passCount: number
}

async function main() {
  // Load client questions
  const rawData = await fs.readFile(CLIENT_QUESTIONS_PATH, 'utf-8')
  const clientQuestions: ClientQuestion[] = JSON.parse(rawData)
  console.log(`Loaded ${clientQuestions.length} client questions`)

  // Load existing eval database (if any)
  let existingQuestions: EvalQuestion[] = []
  try {
    const existingData = await fs.readFile(EVAL_DB_PATH, 'utf-8')
    existingQuestions = JSON.parse(existingData)
  } catch {
    console.log('No existing eval database found, creating new one')
  }

  // Create a set of existing questions for deduplication
  const existingSet = new Set(existingQuestions.map(q => q.question.toLowerCase()))

  // Import new questions
  let imported = 0
  let skipped = 0

  for (const cq of clientQuestions) {
    if (existingSet.has(cq.question.toLowerCase())) {
      skipped++
      continue
    }

    const evalQuestion: EvalQuestion = {
      id: `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      question: cq.question,
      category: cq.category,
      difficulty: cq.difficulty,
      tags: [cq.category.split(' ')[0].toLowerCase()],
      createdAt: new Date().toISOString(),
      runCount: 0,
      passCount: 0,
    }

    existingQuestions.push(evalQuestion)
    existingSet.add(cq.question.toLowerCase())
    imported++
  }

  // Save updated eval database
  await fs.writeFile(EVAL_DB_PATH, JSON.stringify(existingQuestions, null, 2))
  console.log(`\nImport complete:`)
  console.log(`  Imported: ${imported}`)
  console.log(`  Skipped (duplicates): ${skipped}`)
  console.log(`  Total in database: ${existingQuestions.length}`)

  // Print category breakdown
  const categories: Record<string, number> = {}
  for (const q of existingQuestions) {
    categories[q.category] = (categories[q.category] || 0) + 1
  }
  console.log(`\nCategory breakdown:`)
  for (const [cat, count] of Object.entries(categories).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`)
  }
}

main().catch(console.error)