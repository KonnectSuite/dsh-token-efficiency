import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Agents from '@deepseek-ai/dsh-agent'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Llm, { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as efficiency from '../src/index.ts'

class Script extends LlmAdapter {
  requests: GenerateOptions[] = []
  override async * stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const index = this.requests.length
    const block = index === 1 ? { type: 'tool-call' as const, id: ToolCallId('discover'), name: 'discover_tools', arguments: '{"query":"lookup"}' }
      : index === 2 ? { type: 'tool-call' as const, id: ToolCallId('lookup'), name: 'mcp__fixture__lookup', arguments: '{}' }
        : { type: 'text' as const, text: 'Verified fixture value: 42.' }
    yield { type: 'block-start', index: 0, blockType: block.type }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'finish', reason: { kind: index < 3 ? 'tool-calls' : 'stop' } }
  }
}

it('boots YAML through Loader and records discovery followed by authorized execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arya-efficiency-'))
  const ctx = new Context()
  const script = new Script()
  try {
    const config = join(root, 'cordis.yml')
    await writeFile(config, [
      '- name: cordis:projections', '- name: cordis:sessions', '- name: cordis:prompt',
      '- name: cordis:tools', '- name: cordis:llm', '- name: cordis:agents',
      '- name: cordis:loop', '  config:', '    agents: []',
      '- name: cordis:efficiency', '  config:', '    mode: efficient',
      '- name: cordis:fixture', '',
    ].join('\n'))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, projections: Projections, sessions: Sessions,
      prompt: SystemPrompt, tools: Tools, llm: Llm, agents: Agents, loop: AgentLoop, efficiency,
      fixture: Object.assign((scope: Context) => {
        scope.llm.registerAdapter(['fixture'], script)
        scope.tools.register({ name: 'mcp__fixture__lookup', description: 'Read fixture value', parameters: { type: 'object', properties: {} },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] }, execute: async () => '42' })
      }, { inject: ['llm', 'tools'] }),
    })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    const agent = await ctx.agentLoop.create(SessionId('fixture'), { provider: 'fixture', model: 'fixture' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Look up the fixture value.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(script.requests).toHaveLength(3)
    expect(script.requests[0]!.tools?.map(t => t.name)).toEqual(['discover_tools'])
    expect(script.requests[1]!.tools?.map(t => t.name)).toContain('mcp__fixture__lookup')
    const events = agent.session.snapshotEvents()
    expect(events.filter(e => e.type === 'tool/result')).toHaveLength(2)
    expect(events.filter(e => e.type === 'token-efficiency/state').at(-1)?.data).toMatchObject({ activated: ['mcp__fixture__lookup'], discoveryCalls: 1 })
    expect(JSON.stringify(events.filter(e => e.type === 'assistant/message'))).toContain('Verified fixture value: 42.')
    expect(script.requests.map(request => ({ tools: request.tools?.map(tool => tool.name),
      provider: request.provider, model: request.model }))).toMatchInlineSnapshot(`
      [
        {
          "model": "fixture",
          "provider": "fixture",
          "tools": [
            "discover_tools",
          ],
        },
        {
          "model": "fixture",
          "provider": "fixture",
          "tools": [
            "mcp__fixture__lookup",
            "discover_tools",
          ],
        },
        {
          "model": "fixture",
          "provider": "fixture",
          "tools": [
            "mcp__fixture__lookup",
            "discover_tools",
          ],
        },
      ]
    `)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
