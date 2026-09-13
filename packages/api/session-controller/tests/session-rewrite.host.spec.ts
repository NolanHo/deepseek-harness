/**
 * Host integration for the in-place edit-and-resend prompt path
 * (`SessionPromptRequest.rewriteFrom`): real persistence (the sqlite backend
 * on an in-memory database), the production Agent loop, and the production
 * Session Controller. Every assertion reads the durable post-state through
 * fresh persistence handles — never mock calls.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionRequestId } from '../src/types.ts'
import type { TestSessionRemote } from './test-remote.ts'
import { createSessionTestRemote, installSessionReadTestServices } from './test-remote.ts'

const sid = (id: string): SessionId => id as SessionId

function request<P>(payload: P): P {
  return payload
}

const owned = new Set<Context>()
const cacheRoots: string[] = []
afterEach(async () => {
  await Promise.all([...owned].map(ctx => ctx.fiber.dispose()))
  owned.clear()
  await Promise.all(cacheRoots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })))
})

/** Scripted adapter: one completed text reply, a hang until aborted, or a gated first reply. */
class ScriptedAdapter extends LlmAdapter {
  requests = 0
  private releaseGate: (() => void) | undefined
  private readonly gate: Promise<void> | undefined

  constructor(private readonly reply?: string, gated = false) {
    super()
    if (gated) {
      this.gate = new Promise<void>((resolve) => { this.releaseGate = resolve })
    }
  }

  /** Release a gated first reply so its turn can complete. */
  open(): void {
    this.releaseGate?.()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests += 1
    if (this.gate !== undefined && this.requests === 1) {
      await new Promise<void>((resolve, reject) => {
        if (options.signal?.aborted) { reject(new Error('aborted')); return }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
        void (this.gate as Promise<void>).then(() => { resolve() })
      })
    }
    if (this.reply === undefined) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) { reject(new Error('aborted')); return }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.reply } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: this.reply.length } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Storage options for one directly seeded session. */
interface SeedOptions {
  /** Exact fork-inherited prefix length; seeds the header as a fork child. */
  readonly inheritedEventCount?: SessionLogOffset
  /** Durable origin classification. */
  readonly origin?: 'subagent'
}

interface RewriteHarness {
  readonly ctx: Context
  readonly remote: TestSessionRemote
  readonly adapter: ScriptedAdapter
  seedSession(sessionId: SessionId, events: readonly SessionEvent[], options?: SeedOptions): Promise<void>
  stored(sessionId: SessionId): Promise<{ revision: SessionPersistenceRevision; events: readonly SessionEvent[] }>
}

/**
 * Boot real persistence (sqlite `:memory:`), the production Agent loop, and
 * the production Session Controller over one shared context.
 * @param reply - scripted assistant reply; `undefined` makes the model call hang.
 * @param gated - hold the first model call until {@link ScriptedAdapter.open}.
 */
async function rewriteHarness(reply?: string, gated = false): Promise<RewriteHarness> {
  const ctx = new Context()
  owned.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  // The backend mounts BEFORE the loop so teardown unwinds the loop first:
  // live agents drain their writers into still-open handles.
  await ctx.plugin(SqliteSessionPersistence, { path: ':memory:' })
  // The projection cache is part of the production composition this path must
  // invalidate, so the suite mounts the real service over a throwaway root.
  const cacheRoot = await mkdtemp(join(tmpdir(), 'dsh-rewrite-cache-'))
  cacheRoots.push(cacheRoot)
  await ctx.plugin(Storage)
  await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig },
    { root: cacheRoot })
  await ctx.plugin({
    name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig,
  }, { backend: 'json' })
  await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 1, writeIntervalMs: 60_000 })
  await mountAgentLoopTestHarness(ctx)
  const adapter = new ScriptedAdapter(reply, gated)
  ctx.llm.registerAdapter(['mock'], adapter)
  installSessionReadTestServices(ctx)
  const remote = createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'mock', model: 'mock-model' }),
    cwd: '/tmp',
  })
  return {
    ctx,
    remote,
    adapter,
    seedSession: async (sessionId, events, options = {}) => {
      const seeded = options.inheritedEventCount !== undefined
      const detached = ctx.sessions.prepare(sessionId, {
        meta: {
          cwd: '/proj',
          ...(seeded ? { isSeeded: true } : {}),
          ...(options.origin === undefined ? {} : { origin: options.origin }),
        },
        ...(seeded
          ? { seed: events.slice(0, options.inheritedEventCount), inheritedEventCount: options.inheritedEventCount }
          : {}),
      })
      const handle = await ctx.sessionPersistence.create(
        detached.header,
        ...(seeded ? [{ inheritedEventCount: options.inheritedEventCount }] : []),
      )
      await handle.append(events)
      await handle.close()
    },
    stored: async (sessionId) => {
      const snapshot = await ctx.sessionPersistence.stat(sessionId)
      if (snapshot === undefined) throw new Error(`session "${String(sessionId)}" is not stored`)
      const handle = await ctx.sessionPersistence.open(sessionId, 'read')
      try {
        return { revision: snapshot.revision, events: (await handle.read()).events }
      } finally {
        await handle.close()
      }
    },
  }
}

