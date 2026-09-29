/** Opt-in paid evaluation through the real AgentLoop, plugin and DeepSeek adapter. */
import { readFile, mkdir, appendFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { createUserMessage, ReasoningEffortId, type GenerateOptions, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as efficiency from '../src/index.ts'
import { cases, fixtureTools } from './evaluation-cases.ts'

const resultSchema = z.object({
  id: z.string(), category: z.string(), repetition: z.number(), mode: z.string(), text: z.string(), success: z.boolean(),
  missing: z.array(z.string()), forbidden: z.array(z.string()), requests: z.number(), milliseconds: z.number(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number(),
    cacheReadTokens: z.number().optional(), cacheWriteTokens: z.number().optional() }),
  conservativeCostUsd: z.number(), error: z.string().nullable(),
})
type RecordResult = z.infer<typeof resultSchema>

const enabled = process.env['ARYA_EFFICIENCY_PAID_EVAL'] === '1'
it.skipIf(!enabled)('compares baseline and efficient tools on fixed isolated DeepSeek tasks', async () => {
  const home = process.env['ARYA_EFFICIENCY_EVAL_HOME']
  if (!home) throw new Error('Set ARYA_EFFICIENCY_EVAL_HOME to the configured Arya home; credentials are read only.')
  const credentials = z.object({ refs: z.record(z.string(), z.string()) }).parse(parse(await readFile(join(home, '.credentials.yaml'), 'utf8')))
  const key: unknown = credentials.refs?.DEEPSEEK_API_KEY
  if (typeof key !== 'string' || !key.startsWith('sk-')) throw new Error('No configured DeepSeek API key found')
  const profile: unknown = parse(await readFile(join(home, 'profiles/desktop/cordis.patch.yml'), 'utf8'))
  const findRoute = (entries: unknown): { provider: string; model: string; reasoningEffort: string; maxTokens?: number } | undefined => {
    const list = z.array(z.record(z.string(), z.unknown())).safeParse(entries)
    if (!list.success) return undefined
    for (const entry of list.data) {
      const candidate = z.object({ provider: z.literal('deepseek-official'), model: z.string(), reasoningEffort: z.string(), maxTokens: z.number().optional() }).safeParse(entry.config)
      if (candidate.success) return { provider: candidate.data.provider, model: candidate.data.model,
        reasoningEffort: candidate.data.reasoningEffort,
        ...candidate.data.maxTokens === undefined ? {} : { maxTokens: candidate.data.maxTokens } }
      const nested = findRoute(entry.config)
      if (nested) return nested
    }
    return undefined
  }
  const route = findRoute(profile)
  if (!route || route.model !== 'deepseek-flash' || !['high', 'max'].includes(route.reasoningEffort)) throw new Error('Evaluation only runs the configured deepseek-flash route at high or max reasoning; refuse to change the selected route.')
  const modeNames = ['off', 'measure', 'save', 'efficient'] as const
  const configuredModes = (process.env['ARYA_EFFICIENCY_EVAL_MODES'] ?? 'off,efficient').split(',').map(item => item.trim())
  if (configuredModes.length !== 2 || configuredModes.some(item => !modeNames.includes(item as typeof modeNames[number]))) throw new Error('ARYA_EFFICIENCY_EVAL_MODES must name two of off, measure, save, efficient')
  const modePair = configuredModes as [typeof modeNames[number], typeof modeNames[number]]
  const balance = async (): Promise<number> => {
    const response = await fetch('https://api.deepseek.com/user/balance', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error(`Balance read failed: HTTP ${response.status}`)
    const body = z.object({
      balance_infos: z.array(z.object({ currency: z.string(), total_balance: z.string() })),
    }).parse(await response.json())
    const usd = body.balance_infos?.find((item: { currency: string }) => item.currency === 'USD')
    const amount = Number(usd?.total_balance)
    if (!Number.isFinite(amount) || amount < 0) throw new Error('No valid USD balance; refusing unbudgeted evaluation')
    return amount
  }
  const startingBalance = await balance()
  const requestedCap = Number(process.env['ARYA_EFFICIENCY_EVAL_CAP_USD'] ?? 30)
  if (!Number.isFinite(requestedCap) || requestedCap <= 0) throw new Error('Invalid evaluation cap')
  const cap = Math.min(30, requestedCap, startingBalance)
  const softCap = Math.max(0, cap - 3)
  const dir = resolve(process.env['ARYA_EFFICIENCY_EVAL_OUTPUT'] ?? '_scratch/token-efficiency-evaluation')
  await mkdir(dir, { recursive: true })
  const ledger = join(dir, 'requests.jsonl')
  // Resume uses reservations, including failed/incomplete requests; never silently reset spend.
  let charged = 0
  try { for (const line of (await readFile(ledger, 'utf8')).trim().split('\n').filter(Boolean)) charged += z.object({ chargedUsd: z.number() }).parse(JSON.parse(line)).chargedUsd }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const results: RecordResult[] = []
  try { for (const line of (await readFile(join(dir, 'results.jsonl'), 'utf8')).trim().split('\n').filter(Boolean)) results.push(resultSchema.parse(JSON.parse(line))) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const options = resolveAdapterOptions({}, createLaunchEnvironmentSnapshot([]))
  const maxTasks = Number(process.env['ARYA_EFFICIENCY_EVAL_MAX_TASKS'] ?? 144)
  let stopped: string | null = null
  // One case per category first, so the first 12 task runs form the six-pair pilot.
  const ordered = [0, 4, 8, 12, 16, 20, ...cases.map((_, i) => i).filter(i => ![0, 4, 8, 12, 16, 20].includes(i))]
  outer: for (let repetition = 0; repetition < 3; repetition++) for (const caseIndex of ordered) {
    const task = cases[caseIndex]!
    const modes = (caseIndex + repetition) % 2 === 0 ? modePair : [modePair[1], modePair[0]] as const
    for (const mode of modes) {
      if (results.some(r => r.id === task.id && r.repetition === repetition && r.mode === mode)) continue
      if (results.length >= maxTasks) { stopped = 'Configured task limit'; break outer }
      if (charged + 1 > softCap) { stopped = 'Budget soft stop'; break outer }
      const ctx = new Context()
      let requests = 0
      let cost = 0
      const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
      let error: string | null = null
      const started = Date.now()
      class MeteredAdapter extends DeepSeekAdapter {
        override async prepareCall(provider: string, model: string, signal?: AbortSignal) {
          const prepared = await super.prepareCall(provider, model, signal)
          return { ...prepared, stream: (request: GenerateOptions) => this.measure(prepared.stream(request)) }
        }
        private async * measure(stream: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
          if (++requests > 12) throw new Error('Discovery/request loop limit exceeded')
          if (charged + 1 > softCap) throw new Error('Budget soft stop')
          // Reserve $1 before dispatch. Peak Flash upper bound for the configured context/output is below this.
          charged += 1
          await appendFile(ledger, JSON.stringify({ id: task.id, repetition, mode, request: requests, chargedUsd: 1, kind: 'reservation' }) + '\n')
          let finalUsage: TokenUsage | undefined
          for await (const chunk of stream) {
            if (chunk.type === 'usage') finalUsage = chunk.usage
            yield chunk
          }
          if (finalUsage) {
            // Conservative peak schedule, independent of cache warmth; not a claim of exact billing.
            const measured = (finalUsage.inputTokens * 0.3 + (finalUsage.cacheReadTokens ?? 0) * 0.006
              + (finalUsage.cacheWriteTokens ?? 0) * 0.3 + finalUsage.outputTokens * 1.2) / 1_000_000
            cost += measured
            charged += measured - 1
            usage.inputTokens += finalUsage.inputTokens; usage.outputTokens += finalUsage.outputTokens
            usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (finalUsage.cacheReadTokens ?? 0)
            usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + (finalUsage.cacheWriteTokens ?? 0)
            await appendFile(ledger, JSON.stringify({ id: task.id, repetition, mode, request: requests, chargedUsd: measured - 1, kind: 'settlement', usage: finalUsage }) + '\n')
          }
        }
      }
      let text = ''
      try {
        await mountAgentLoopTestDependencies(ctx)
        await ctx.plugin(AgentLoop, { agents: [] })
        await ctx.plugin(efficiency, { mode })
        ctx.llm.registerAdapter(['deepseek-official'], new MeteredAdapter({ options: () => options,
          resolveAuth: async () => ({ headers: { 'x-api-key': key } }),
          resolveUserId: () => '00000000-0000-4000-8000-000000000001' as AnonymousUserId,
          prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
        }))
        let healthCalls = 0
        for (const [name, description, response] of fixtureTools) ctx.tools.register({ name, description,
          parameters: { type: 'object', properties: {} },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: z.string().parse(value) }] },
          execute: async () => name === 'mcp__health__flaky' && healthCalls++ === 0 ? 'ERROR: transient failure; retry once' : response,
        })
        const agent = await ctx.agentLoop.create(SessionId(`eval-${task.id}-${mode}-${repetition}`), { provider: route.provider, model: route.model,
          reasoningEffort: ReasoningEffortId(route.reasoningEffort),
          ...route.maxTokens === undefined ? {} : { maxTokens: route.maxTokens } })
        const timer = setTimeout(() => { agent.cancel({ kind: 'user' }) }, 180_000)
        try {
          for (const history of task.history ?? []) agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: history }], source: { kind: 'user' } }), { surfaceOp: 'append' })
          agent.followup(createUserMessage({ content: [{ type: 'text', text: task.prompt }], source: { kind: 'user' } }))
          await agent.whenIdle()
          const messages = agent.session.snapshotEvents().filter(e => e.type === 'assistant/message')
          text = messages.at(-1)?.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n') ?? ''
          await writeFile(join(dir, `${task.id}-${repetition}-${mode}.json`), JSON.stringify(agent.session.snapshotEvents(), null, 2))
        } finally { clearTimeout(timer) }
      } catch (caught) { error = caught instanceof Error ? caught.message : String(caught) }
      finally { await ctx.fiber.dispose() }
      const missing = task.required.filter(word => !text.toLowerCase().includes(word.toLowerCase()))
      const forbidden = (task.forbidden ?? []).filter(word => text.toLowerCase().includes(word.toLowerCase()))
      const result = { id: task.id, category: task.category, repetition, mode, text,
        success: !error && !missing.length && !forbidden.length,
        missing, forbidden, requests, milliseconds: Date.now() - started, usage, conservativeCostUsd: cost, error }
      results.push(result)
      await appendFile(join(dir, 'results.jsonl'), JSON.stringify(result) + '\n')
      console.log(JSON.stringify({ completed: results.length, id: task.id, mode, success: result.success, chargedUsd: charged }))
      if (error || !text) { stopped = error ?? 'No final response'; break outer }
    }
  }
  const endingBalance = await balance()
  await writeFile(join(dir, 'summary.json'), JSON.stringify({ model: route.model, reasoningEffort: route.reasoningEffort,
    completed: results.length, expected: 144, startingBalance, endingBalance, accountBalanceDelta: startingBalance - endingBalance,
    conservativeChargedUsd: charged, cap, stopped, qualityStatus: 'Requires blinded rubric review; deterministic fact checks are not a quality score',
    defaultMode: 'measure', results }, null, 2))
  expect(charged).toBeLessThanOrEqual(cap)
}, 7_200_000)
