// Real client questions from Nshama database (Neon.tech)
// Extracted from "Sales and CRM - Nshama" space, user: Rashid
// These are actual questions the client asked during demo/testing sessions

import { answerSalesforceQuery } from '../salesforce/query'
import { writeFileSync } from 'fs'
import { resolve } from 'path'

const clientQuestions = [
  // From Rashid's session — Nshama client (2026-07-10/11)
  'how many sales happened in Camden?',
  'how many sales happened in 2026?',
  'what all units bought by anil pardesi',
  'who are top 10 customers',
  'compare 2024 vs 2025',
  'whats selling',
  'show all projects 2024 and 2025',
  'cmpare 20205 and 2026 sales based on projects',
  'Brief me on this project.',
  'What\'s most sellign',
  'Sales room wise data',
  'Do you have bedroom wise data? How many bedrooms and what?',
  'Project Alton. Compare 2024 and 2025 data.',
  'Compare all 10 project data for 2024 and 2025 based on bedroom wise.',
  'Compare 2025 and 2026 for Alton project based on bedroom wise.',
  'Quartal units sold in 2025 for Kaya project and compared 2025 and 2026.',
  'What all units are sold in 2026 for Kaya?',
  'what all communities they bought in ?',
  'are there any call inquiry cases related to these customers ?',
  'who are top 10 customers with highest value ?',
  'any call inquiries ?',
  'recent 10 violation requests over all and details of those ?',
  'breakdown by customer names',
  'any requests of customer ?',
  'give details of that top customer',
]

async function main() {
  console.log('═'.repeat(70))
  console.log(` REAL CLIENT VALIDATION — ${clientQuestions.length} questions from Nshama DB`)
  console.log('═'.repeat(70))
  console.log()

  const results: { q: string; answer: string; tool: string; method: string; ok: 'PASS' | 'FAIL' | 'PARTIAL'; latencyMs: number; notes: string }[] = []

  for (let i = 0; i < clientQuestions.length; i++) {
    const q = clientQuestions[i]
    const start = Date.now()
    try {
      const result = await answerSalesforceQuery(q)
      const ms = Date.now() - start
      const answer = result?.context ?? 'NO ANSWER'
      const tool = result?.citation?.documentName ?? 'none'

      // Quality check — tightened criteria
      let ok: 'PASS' | 'FAIL' | 'PARTIAL' = 'PASS'
      let notes = ''

      if (!result) {
        ok = 'FAIL'
        notes = 'Null result'
      } else if (answer.includes('0 records found')) {
        ok = 'PARTIAL'
        notes = 'Zero records'
      } else if (answer.startsWith('I need') || answer.startsWith('I can') || answer.startsWith('Retry') || answer.startsWith('Try re-running')) {
        ok = 'PARTIAL'
        notes = 'Clarification asked or retry'
      } else if (answer.includes('Use this exact number as the answer') && answer.includes('Total')) {
        // Count query — OK
      } else if (answer.includes('record(s) matched') && answer.includes('Name:')) {
        // Raw records — check if question wanted aggregation
        if (q.toLowerCase().includes('how many') || q.toLowerCase().includes('total') || q.toLowerCase().includes('count')) {
          ok = 'PARTIAL'
          notes = 'Returned records instead of count'
        }
      } else if (answer.length < 10) {
        ok = 'PARTIAL'
        notes = 'Answer too short'
      } else if (answer.includes('Amount: 1') && answer.includes('2032-12-28')) {
        ok = 'PARTIAL'
        notes = 'Test data returned'
      } else if (answer.includes('Salesforce Admin') && !answer.includes('Sales Person: Salesforce Admin |')) {
        // Only flag if the ENTIRE answer is Salesforce Admin (not just one field)
        const lines = answer.split('\n').filter(l => l.includes('Salesforce Admin'))
        if (lines.length > 3) {
          ok = 'PARTIAL'
          notes = 'Test data (all Salesforce Admin)'
        }
      }

      results.push({ q, answer: answer.slice(0, 300), tool, method: result?.citation?.documentName ?? 'none', ok, latencyMs: ms, notes })

      const icon = ok === 'PASS' ? '✓' : ok === 'FAIL' ? '✗' : '~'
      const num = String(i + 1).padStart(3, ' ')
      console.log(`[${num}] ${icon} ${q.slice(0, 55).padEnd(55)} ${String(ms).padStart(5)}ms  ${notes || ok}`)
      if (ok !== 'PASS') {
        console.log(`      Answer: ${answer.slice(0, 150)}`)
      }
    } catch (err: unknown) {
      const ms = Date.now() - start
      results.push({ q, answer: `ERROR: ${(err as Error).message?.slice(0, 150)}`, tool: 'error', method: 'error', ok: 'FAIL', latencyMs: ms, notes: (err as Error).message?.slice(0, 100) ?? '' })
      const num = String(i + 1).padStart(3, ' ')
      console.log(`[${num}] ✗ ${q.slice(0, 55).padEnd(55)} ${String(ms).padStart(5)}ms  ERROR: ${(err as Error).message?.slice(0, 80)}`)
    }
  }

  // Summary
  const pass = results.filter(r => r.ok === 'PASS').length
  const partial = results.filter(r => r.ok === 'PARTIAL').length
  const fail = results.filter(r => r.ok === 'FAIL').length
  const avgMs = Math.round(results.reduce((s, r) => s + r.latencyMs, 0) / results.length)

  console.log()
  console.log('═'.repeat(70))
  console.log(` RESULTS: ${pass} PASS / ${partial} PARTIAL / ${fail} FAIL / ${clientQuestions.length} TOTAL`)
  console.log(` AVG LATENCY: ${avgMs}ms`)
  console.log('═'.repeat(70))

  if (fail > 0) {
    console.log()
    console.log('FAILED QUESTIONS:')
    results.filter(r => r.ok === 'FAIL').forEach(r => console.log(`  ✗ ${r.q}\n    ${r.notes}`))
  }
  if (partial > 0) {
    console.log()
    console.log('PARTIAL ANSWERS:')
    results.filter(r => r.ok === 'PARTIAL').forEach(r => console.log(`  ~ ${r.q}\n    ${r.notes}`))
  }

  // Print full answers for review
  console.log()
  console.log('═'.repeat(70))
  console.log(' FULL ANSWERS')
  console.log('═'.repeat(70))
  for (const r of results) {
    console.log(`\nQ: ${r.q}`)
    console.log(`A: ${r.answer}`)
    console.log(`Tool: ${r.tool} | ${r.latencyMs}ms | ${r.ok}`)
  }

  // Write to file
  const outPath = resolve(__dirname, '../../client-validation-results.txt')
  const lines = results.map((r, i) => {
    return [
      `Q${i + 1}: ${r.q}`,
      `Tool: ${r.tool} | Method: ${r.method} | ${r.latencyMs}ms`,
      `Status: ${r.ok}${r.notes ? ' — ' + r.notes : ''}`,
      `Answer: ${r.answer}`,
      '─'.repeat(70),
    ].join('\n')
  })
  writeFileSync(outPath, `CLIENT VALIDATION — ${new Date().toISOString()}\n${pass} PASS / ${partial} PARTIAL / ${fail} FAIL / ${clientQuestions.length} TOTAL\nAvg latency: ${avgMs}ms\n\n${lines.join('\n\n')}`, 'utf-8')
  console.log(`\nDetailed results written to: ${outPath}`)
}

main().catch(console.error)