/** One completed seed turn: turn/start, user/message, turn/end. */
function seedTurn(base: number, turn: number, text: string): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(base), time: base, data: { turn } },
    {
      type: 'user/message',
      seq: SessionSeq(base + 1),
      time: base + 1,
      surfaceOp: 'append',
      data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    },
    {
      type: 'turn/end',
      seq: SessionSeq(base + 2),
      time: base + 2,
      data: { turn, reason: { kind: 'completed' } },
    },
  ] as SessionEvent[]
}

/** The tagged end-seed marker a fork child stores exactly at its inherited cut. */
function inheritedEndSeed(seq: number): SessionEvent {
  return { type: 'session/end-seed', seq: SessionSeq(seq), time: seq, data: { inherited: true } }
}

/** The text of every stored user/message, in log order. */
function storedPromptTexts(events: readonly SessionEvent[]): string[] {
  const texts: string[] = []
  for (const event of events) {
    if (event.type !== 'user/message') continue
    for (const part of event.data.content) {
      if (part.type === 'text') texts.push(part.text)
    }
  }
  return texts
}

/**
 * Every user-prompt text the log carries, in first-seen order and deduplicated:
 * durable `user/message` events plus `agent/inbox/spliced` inserts, which the
 * client renders as the user bubble before the turn commits.
 */
function carriedPromptTexts(events: readonly SessionEvent[]): string[] {
  const texts: string[] = []
  const add = (text: string): void => { if (!texts.includes(text)) texts.push(text) }
  for (const event of events) {
    if (event.type === 'user/message') {
      for (const part of event.data.content) if (part.type === 'text') add(part.text)
    }
    if (event.type === 'agent/inbox/spliced') {
      for (const message of event.data.inserted) {
        for (const part of message.content) if (part.type === 'text') add(part.text)
      }
    }
  }
  return texts
}

const editedPrompt = (text = 'edited prompt'): SessionPromptContent => [{ type: 'text', text }]
type SessionPromptContent = import('../src/types.ts').SessionPromptRequest['content']

