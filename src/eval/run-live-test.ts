// End-to-end live test — runs real questions against live Salesforce.
// Run: npx tsx --env-file=.env.local src/eval/run-live-test.ts

import { answerSalesforceQuery } from '../salesforce/query'

const QUESTIONS = [
  'How many deals did we close this month?',
  'Which community has the most sales?',
  'Who is the top salesperson?',
  "What's our pipeline looking like?",
  'How many cases do we have?',
  'What are the major types of cases?',
  'Show me recent deals',
  'How many leads do we have?',
  'Average deal size?',
  "What's our win rate?",
  'How many cancellations?',
  'How many villas vs apartments?',
  'Monthly sales trend',
  'How many handovers are completed?',
  'Tell me about customer Al Futtaim',
  'What are the related deals for TS LXT-1-17812?',
  'What project details do we have?',
  'What unit details are linked to deal TS LXT-5-515?',
]

async function runLiveTest() {
  console.log(`\n${'═'.repeat(70)}`)
  console.log(` LIVE SALESFORCE END-TO-END TEST — ${QUESTIONS.length} questions`)
  console.log(`${'═'.repeat(70)}\n`)

  const results: { question: string; answer: string; tool: string | null; latencyMs: number; success: boolean }[] = []

  for (let i = 0; i < QUESTIONS.length; i++) {
    const q = QUESTIONS[i]
    const start = Date.now()
    try {
      const result = await answerSalesforceQuery(q)
      const elapsed = Date.now() - start
      const answer = result?.context?.slice(0, 300) || '(no answer)'
      const tool = result?.citation?.documentName || '(no tool)'
      results.push({ question: q, answer, tool, latencyMs: elapsed, success: !!result?.context })
      console.log(`${'─'.repeat(70)}`)
      console.log(`Q${i + 1}: "${q}"`)
      console.log(`Tool: ${tool} | ${elapsed}ms`)
      console.log(`A: ${answer}`)
    } catch (err) {
      const elapsed = Date.now() - start
      results.push({ question: q, answer: `ERROR: ${err}`, tool: null, latencyMs: elapsed, success: false })
      console.log(`${'─'.repeat(70)}`)
      console.log(`Q${i + 1}: "${q}"`)
      console.log(`ERROR: ${err}`)
    }
  }

  // Summary
  console.log(`\n${'═'.repeat(70)}`)
  console.log(` SUMMARY`)
  console.log(`${'═'.repeat(70)}`)
  const passed = results.filter(r => r.success).length
  const avgLatency = Math.round(results.reduce((s, r) => s + r.latencyMs, 0) / results.length)
  console.log(`Passed: ${passed}/${QUESTIONS.length} (${Math.round(passed / QUESTIONS.length * 100)}%)`)
  console.log(`Average latency: ${avgLatency}ms`)
  console.log(`Slowest: ${Math.max(...results.map(r => r.latencyMs))}ms`)
  console.log(`Fastest: ${Math.min(...results.map(r => r.latencyMs))}ms`)
  console.log(`${'═'.repeat(70)}\n`)
}

runLiveTest().catch(console.error)
