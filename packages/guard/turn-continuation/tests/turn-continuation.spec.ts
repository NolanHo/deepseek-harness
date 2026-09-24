/**
 * Turn-end continuation behaviour: the reason gate, the per-human-turn budget,
 * the refill rule, fail-loud config validation, and disposal — all driven
 * through a real agent loop against a scripted mock adapter (no network).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as TurnContinuation from '@deepseek-ai/dsh-turn-continuation'
import type { Config } from '@deepseek-ai/dsh-turn-continuation'
import { MockAdapter, maxTokensResponse, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/** Boot the core spine + the policy, bound to the scripted adapter. */
async function harness(adapter: MockAdapter, config: Config = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const fiber = await ctx.plugin(TurnContinuation, config)
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, fiber }
}

/**
 * Settle the whole automatic chain, not just the first idle edge: a
 * continuation enqueued at the boundary opens the next activity, and
 * `whenIdle()` follows the replacement activity rather than the first one.
 */
function waitForIdle(agent: Agent): Promise<void> {
  return agent.whenIdle()
}

function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/** Turn-end reasons recorded in the durable log. */
function turnEndReasons(agent: Agent) {
  return agent.session.snapshotEvents().flatMap(event => event.type === 'turn/end' ? [event.data.reason] : [])
}

/** Every non-human user message in the log, with its source. */
function queued(agent: Agent): { text: string; source: unknown }[] {
  return agent.session.snapshotEvents()
    .filter((event): event is SessionEvent<'user/message'> =>
      event.type === 'user/message' && event.data.source.kind !== 'user')
    .map(event => ({
      text: event.data.content.map(block => block.type === 'text' ? block.text : '').join(''),
      source: event.data.source,
    }))
}