describe('sessions.prompt in-place rewrite', () => {
  it('truncates the stored log at the armed turn and continues the session in place', async () => {
    const harness = await rewriteHarness(undefined)
    const sessionId = sid('session-rewrite')
    const seed = [
      ...seedTurn(0, 1, 'first prompt'),
      ...seedTurn(3, 2, 'second prompt'),
      ...seedTurn(6, 3, 'third prompt'),
    ]
    await harness.seedSession(sessionId, seed)
    // The projection cache's row watermarks assume an ever-growing log, so the
    // rewrite must discard the record of the session it truncated. The spy
    // wraps the real service, so its behavior stays in force.
    const discard = vi.spyOn(harness.ctx.sessionProjectionCache, 'discard')
    const before = await harness.stored(sessionId)
    expect(before.events).toHaveLength(9)
    // The armed anchor is the second turn's user message (seq 4); the cut is
    // its turn/start (seq 3).
    const requestId = 'rewrite-req-1' as SessionRequestId
    const response = await harness.remote.prompt({
      sessionId,
      mode: 'queue',
      rewriteFrom: 4,
      content: editedPrompt(),
      requestId,
    })
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(`rewrite prompt failed: ${JSON.stringify(response.error)}`)
    expect(response.value).toEqual({ accepted: true, rewrote: true })
    // The disposed agent is replaced by a freshly resumed live one.
    const agent = harness.ctx.agents.get(sessionId)
    expect(agent).toBeDefined()
    expect(agent?.status).toBe('running')
    // The model call hangs: once the adapter is reached, the admitted message
    // is durable in the session; flush forces it through the write handle.
    await vi.waitFor(() => { expect(harness.adapter.requests).toBe(1) })
    await harness.ctx.sessionPersistence.flush()
    const after = await harness.stored(sessionId)
    const cut = 3
    // The stored prefix below the cut is bit-identical to the seed.
    expect(after.events.slice(0, cut)).toEqual(before.events.slice(0, cut))
    // The resume marker sits exactly at the cut: truncation left the stored
    // next-seq at the cut, so the first append after the rewrite landed there.
    expect(after.events[cut]?.type).toBe('session/end-seed')
    // Every stored event from the armed turn onward is new: the old second and
    // third turns are gone from storage.
    expect(storedPromptTexts(after.events)).toEqual(['first prompt', 'edited prompt'])
    expect(after.events.some(event => event.type === 'turn/start' && event.data.turn === 3)).toBe(false)
    expect(after.events.some(event => event.type === 'turn/end' && event.data.turn === 3)).toBe(false)
    // The admitted message carries the edited content and the request id.
    const admitted = after.events.filter(event => event.type === 'user/message').at(-1)
    expect(admitted?.seq).toBeGreaterThan(cut)
    if (admitted?.type !== 'user/message') throw new Error('the admitted event is not a user message')
    expect(admitted.data.content).toEqual([{ type: 'text', text: 'edited prompt' }])
    expect(admitted.data.source).toMatchObject({ kind: 'user', rpcId: requestId })
    // The truncation bumped the durable revision.
    expect(after.revision).not.toBe(before.revision)
    // The rewritten session's cached projection rows were invalidated with it.
    expect(discard).toHaveBeenCalledWith(sessionId)
  })


  it('discards the replaced message admission splice along with its turn', async () => {
    const harness = await rewriteHarness('second reply')
    const sessionId = sid('session-rewrite-splice')
    await harness.seedSession(sessionId, seedTurn(0, 1, 'first prompt'))
    // A real prompt produces the admission bookkeeping this path must drop:
    // the inbox splice carries the message content the client renders as the
    // user bubble, while its removal lands inside the turn being discarded.
    const admitted = await harness.remote.prompt({
      sessionId,
      mode: 'queue',
      content: editedPrompt('second prompt'),
      requestId: 'splice-admit-1' as SessionRequestId,
    })
    expect(admitted.ok).toBe(true)
    const firstAgent = harness.ctx.agents.get(sessionId)
    if (firstAgent === undefined) throw new Error('prompt did not resume the agent')
    await firstAgent.whenIdle()
    await harness.ctx.sessionPersistence.flush()
    const before = await harness.stored(sessionId)
    expect(carriedPromptTexts(before.events)).toEqual(['first prompt', 'second prompt'])
    const armed = before.events.findLast(event => event.type === 'user/message')
    if (armed === undefined) throw new Error('no admitted user message found')

    const discard = vi.spyOn(harness.ctx.sessionProjectionCache, 'discard')
    const response = await harness.remote.prompt({
      sessionId,
      mode: 'queue',
      rewriteFrom: armed.seq,
      content: editedPrompt('edited prompt'),
      requestId: 'splice-rewrite-1' as SessionRequestId,
    })
    expect(response).toMatchObject({ ok: true, value: { accepted: true, rewrote: true } })
    await harness.ctx.agents.get(sessionId)?.whenIdle()
    await harness.ctx.sessionPersistence.flush()
    const after = await harness.stored(sessionId)
    // Neither the durable message nor any admission splice still carries the
    // replaced text.
    expect(carriedPromptTexts(after.events)).toEqual(['first prompt', 'edited prompt'])
    expect(discard).toHaveBeenCalledWith(sessionId)
  })


  it('neutralizes a message queued while an earlier turn was still running', async () => {
    const harness = await rewriteHarness('first reply', true)
    const sessionId = sid('session-rewrite-queued-running')
    await harness.seedSession(sessionId, seedTurn(0, 1, 'seeded turn'))
    // A gated turn runs and blocks inside its model call.
    const running = await harness.remote.prompt({
      sessionId,
      mode: 'queue',
      content: editedPrompt('running prompt'),
      requestId: 'queued-run-1' as SessionRequestId,
    })
    expect(running.ok).toBe(true)
    await vi.waitFor(() => { expect(harness.adapter.requests).toBe(1) })
    // A second prompt admitted while that turn is still running: its admission
    // insert lands inside the running turn, before that turn's `turn/end`.
    const queued = await harness.remote.prompt({
      sessionId,
      mode: 'queue',
      content: editedPrompt('queued while running'),
      requestId: 'queued-run-2' as SessionRequestId,
    })
    expect(queued.ok).toBe(true)
    harness.adapter.open()
    await harness.ctx.agents.get(sessionId)?.whenIdle()
    await harness.ctx.sessionPersistence.flush()
    const before = await harness.stored(sessionId)
    expect(carriedPromptTexts(before.events))
      .toEqual(['seeded turn', 'running prompt', 'queued while running'])
    const armed = before.events.findLast(event => event.type === 'user/message')
    if (armed?.type !== 'user/message') throw new Error('no admitted user message')
    const insert = before.events.find(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.id === armed.data.id))
    const armedTurnStart = before.events.findLast(event => event.type === 'turn/start' && event.seq < armed.seq)
    const previousEnd = before.events.findLast(event => event.type === 'turn/end' && event.seq < (armedTurnStart?.seq ?? -1))
    if (insert?.type !== 'agent/inbox/spliced' || armedTurnStart === undefined || previousEnd === undefined) {
      throw new Error('the queued message did not produce the layout under test')
    }
    // The insert sits inside the PREVIOUS turn, so the backward walk from the
    // armed turn cannot reach it: only the appended removal can empty it.
    expect(insert.seq).toBeLessThan(previousEnd.seq)
    expect(insert.seq).toBeLessThan(armedTurnStart.seq)

    const discard = vi.spyOn(harness.ctx.sessionProjectionCache, 'discard')
    const response = await harness.remote.prompt({
      sessionId,
      mode: 'queue',
      rewriteFrom: armed.seq,
      content: editedPrompt('edited after queue'),
      requestId: 'queued-run-3' as SessionRequestId,
    })
    expect(response).toMatchObject({ ok: true, value: { accepted: true, rewrote: true } })
    await harness.ctx.agents.get(sessionId)?.whenIdle()
    await harness.ctx.sessionPersistence.flush()
    const after = await harness.stored(sessionId)
    // The retained admission insert keeps its text (a middle event cannot be
    // removed by truncation), but it is balanced by the appended removal: no
    // `user/message` carries the replaced text again, and the resumed agent
    // replayed no phantom turn for it.
    expect(storedPromptTexts(after.events)).toEqual(['seeded turn', 'running prompt', 'edited after queue'])
    // The balancing removal lands exactly at the cut.
    expect(after.events.find(event => event.seq === armedTurnStart.seq)).toMatchObject({
      type: 'agent/inbox/spliced',
      data: { removedCount: 1, inserted: [] },
    })
    expect(discard).toHaveBeenCalledWith(sessionId)
  })

  it('never truncates twice for one replayed requestId', async () => {
    const harness = await rewriteHarness('edited reply')
    const sessionId = sid('session-rewrite-idempotent')
    await harness.seedSession(sessionId, [
      ...seedTurn(0, 1, 'first prompt'),
      ...seedTurn(3, 2, 'second prompt'),
    ])
    const requestId = 'rewrite-req-replay' as SessionRequestId
    const call = {
      sessionId,
      mode: 'queue' as const,
      rewriteFrom: 4,
      content: editedPrompt(),
      requestId,
    }
    const first = await harness.remote.prompt(call)
    expect(first).toMatchObject({ ok: true, value: { accepted: true, rewrote: true } })
    const agent = harness.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('rewrite did not resume the agent')
    await agent.whenIdle()
    await harness.ctx.sessionPersistence.flush()
    const once = await harness.stored(sessionId)
    expect(storedPromptTexts(once.events)).toEqual(['first prompt', 'edited prompt'])

    const replay = await harness.remote.prompt(call)
    expect(replay).toEqual({ ok: true, value: { accepted: true } })
    await harness.ctx.sessionPersistence.flush()
    const twice = await harness.stored(sessionId)
    expect(twice.revision).toBe(once.revision)
    expect(twice.events).toEqual(once.events)
    // The retried request never reached the loop again.
    expect(harness.adapter.requests).toBe(1)
  })

  it('refuses steer mode and non-safe rewrite anchors before touching the stored log', async () => {
    const harness = await rewriteHarness('unused')
    const sessionId = sid('session-rewrite-steer')
    await harness.seedSession(sessionId, [
      ...seedTurn(0, 1, 'first prompt'),
      ...seedTurn(3, 2, 'second prompt'),
    ])
    const observe = vi.spyOn(harness.ctx.sessionQuery, 'observeSession')
    const before = await harness.stored(sessionId)

    for (const [mode, rewriteFrom] of [
      ['steer', 4],
      ['queue', -1],
      ['queue', 0.5],
    ] as const) {
      const response = await harness.remote.prompt({
        sessionId,
        mode,
        rewriteFrom,
        content: editedPrompt(),
        requestId: `steer-refusal-${mode}-${String(rewriteFrom)}` as SessionRequestId,
      })
      expect(response.ok).toBe(false)
      if (!response.ok) {
        expect(response.error).toMatchObject({ code: 'gateway/bad-request', details: {} })
      }
    }
    expect(observe).not.toHaveBeenCalled()
    const after = await harness.stored(sessionId)
    expect(after).toEqual(before)
    expect(harness.ctx.agents.get(sessionId)).toBeUndefined()
  })

  it.each([
    [2, 'a turn boundary'],
    [0, 'a turn start'],
    [999, 'a missing event'],
  ])('refuses a rewrite anchor at seq %s (%s) without modifying the stored log', async (rewriteFrom) => {
    const harness = await rewriteHarness('unused')
    const sessionId = sid('session-rewrite-invalid-from')
    await harness.seedSession(sessionId, [
      ...seedTurn(0, 1, 'first prompt'),
      ...seedTurn(3, 2, 'second prompt'),
    ])
    const before = await harness.stored(sessionId)

    const response = await harness.remote.prompt({
      sessionId,
      mode: 'queue',
      rewriteFrom,
      content: editedPrompt(),
      requestId: `invalid-from-${String(rewriteFrom)}` as SessionRequestId,
    })
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error).toMatchObject({
        code: 'session/rewrite-unavailable',
        details: { reason: 'REWRITE_INVALID_FROM', sessionId },
      })
    }
    const after = await harness.stored(sessionId)
    expect(after).toEqual(before)
    expect(harness.ctx.agents.get(sessionId)).toBeUndefined()
  })

  it('refuses a subagent-owned session without modifying its stored log', async () => {
    const harness = await rewriteHarness('unused')
    const sessionId = sid('session-rewrite-subagent')
    await harness.seedSession(sessionId, [
      ...seedTurn(0, 1, 'first prompt'),
      ...seedTurn(3, 2, 'second prompt'),
    ], { origin: 'subagent' })
    const before = await harness.stored(sessionId)

    const response = await harness.remote.prompt({
      sessionId,
      mode: 'queue',
      rewriteFrom: 1,
      content: editedPrompt(),
      requestId: 'subagent-rewrite-1' as SessionRequestId,
    })
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error).toMatchObject({
        code: 'session/agent-busy',
        details: { reason: 'use subagent delivery for this child session' },
      })
    }
    const after = await harness.stored(sessionId)
    expect(after).toEqual(before)
    expect(harness.ctx.agents.get(sessionId)).toBeUndefined()
  })

  it('refuses to cut into the fork-inherited prefix', async () => {
    const harness = await rewriteHarness('unused')
    const sessionId = sid('session-rewrite-seeded')
    const inherited = SessionLogOffset(3)
    const events = [
      ...seedTurn(0, 1, 'first prompt'),
      inheritedEndSeed(3),
      ...seedTurn(4, 2, 'second prompt'),
    ]
    await harness.seedSession(sessionId, events, { inheritedEventCount: inherited })
    const before = await harness.stored(sessionId)

    // The armed message (seq 1) sits inside the fork-inherited prefix: its
    // turn starts at seq 0, below the inherited cut.
    const response = await harness.remote.prompt({
      sessionId,
      mode: 'queue',
      rewriteFrom: 1,
      content: editedPrompt(),
      requestId: 'inherited-prefix-1' as SessionRequestId,
    })
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error).toMatchObject({
        code: 'session/rewrite-unavailable',
        details: { reason: 'REWRITE_INHERITED_PREFIX', sessionId },
      })
    }
    const after = await harness.stored(sessionId)
    expect(after).toEqual(before)
    expect(harness.ctx.agents.get(sessionId)).toBeUndefined()
  })

  it('refuses while the live agent is running a turn', async () => {
    const harness = await rewriteHarness(undefined)
    const sessionId = sid('session-rewrite-running')
    await harness.seedSession(sessionId, [
      ...seedTurn(0, 1, 'first prompt'),
      ...seedTurn(3, 2, 'second prompt'),
    ])
    // A normal prompt starts a turn whose model call hangs.
    const running = await harness.remote.prompt({
      sessionId,
      mode: 'queue',
      content: editedPrompt('running prompt'),
      requestId: 'running-turn-1' as SessionRequestId,
    })
    expect(running.ok).toBe(true)
    await vi.waitFor(() => { expect(harness.adapter.requests).toBe(1) })
    await harness.ctx.sessionPersistence.flush()
    const before = await harness.stored(sessionId)

    const refused = await harness.remote.prompt({
      sessionId,
      mode: 'queue',
      rewriteFrom: 1,
      content: editedPrompt('edited while running'),
      requestId: 'running-turn-rewrite' as SessionRequestId,
    })
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.error).toMatchObject({
        code: 'session/rewrite-unavailable',
        details: { reason: 'REWRITE_TURN_RUNNING', sessionId },
      })
    }
    const after = await harness.stored(sessionId)
    expect(after.revision).toBe(before.revision)
    expect(after.events).toEqual(before.events)
    expect(harness.ctx.agents.get(sessionId)?.status).toBe('running')
  })

  it('refuses while queued inbox work is pending', async () => {
    const harness = await rewriteHarness('unused')
    const sessionId = sid('session-rewrite-pending')
    await harness.seedSession(sessionId, [
      ...seedTurn(0, 1, 'first prompt'),
      ...seedTurn(3, 2, 'second prompt'),
    ])
    // Adopt the persisted identity into a live idle agent without prompting.
    const created = await harness.remote.create(request({ sessionId, cwd: '/proj' }))
    expect(created.ok).toBe(true)
    const agent = harness.ctx.agents.get(sessionId)
    expect(agent?.status).toBe('idle')
    // A direct inbox append is durable pending work that never wakes a driver.
    agent?.inbox.append('next-turn', createUserMessage({
      content: [{ type: 'text', text: 'queued work' }],
      source: { kind: 'user' },
    }))
    await harness.ctx.sessionPersistence.flush()
    const before = await harness.stored(sessionId)

    const refused = await harness.remote.prompt({
      sessionId,
      mode: 'queue',
      rewriteFrom: 1,
      content: editedPrompt(),
      requestId: 'pending-rewrite-1' as SessionRequestId,
    })
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.error).toMatchObject({
        code: 'session/rewrite-unavailable',
        details: { reason: 'REWRITE_INBOX_PENDING', sessionId },
      })
    }
    const after = await harness.stored(sessionId)
    expect(after).toEqual(before)
    expect(harness.ctx.agents.get(sessionId)).toBe(agent)
  })

  it('rebuilds the live Agent without announcing a Session removal', async () => {
    const harness = await rewriteHarness('reply text')
    const sessionId = sid('session-rewrite-quiet')
    await harness.seedSession(sessionId, seedTurn(0, 1, 'first prompt'))
    const removals: SessionId[] = []
    harness.ctx.on('api-session/removed', (removed) => { removals.push(removed) })
    // The rewrite tears down a LIVE Agent, so one complete turn must run first;
    // its teardown is the announcement the clients must never see.
    const adopted = await harness.remote.prompt({
      sessionId,
      mode: 'queue',
      content: editedPrompt('second prompt'),
      requestId: 'quiet-admit-1' as SessionRequestId,
    })
    expect(adopted.ok).toBe(true)
    const firstAgent = harness.ctx.agents.get(sessionId)
    if (firstAgent === undefined) throw new Error('prompt did not resume the agent')
    await firstAgent.whenIdle()
    await harness.ctx.sessionPersistence.flush()
    const armed = (await harness.stored(sessionId)).events.filter(event => event.type === 'user/message').at(-1)
    if (armed?.type !== 'user/message') throw new Error('the seeded turn left no user message to arm')
    expect(removals).toEqual([])

    const response = await harness.remote.prompt({
      sessionId,
      mode: 'queue',
      rewriteFrom: Number(armed.seq),
      content: editedPrompt('edited prompt'),
      requestId: 'quiet-admit-2' as SessionRequestId,
    })

    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(`rewrite prompt failed: ${JSON.stringify(response.error)}`)
    expect(response.value).toEqual({ accepted: true, rewrote: true })
    // A client that never saw a removal keeps the row, the selection, and the
    // conversation: the rebuilt Agent is live under the same Session id.
    expect(removals).toEqual([])
    expect(harness.ctx.agents.get(sessionId)).toBeDefined()
  })
})
