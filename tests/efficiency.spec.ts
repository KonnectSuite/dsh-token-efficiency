import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createVolatile, updateVolatile, isVolatile } from '@deepseek-ai/cosmokit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Agents, { agentEvents, emitAgentEvent, type Agent } from '@deepseek-ai/dsh-agent'
import Projections from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { PtcRuntime, type PtcRunRequest, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import * as plugin from '../src/index.ts'
import { matchTools, searchTools, serverCatalog } from '../src/policy.ts'

async function mount(mode: 'off' | 'measure' | 'save' | 'efficient' = 'efficient') {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(Projections)
  await ctx.plugin(Agents)
  const config = { mode, pageSize: 2 }
  const fiber = await ctx.plugin(plugin, config)
  for (const name of ['read', 'mcp__comfy__generate', 'mcp__comfy__workflows', 'mcp__files__search']) {
    ctx.tools.register({ name, description: `${name} tool`, parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      execute: async () => 'ok' })
  }
  const agent = { id: SessionId('test'), session: Session.create(SessionId('test')), options: {} } as Agent
  await ctx.plugin(Object.assign((inner: Context) => {
    Object.assign(agent, { ctx: createScope(inner, agent).ctx })
  }, { inject: ['tools', 'systemPrompt', 'agents', 'sessionProjections'] }))
  await agentEvents(ctx, agent).waterfall('agent/pre-step', { turn: 1, step: 1, signal: new AbortController().signal, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  const assemble = () => ctx.systemPrompt.assemble({ scope: agent, agent })
  const discover = (query: string, offset = 0) => ctx.tools.execute({ name: 'discover_tools', arguments: { query, offset }, agent, callId: ToolCallId('discovery'), signal: new AbortController().signal })
  const say = (text: string) => {
    emitAgentEvent(ctx, agent, 'agent/inbox/claimed', {
      message: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), turn: 1,
    })
  }
  return { ctx, fiber, agent, assemble, discover, say }
}

describe('token efficiency', () => {
  it('samples policy changes only at turn boundaries and records them for replay', async () => {
    const h = await mount()
    try {
      await h.assemble()
      const config = h.fiber.config as plugin.Config
      if (!isVolatile(config.mode)) throw new Error('Expected parsed volatile setting')
      updateVolatile(config.mode, createVolatile('off'))
      expect((await h.assemble()).tools.map(t => t.name)).toContain('discover_tools')
      await agentEvents(h.ctx, h.agent).waterfall('agent/pre-step', { turn: 2, step: 1,
        signal: new AbortController().signal, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
      expect((await h.assemble()).tools.map(t => t.name)).not.toContain('discover_tools')
      expect(h.ctx.sessionProjections.stateOf(h.agent.session, 'tokenEfficiency')).toMatchObject({ mode: 'off', turn: 2 })
    } finally { await h.ctx.fiber.dispose() }
  })
  it('keeps built-ins out of catalog browsing', async () => {
    const h = await mount()
    try {
      await h.assemble()
      await h.discover('read')
      expect(h.ctx.sessionProjections.stateOf(h.agent.session, 'tokenEfficiency')?.activated).toEqual([])
    } finally { await h.ctx.fiber.dispose() }
  })
  it('retains activation through disconnect and uses refreshed schemas on reconnect', async () => {
    const h = await mount()
    try {
      const definition = { name: 'mcp__temporary__lookup', description: 'temporary lookup', parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' as const }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }] },
        execute: async () => 'ok' }
      const disconnect = h.ctx.tools.register(definition)
      await h.assemble()
      await h.discover('temporary')
      disconnect()
      expect((await h.assemble()).tools.map(t => t.name)).not.toContain(definition.name)
      h.ctx.tools.register({ ...definition, description: 'refreshed schema' })
      expect((await h.assemble()).tools.find(t => t.name === definition.name)?.description).toBe('refreshed schema')
    } finally { await h.ctx.fiber.dispose() }
  })
  it.each(['ptc', 'both'] as const)('leaves %s tool presentation unchanged', async (mode) => {
    const h = await mount()
    try {
      class Runtime extends PtcRuntime {
        readonly language = 'typescript'
        readonly isolation = 'fixture'
        resolve(request: PtcRunRequest): PtcRunSpec { return { ...request, cwd: '.', timeoutMs: 1000 } }
        async run() { return { logs: [] } }
      }
      await h.ctx.plugin(Runtime)
      h.agent.ctx.tools.presentAs(mode)
      const assembly = await h.assemble()
      expect(assembly.tools.map(t => t.name)).not.toContain('discover_tools')
      await h.fiber.dispose()
      expect(await h.assemble()).toEqual(assembly)
    } finally { await h.ctx.fiber.dispose() }
  })
  it.each(['off', 'measure'] as const)('%s preserves baseline tools and prompt', async (mode) => {
    const h = await mount(mode)
    try {
      const value = await h.assemble()
      expect(value.tools.map(tool => tool.name)).toEqual(['mcp__comfy__generate', 'mcp__comfy__workflows', 'mcp__files__search', 'read'])
      await h.fiber.dispose()
      expect(value).toEqual(await h.assemble())
    } finally { await h.ctx.fiber.dispose() }
  })
  it('discovers then activates original schemas without changing built-ins', async () => {
    const h = await mount()
    try {
      expect((await h.assemble()).tools.map(tool => tool.name)).toEqual(['read', 'discover_tools'])
      const result = await h.discover('generate')
      expect(result.isError).not.toBe(true)
      const tools = (await h.assemble()).tools
      expect(tools.map(tool => tool.name)).toEqual(['mcp__comfy__generate', 'read', 'discover_tools'])
      expect(tools[0]).toEqual(h.ctx.tools.schemas(h.agent).find(tool => tool.name === 'mcp__comfy__generate'))
      const state = h.ctx.sessionProjections.stateOf(h.agent.session, 'tokenEfficiency')!
      expect(state.discoveryCalls).toBe(1)
      expect(state.deferred).toBe(2)
      const replay = h.agent.session.snapshotEvents().reduce(
        (state, event) => plugin.efficiencyProjection.apply(state, event), plugin.initialState())
      expect(replay).toEqual(state)
    } finally { await h.ctx.fiber.dispose() }
  })
  it('does not disclose restricted tools and does not grant execution permission', async () => {
    const h = await mount()
    try {
      h.agent.ctx.tools.restrict({ deny: ['mcp__files__search'] })
      await h.assemble()
      expect(JSON.stringify(await h.discover('files'))).not.toContain('mcp__files__search')
      const result = await h.ctx.tools.execute({ name: 'mcp__files__search', arguments: {}, agent: h.agent, callId: ToolCallId('denied'), signal: new AbortController().signal })
      expect(result.isError).toBe(true)
    } finally { await h.ctx.fiber.dispose() }
  })
  it('still requires execution approval after discovery', async () => {
    const h = await mount()
    try {
      await h.assemble()
      await h.discover('generate')
      h.ctx.on('tools/pre-execute', async () => ({ kind: 'ask' as const, reason: 'Fixture requires approval' }))
      const result = await h.ctx.tools.execute({ name: 'mcp__comfy__generate', arguments: {}, agent: h.agent,
        callId: ToolCallId('approval'), signal: new AbortController().signal })
      expect(result.isError).toBe(true)
    } finally { await h.ctx.fiber.dispose() }
  })
  it('stops withholding schemas once a turn burns through its discovery budget', async () => {
    const h = await mount()
    try {
      await h.assemble()
      // Two discoveries are within budget: the turn keeps deferring.
      await h.discover('generate')
      await h.discover('files')
      expect((await h.assemble()).tools.some(tool => tool.name === 'discover_tools')).toBe(true)
      // The third crosses the ratchet. The catalog comes back in full and discovery
      // stops being offered, so a turn that needs tools it cannot name stops paying
      // a round-trip for every attempt.
      await h.discover('inventory')
      const tools = (await h.assemble()).tools
      expect(tools.some(tool => tool.name === 'discover_tools')).toBe(false)
      expect(tools.some(tool => tool.name === 'mcp__files__search')).toBe(true)
      const denied = await h.ctx.tools.execute({ name: 'discover_tools', arguments: { query: 'inventory' },
        agent: h.agent, callId: ToolCallId('ratcheted'), signal: new AbortController().signal })
      expect(denied.isError).toBe(true)
      // The ratchet is per turn, so the next turn defers again.
      await agentEvents(h.ctx, h.agent).waterfall('agent/pre-step',
        { turn: 2, step: 1, signal: new AbortController().signal, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
      expect((await h.assemble()).tools.some(tool => tool.name === 'discover_tools')).toBe(true)
    } finally { await h.ctx.fiber.dispose() }
  })
  it('paginates the catalog and keeps no-match discovery recoverable', async () => {
    const h = await mount()
    try {
      await h.assemble()
      expect(JSON.stringify(await h.discover(''))).toContain('nextOffset')
      await h.discover('', 2)
      expect((await h.assemble()).tools).toHaveLength(5)
      // A no-match query keeps the short recovery hint, and the `absent` flag rides
      // along as telemetry. Longer absence wording measured worse and cost tokens on
      // every result, so the hint itself stays brief.
      const absent = JSON.parse(
        (await h.discover('nonexistent') as { content: { text: string }[] }).content[0]!.text,
      ) as { absent: boolean; hint: string }
      expect(absent.absent).toBe(true)
      expect(absent.hint).toContain('broader query')
    } finally { await h.ctx.fiber.dispose() }
  })
  it('disposes discovery and presentation filtering together', async () => {
    const h = await mount()
    try {
      await h.fiber.dispose()
      expect(h.ctx.tools.get('discover_tools')).toBeUndefined()
      expect((await h.assemble()).tools).toHaveLength(4)
    } finally { await h.ctx.fiber.dispose() }
  })
  it('ranks exact names ahead of description-only matches', () => {
    const tools = [
      { name: 'mcp__a__other', description: 'generate', parameters: {} },
      { name: 'mcp__a__generate', description: '', parameters: {} },
    ]
    expect(searchTools(tools, 'generate', 0, 1)[0]?.name).toBe('mcp__a__generate')
  })
  it('falls back to all authorized definitions when discovery has no catalog', async () => {
    const h = await mount()
    try {
      expect(JSON.stringify(await h.discover('comfy'))).toContain('All authorized')
      expect((await h.assemble()).tools.map(t => t.name)).not.toContain('discover_tools')
      expect(h.ctx.sessionProjections.stateOf(h.agent.session, 'tokenEfficiency')?.fallback).toBe(true)
    } finally { await h.ctx.fiber.dispose() }
  })
  it('isolates activation across sessions and restores it on another agent instance', async () => {
    const h = await mount()
    try {
      await h.assemble()
      await h.discover('generate')
      const other = { ...h.agent, id: SessionId('other'), session: Session.create(SessionId('other')) }
      await agentEvents(h.ctx, other).waterfall('agent/pre-step', { turn: 1, step: 1, signal: new AbortController().signal, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
      expect((await h.ctx.systemPrompt.assemble({ agent: other, scope: other })).tools.map(t => t.name)).toEqual(['read', 'discover_tools'])
      const resumed = { ...h.agent }
      expect((await h.ctx.systemPrompt.assemble({ agent: resumed, scope: resumed })).tools.map(t => t.name)).toContain('mcp__comfy__generate')
    } finally { await h.ctx.fiber.dispose() }
  })
  it('honors revoked permissions even after a tool was activated', async () => {
    const h = await mount()
    try {
      await h.assemble()
      await h.discover('generate')
      h.agent.ctx.tools.restrict({ deny: ['mcp__comfy__generate'] })
      expect((await h.assemble()).tools.map(t => t.name)).not.toContain('mcp__comfy__generate')
      expect(JSON.stringify(await h.discover('generate'))).not.toContain('mcp__comfy__generate')
    } finally { await h.ctx.fiber.dispose() }
  })
  it('retains activation after provider/model options change', async () => {
    const h = await mount()
    try {
      await h.assemble()
      await h.discover('generate')
      Object.assign(h.agent.options, { provider: 'different', model: 'different' })
      expect((await h.assemble()).tools.map(t => t.name)).toContain('mcp__comfy__generate')
    } finally { await h.ctx.fiber.dispose() }
  })
  it('lists a bounded server catalog and keeps the rest searchable', async () => {
    const h = await mount()
    try {
      for (let index = 0; index < 21; index += 1) {
        h.ctx.tools.register({ name: `mcp__z${index}__list`, description: 'archive list', parameters: { type: 'object', properties: {} },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] }, execute: async () => 'ok' })
      }
      const discovery = (await h.assemble()).tools.find(tool => tool.name === 'discover_tools')
      expect(discovery?.description).toContain('Available integration servers: comfy, files, z0, z1, z10, z11, z12, z13, z14, z15, z16, z17, and 11 more.')
      expect(discovery?.description).not.toContain('z20')
      expect(JSON.stringify(await h.discover('z20'))).toContain('mcp__z20__list')
    } finally { await h.ctx.fiber.dispose() }
  })
  it('save mode selects matching schemas before the request and keeps that list stable', async () => {
    const h = await mount('save')
    try {
      h.say('Read the fixture report')
      expect((await h.assemble()).tools.map(tool => tool.name)).toEqual(['read'])
      h.say('generate')
      const first = (await h.assemble()).tools
      expect(first.map(tool => tool.name)).toEqual(['mcp__comfy__generate', 'read'])
      expect(first[0]).toEqual(h.ctx.tools.schemas(h.agent).find(tool => tool.name === 'mcp__comfy__generate'))
      expect(first.map(tool => tool.name)).not.toContain('discover_tools')
      h.say('search files')
      expect((await h.assemble()).tools.map(tool => tool.name)).toEqual(['mcp__comfy__generate', 'mcp__files__search', 'read'])
      expect((await h.assemble()).tools.map(tool => tool.name)).toEqual(['mcp__comfy__generate', 'mcp__files__search', 'read'])
      const state = h.ctx.sessionProjections.stateOf(h.agent.session, 'tokenEfficiency')!
      expect(state.discoveryCalls).toBe(0)
      expect(state).toMatchObject({ mode: 'save', version: 2 })
      const resumed = { ...h.agent }
      expect((await h.ctx.systemPrompt.assemble({ agent: resumed, scope: resumed })).tools.map(tool => tool.name))
        .toEqual(['mcp__comfy__generate', 'mcp__files__search', 'read'])
    } finally { await h.ctx.fiber.dispose() }
  })
  it('save mode leaves PTC presentation unfiltered', async () => {
    const h = await mount('save')
    try {
      class Runtime extends PtcRuntime {
        readonly language = 'typescript'
        readonly isolation = 'fixture'
        resolve(request: PtcRunRequest): PtcRunSpec { return { ...request, cwd: '.', timeoutMs: 1000 } }
        async run() { return { logs: [] } }
      }
      await h.ctx.plugin(Runtime)
      h.agent.ctx.tools.presentAs('ptc')
      h.say('generate')
      const names = (await h.assemble()).tools.map(tool => tool.name)
      expect(names).toEqual(['run_code'])
      expect(h.ctx.sessionProjections.stateOf(h.agent.session, 'tokenEfficiency')?.deferred).toBe(0)
    } finally { await h.ctx.fiber.dispose() }
  })
  it('matches server segments and ignores generic wording', () => {
    const tools = [
      { name: 'mcp__comfy__generate', description: 'Read a workflow', parameters: {} },
      { name: 'mcp__files__search', description: 'Read the fixture report', parameters: {} },
      { name: 'mcp__warehouse__inventory', description: 'stock levels', parameters: {} },
    ]
    expect(matchTools(tools, 'ComfyUI', 5).map(tool => tool.name)).toEqual(['mcp__comfy__generate'])
    expect(matchTools(tools, 'Read the fixture report', 5)).toEqual([])
    expect(matchTools(tools, 'inventory levels', 5).map(tool => tool.name)).toEqual(['mcp__warehouse__inventory'])
    expect(matchTools(tools, 'generate search', 1)).toHaveLength(1)
    const catalog = [
      ...tools,
      { name: 'mcp__project__status', description: 'Read project verification status', parameters: {} },
      { name: 'mcp__documents__revision', description: 'Read drawing document revision', parameters: {} },
      { name: 'mcp__archive0__list', description: 'Browse historical archive 0. Returns revision identifiers. This archive is unrelated to current project status.', parameters: {} },
    ]
    expect(matchTools(catalog, 'Summarize the current project identifier, corrected limit, and units.', 5)).toEqual([])
    expect(matchTools(catalog, 'Read project status and document revision.', 5).map(tool => tool.name))
      .toEqual(['mcp__documents__revision', 'mcp__project__status'])
  })
  it('formats empty, exact, and truncated server catalogs', () => {
    expect(serverCatalog([], 12)).toBe('none')
    expect(serverCatalog(['b', 'a', 'a'], 12)).toBe('a, b')
    expect(serverCatalog(['c', 'a', 'b'], 2)).toBe('a, b, and 1 more')
  })
  it('rejects invalid pagination without activating tools', async () => {
    const h = await mount()
    try {
      await h.assemble()
      expect((await h.discover('', -1)).isError).toBe(true)
      expect(h.ctx.sessionProjections.stateOf(h.agent.session, 'tokenEfficiency')?.activated).toEqual([])
    } finally { await h.ctx.fiber.dispose() }
  })
})