describe('reason gate', () => {
  it('opens one more turn after a truncation and records the new turn normally', async () => {
    const adapter = new MockAdapter([maxTokensResponse('half an ans'), textResponse('finished')])
    const { ctx } = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('continues'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(agent)

    expect(adapter.requests).toHaveLength(2)
    // The truncated turn keeps its truncation fact; the continuation is its own
    // ordinary turn and completes.
    expect(turnEndReasons(agent)).toEqual([{ kind: 'max-tokens' }, { kind: 'completed' }])
    const continuations = queued(agent)
    expect(continuations).toHaveLength(1)
    expect(continuations[0]?.source).toEqual({ kind: 'turn-continuation' })
    expect(continuations[0]?.text).toContain('cut off')
  })

  it('leaves a turn that completed on its own alone', async () => {
    const adapter = new MockAdapter([textResponse('done')])
    const { ctx } = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('untouched'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(agent)

    expect(adapter.requests).toHaveLength(1)
    expect(queued(agent)).toHaveLength(0)
    expect(turnEndReasons(agent)).toEqual([{ kind: 'completed' }])
  })

  it('continues a failed turn only when error is configured', async () => {
    const failing = new MockAdapter([
      () => { throw new Error('provider broke') },
      textResponse('recovered'),
    ])
    const { ctx } = await harness(failing, { continueOn: ['error'] })
    const agent = await ctx.agentLoop.create(SessionId('error-continues'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(agent)

    expect(failing.requests).toHaveLength(2)
    expect(turnEndReasons(agent)).toEqual([{ kind: 'error', error: { message: 'provider broke', code: 'UNKNOWN' } }, { kind: 'completed' }])
    expect(queued(agent)[0]?.text).toContain('failed')
  })

  it('does not continue a failed turn under the default config', async () => {
    const failing = new MockAdapter([() => { throw new Error('provider broke') }, textResponse('never requested')])
    const { ctx } = await harness(failing)
    const agent = await ctx.agentLoop.create(SessionId('error-stops'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(agent)

    expect(failing.requests).toHaveLength(1)
    expect(queued(agent)).toHaveLength(0)
  })
})

describe('budget', () => {
  it('bounds consecutive continuations per human turn', async () => {
    const adapter = new MockAdapter([
      maxTokensResponse('cut 1'),
      maxTokensResponse('cut 2'),
      maxTokensResponse('cut 3'),
      maxTokensResponse('cut 4'),
    ])
    const { ctx } = await harness(adapter, { maxConsecutive: 2 })
    const agent = await ctx.agentLoop.create(SessionId('capped'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(agent)

    // One initial turn plus exactly two automatic continuations.
    expect(adapter.requests).toHaveLength(3)
    expect(queued(agent)).toHaveLength(2)
  })

  it('refills the budget only on human input', async () => {
    const adapter = new MockAdapter([
      maxTokensResponse('cut 1'),
      textResponse('first recovery'),
      maxTokensResponse('cut 2'),
      textResponse('second recovery'),
    ])
    const { ctx } = await harness(adapter, { maxConsecutive: 1 })
    const agent = await ctx.agentLoop.create(SessionId('refill'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(agent)
    // Budget spent: turn 1 truncated, one continuation ran and completed.
    expect(adapter.requests).toHaveLength(2)
    expect(queued(agent)).toHaveLength(1)

    // A second human turn spends the refilled budget exactly once more.
    send(agent, 'go again')
    await waitForIdle(agent)
    expect(adapter.requests).toHaveLength(4)
    expect(queued(agent)).toHaveLength(2)
  })

  it('never spends a budget it just spent on its own continuation', async () => {
    // A continuation whose own turn is truncated again must consume budget
    // rather than refill it: the queued source is the plugin, not a human.
    const adapter = new MockAdapter([maxTokensResponse('cut 1'), maxTokensResponse('cut 2'), maxTokensResponse('cut 3')])
    const { ctx } = await harness(adapter, { maxConsecutive: 1 })
    const agent = await ctx.agentLoop.create(SessionId('no-self-refill'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(agent)

    expect(adapter.requests).toHaveLength(2)
    expect(queued(agent)).toHaveLength(1)
  })
})

describe('config validation fails loud', () => {
  it.each([
    ['a non-continuable reason', { continueOn: ['completed'] }, /not a continuable turn-end reason/],
    ['a cancellation reason', { continueOn: ['aborted'] }, /not a continuable turn-end reason/],
    ['an unknown reason', { continueOn: ['nonsense'] }, /not a continuable turn-end reason/],
    ['a fractional budget', { maxConsecutive: 1.5 }, /non-negative whole number/],
    ['a negative budget', { maxConsecutive: -1 }, /non-negative whole number/],
  ] as const)('rejects %s at load', async (_label, config, message) => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await expect(ctx.plugin(TurnContinuation, config as Config)).rejects.toThrow(message)
  })

  it('accepts a zero budget as a disabled policy', async () => {
    const adapter = new MockAdapter([maxTokensResponse('cut'), textResponse('never requested')])
    const { ctx } = await harness(adapter, { maxConsecutive: 0 })
    const agent = await ctx.agentLoop.create(SessionId('disabled'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(agent)

    expect(adapter.requests).toHaveLength(1)
    expect(queued(agent)).toHaveLength(0)
    // The truncation is still recorded; only the continuation is disabled.
    expect(turnEndReasons(agent)).toEqual([{ kind: 'max-tokens' }])
  })
})

describe('schema defaults', () => {
  it('applies the documented defaults when the config omits both fields', async () => {
    // The schema fills both defaults for a Loader-supplied config, so the
    // resolve step's own fallbacks are only exercised by a direct apply call.
    const adapter = new MockAdapter([maxTokensResponse('cut'), textResponse('finished')])
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    TurnContinuation.apply(ctx, {})
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('defaults'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(agent)

    // max-tokens continues (continueOn default) and the cap is 2 (maxConsecutive default).
    expect(adapter.requests).toHaveLength(2)
    expect(turnEndReasons(agent)).toEqual([{ kind: 'max-tokens' }, { kind: 'completed' }])
  })
})

describe('lifecycle', () => {
  it('stops continuing once its fiber is disposed', async () => {
    const adapter = new MockAdapter([maxTokensResponse('cut'), textResponse('never requested')])
    const { ctx, fiber } = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('disposed'), { provider: 'mock', model: 'mock' })

    await fiber.dispose()
    send(agent, 'go')
    await waitForIdle(agent)

    expect(adapter.requests).toHaveLength(1)
    expect(queued(agent)).toHaveLength(0)
  })
})
