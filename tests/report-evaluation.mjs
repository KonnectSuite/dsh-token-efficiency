/** Recompute a transparent summary from preserved, sanitized evaluation records. */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const dir = resolve(process.argv[2] ?? '_scratch/token-efficiency-evaluation')
const lines = async name => (await readFile(join(dir, name), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const rows = await lines('results.jsonl')
const reviews = await lines('reviews.jsonl')
const ledger = await lines('requests.jsonl')
const input = row => row.usage.inputTokens + (row.usage.cacheReadTokens ?? 0) + (row.usage.cacheWriteTokens ?? 0)
const aggregate = data => ({ runs: data.length, inputTokens: data.reduce((s, r) => s + input(r), 0),
  cacheReadTokens: data.reduce((s, r) => s + (r.usage.cacheReadTokens ?? 0), 0),
  outputTokens: data.reduce((s, r) => s + r.usage.outputTokens, 0),
  requests: data.reduce((s, r) => s + r.requests, 0),
  seconds: data.reduce((s, r) => s + r.milliseconds / 1000, 0),
  estimatedCostUsd: data.reduce((s, r) => s + r.conservativeCostUsd, 0),
  originalMechanicalPasses: data.filter(r => r.success).length,
  correctedMechanicalPasses: data.filter(r => r.success || (r.id.startsWith('history-') && !r.error
    && r.missing.length === 1 && r.missing[0] === 'superseded' && /supersed/i.test(r.text) && !r.forbidden.length)).length })
const compare = data => Object.fromEntries(['off', 'efficient'].map(mode => [mode, aggregate(data.filter(r => r.mode === mode))]))
const dimensions = ['correctness', 'completeness', 'instructionAdherence', 'grounding', 'clarity']
const average = values => values.reduce((s, x) => s + x, 0) / values.length
const score = item => average(dimensions.map(key => item[key]))
const clusters = new Map()
const flagged = []
for (const pair of reviews) {
  const baseline = pair.review[pair.A === 'off' ? 'A' : 'B']
  const efficient = pair.review[pair.A === 'efficient' ? 'A' : 'B']
  const values = clusters.get(pair.id) ?? []
  values.push(score(efficient) - score(baseline))
  clusters.set(pair.id, values)
  for (const key of ['A', 'B']) if (pair.review[key].criticalRegression) {
    flagged.push({ pair: pair.pair, mode: pair[key], explanation: pair.review[key].explanation })
  }
}
const taskMeans = [...clusters.values()].map(average)
let seed = 20260927
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
const bootstrap = Array.from({ length: 10000 }, () => average(taskMeans.map(() => taskMeans[Math.floor(random() * taskMeans.length)]))).sort((a, b) => a - b)
const report = {
  model: 'deepseek-flash', reasoningEffort: 'high', defaultMode: 'measure',
  overall: compare(rows),
  categories: Object.fromEntries([...new Set(rows.map(r => r.category))].map(category => [category, compare(rows.filter(r => r.category === category))])),
  mcpHeavy: compare(rows.filter(r => ['single-mcp', 'multiple-mcp', 'recovery'].includes(r.category)
    || ['engineering-3', 'engineering-4'].includes(r.id))),
  supplementaryJudge: { completedPairs: reviews.length, expectedPairs: 72,
    meanPairedDifference: average(taskMeans), taskClusterBootstrap95Percent: [bootstrap[250], bootstrap[9749]],
    flagged, humanReviewComplete: false },
  budgetLedgerUsd: ledger.reduce((s, r) => s + r.chargedUsd, 0),
  caveats: [
    'Prices are conservative estimates, not independently reconciled billed charges.',
    '144 task executions use isolated fixture integrations; they are not a live engineering acceptance test.',
    'All tasks start fresh sessions; within-task requests reuse context, but warm cross-turn sessions were not benchmarked.',
    'Mechanical substring checks are weak. Corrected count accepts supersedes/superseded; original records are preserved.',
    'Automated blinded scores are supplementary; consequential flags require human review.',
    'Judge sees final responses and fixture facts, not full tool traces; grounding flags and intervals are provisional.',
    'Non-increasing aggregate cost gate fails. Efficient mode must remain opt-in.',
  ],
}
await writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
