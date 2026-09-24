// Proves the turn-continuation policy is real composition and real
// configurability, not a constant: the whole spine plus the plugin are booted
// through the Loader from a cordis.yml, the config comes from that file, and
// the assertions read model requests and the durable session log rather than
// the plugin's internals. The LLM adapter is the only mocked input.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as TurnContinuation from '@deepseek-ai/dsh-turn-continuation'
import { MockAdapter, maxTokensResponse, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Every turn-end reason recorded in the durable log. */
function turnEndReasons(agent: Agent) {
  return agent.session.snapshotEvents().flatMap(event => event.type === 'turn/end' ? [event.data.reason] : [])
}

/** The automatic continuations the session durably admitted, with their source. */
function continuations(agent: Agent): { text: string; source: unknown }[] {
  return agent.session.snapshotEvents()
    .filter((event): event is SessionEvent<'user/message'> =>
      event.type === 'user/message' && event.data.source.kind !== 'user')
    .map(event => ({
      text: event.data.content.map(block => block.type === 'text' ? block.text : '').join(''),
      source: event.data.source,
    }))
}

/**
 * Boot the spine plus the plugin through the Loader from one cordis.yml.
 * @param configLines - YAML lines nested under the plugin's `config:` key.
 * @param adapter - the scripted model adapter, registered as the only mock.
 * @returns the booted context.
 */
async function boot(configLines: readonly string[], adapter: MockAdapter): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-turn-continuation-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    '  config:',
    '    agents: []',
    "- name: '@deepseek-ai/dsh-turn-continuation'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-turn-continuation', TurnContinuation],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

describe('turn-continuation real Loader composition through cordis.yml', () => {
  it('exports a function-plugin namespace and no default export', () => {
    expect('default' in TurnContinuation).toBe(false)
    expect(TurnContinuation.name).toBe('turn-continuation')
    expect(TurnContinuation.inject).toEqual(['agents'])
  })

  it('continues a truncated turn with the default config from the composition', async () => {
    const adapter = new MockAdapter([maxTokensResponse('half an ans'), textResponse('finished')])
    const ctx = await boot([], adapter)
    const agent = await ctx.agentLoop.create(SessionId('loader-default'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(turnEndReasons(agent)).toEqual([{ kind: 'max-tokens' }, { kind: 'completed' }])
    expect(continuations(agent)).toHaveLength(1)
    expect(continuations(agent)[0]?.source).toEqual({ kind: 'turn-continuation' })
  })

  it('honors a maxConsecutive from the cordis.yml, proving the field is not a constant', async () => {
    const adapter = new MockAdapter([
      maxTokensResponse('cut 1'),
      maxTokensResponse('cut 2'),
      maxTokensResponse('cut 3'),
    ])
    const ctx = await boot(['    maxConsecutive: 1'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('loader-budget'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await agent.whenIdle()

    // One initial turn plus exactly one continuation; the default of 2 would
    // have issued a third request.
    expect(adapter.requests).toHaveLength(2)
    expect(continuations(agent)).toHaveLength(1)
  })

  it('honors a continueOn from the cordis.yml that excludes the truncated reason', async () => {
    const adapter = new MockAdapter([maxTokensResponse('cut'), textResponse('never requested')])
    const ctx = await boot(['    continueOn: [error]'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('loader-gate'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(continuations(agent)).toHaveLength(0)
    expect(turnEndReasons(agent)).toEqual([{ kind: 'max-tokens' }])
  })

  it('leaves a turn that completed on its own alone', async () => {
    const adapter = new MockAdapter([textResponse('done')])
    const ctx = await boot([], adapter)
    const agent = await ctx.agentLoop.create(SessionId('loader-untouched'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(continuations(agent)).toHaveLength(0)
    expect(turnEndReasons(agent)).toEqual([{ kind: 'completed' }])
  })
})
