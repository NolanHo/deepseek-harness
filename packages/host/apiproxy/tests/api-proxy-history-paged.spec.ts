/**
 * Paged cold-history reads: the detached history path serves suffix windows
 * through persistence `readFrom` (seek-capable backends skip the full log),
 * falls back to full inspection for repair-ambiguous tails, and widens the
 * window until the page cut is provably complete. Page cuts land on user
 * messages: one page = whole turns, never sliced mid-turn or mid-message.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { decodeStorageRecord } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

const sid = (id: string): SessionId => id as SessionId

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`paged-${String(nextRpc++)}`), payload }
}

function header(id: string): SessionHeader {
  return { version: 0, id: sid(id), createdAt: 1000, cwd: '/proj' }
}

/** One closed turn: user message (seq base) + two chunk events + assistant message + turn/end. */
function closedTurn(base: number, turn: number, userSeq: number): SessionEvent[] {
  return [
    { type: 'turn/start', seq: base, time: base, data: { turn, trigger: { kind: 'message', source: { kind: 'user' } } } } as SessionEvent,
    {
      type: 'user/message', seq: userSeq, time: userSeq,
      data: createUserMessage({ content: [{ type: 'text', text: `q${turn}` }], source: { kind: 'user' } }),
      surfaceOp: 'append',
    },
    {
      type: 'assistant/chunk', seq: userSeq + 1, time: userSeq + 1,
      data: { turn, step: 1, chunk: { type: 'text-delta', index: 0, text: `a${turn}-1` } },
    },
    {
      type: 'assistant/chunk', seq: userSeq + 2, time: userSeq + 2,
      data: { turn, step: 1, chunk: { type: 'text-delta', index: 1, text: `a${turn}-2` } },
    },
    {
      type: 'assistant/message', seq: userSeq + 3, time: userSeq + 3,
      data: {
        turn, step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: `a${turn} full` }],
          source: { provider: 'p', model: 'm' },
        }),
      },
      surfaceOp: 'append', sourceEventSeqs: [userSeq + 1, userSeq + 2, userSeq + 3],
    },
    { type: 'turn/end', seq: userSeq + 4, time: userSeq + 4, data: { turn, reason: { kind: 'completed' } } },
  ]
}

/** Three clean closed turns, contiguous seqs from 0. */
function threeTurns(): SessionEvent[] {
  const t1 = closedTurn(0, 1, 1)
  const t2 = closedTurn(6, 2, 7)
  const t3 = closedTurn(12, 3, 13)
  return [...t1, ...t2, ...t3]
}

/** A stub projection cache: fixed watermark and a spyable coldSnapshot. */
function stubCache(watermark: number) {
  return {
    cachedSnapshot: vi.fn(() => ({ asOfSeq: watermark, values: {} })),
    coldSnapshot: vi.fn(() => Promise.resolve({ asOfSeq: watermark, values: {} })),
  }
}

interface PagedHarness {
  ctx: Context
  api: ReturnType<typeof createApiProxy>
  readFrom: ReturnType<typeof vi.fn>
  inspect: ReturnType<typeof vi.fn>
}

async function harness(options: {
  events: SessionEvent[]
  readFrom?: (id: string, fromSeq: number) => Promise<{ meta: SessionHeader; events: SessionEvent[] } | undefined>
  cache?: ReturnType<typeof stubCache>
  inspectThrows?: boolean
}): Promise<PagedHarness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  const meta = header('s')
  const inspect = vi.fn(() => Promise.resolve({ meta, events: options.events }))
  const readFrom = vi.fn(options.readFrom ?? ((_id: string, fromSeq: number) => Promise.resolve({
    meta,
    events: options.events.filter(event => event.seq >= fromSeq),
  })))
  ctx.provide('sessionPersistence', {
    list: () => Promise.resolve([meta]),
    inspect,
    readFrom,
    locate: () => undefined,
  } as never)
  if (options.cache !== undefined) ctx.provide('sessionProjectionCache', options.cache as never)
  const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
  return { ctx, api, readFrom, inspect }
}

describe('paged cold history', () => {
  it('serves the tail page through readFrom, never through inspection', async () => {
    // The watermark anchor (17) minus the 2-message estimate clamps to 0:
    // small logs read their whole suffix in one call — but the paged path
    // still skips the inspection (no session replay, no closers synthesis).
    const h = await harness({ events: threeTurns(), cache: stubCache(17) })
    const response = await h.api.sessions.history(request({ sessionId: sid('s'), maxMessages: 2 }))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) return
    // Two user messages = turns 2 and 3; the cut lands AT turn 2's user
    // message (turn 1's boundary stays on the earlier page).
    expect(wireTypes(response.result.value.events)).toEqual([
      'user/message', 'assistant/chunk', 'assistant/chunk', 'assistant/message', 'turn/end',
      'turn/start', 'user/message', 'assistant/chunk', 'assistant/chunk', 'assistant/message', 'turn/end',
    ])
    expect(response.result.value.hasMore).toBe(true)
    expect(h.readFrom).toHaveBeenCalledTimes(1)
    expect(h.readFrom.mock.calls[0]?.[1]).toBe(0)
    expect(h.inspect).not.toHaveBeenCalled()
  })

  it('cuts at the user message even when beforeSeq sits inside a turn', async () => {
    const h = await harness({ events: threeTurns() })
    // beforeSeq inside turn 2's assistant content (seq 10 = its assistant/message).
    const response = await h.api.sessions.history(request({ sessionId: sid('s'), beforeSeq: 10, maxMessages: 1 }))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) return
    const types = wireTypes(response.result.value.events)
    // The page starts at turn 2's user message and ends at beforeSeq: the
    // older page supplies the head the client's current page is missing.
    expect(types).toEqual(['user/message', 'assistant/chunk', 'assistant/chunk'])
    expect(response.result.value.hasMore).toBe(true)
  })

  it('widens the window when the first suffix cannot hold a complete page', async () => {
    // 100 turns (600 events): the cache watermark anchors the first window
    // well above seq 0, so the widening loop has room to converge.
    const events: SessionEvent[] = []
    for (let turn = 1; turn <= 100; turn++) {
      const base = (turn - 1) * 6
      events.push(...closedTurn(base, turn, base + 1))
    }
    const meta = header('s')
    let calls = 0
    const readFrom = vi.fn((_id: string, fromSeq: number) => {
      calls += 1
      // First read simulates a too-short suffix (fewer than maxMessages user
      // messages inside); later reads serve the requested suffix faithfully.
      const start = calls === 1 ? 598 : fromSeq
      return Promise.resolve({ meta, events: events.filter(event => event.seq >= start) })
    })
    // Watermark far above the estimate headroom: fromSeq = 9000 - 2*4096
    // stays above seq 0, so the loop has room to re-estimate by density
    // (three reads: too-short, one-message, then the complete page).
    const cache = stubCache(9000)
    const h = await harness({ events, readFrom, cache })
    const response = await h.api.sessions.history(request({ sessionId: sid('s'), maxMessages: 2 }))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) return
    const page = wireEvents(response.result.value.events).map(event => event.seq)
    // The final page holds the last two whole turns, ending at the log tail.
    expect(page).toEqual([589, 590, 591, 592, 593, 594, 595, 596, 597, 598, 599])
    expect(response.result.value.hasMore).toBe(true)
    expect(calls).toBe(3)
    expect(readFrom.mock.calls[0]?.[1]).toBeGreaterThan(0)
    // Monotone descent, no halving jump: 808 -> density-estimated -> complete.
    expect(readFrom.mock.calls[1]?.[1]).toBeLessThan(readFrom.mock.calls[0]?.[1] as number)
    expect(readFrom.mock.calls[2]?.[1]).toBeLessThan(readFrom.mock.calls[1]?.[1] as number)
    expect(h.inspect).not.toHaveBeenCalled()
  })

  it('serves a small clean log exactly from a single read at fromSeq 0', async () => {
    const events = closedTurn(0, 1, 1)
    const h = await harness({ events })
    const response = await h.api.sessions.history(request({ sessionId: sid('s'), maxMessages: 10 }))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) return
    expect(wireEvents(response.result.value.events).map(event => event.seq)).toEqual(events.map(event => event.seq))
    expect(response.result.value.hasMore).toBe(false)
  })

  it('falls back to full inspection for an unclosed tail', async () => {
    const events = [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
    ] as SessionEvent[]
    const h = await harness({ events })
    const response = await h.api.sessions.history(request({ sessionId: sid('s'), maxMessages: 10 }))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) return
    // The page is the inspection's output (whose closers synthesis the real
    // coordinator owns — exercised by api-proxy-cold's repair test).
    expect(wireTypes(response.result.value.events)).toEqual(['turn/start'])
    expect(h.inspect).toHaveBeenCalledOnce()
  })

  it('maps an unknown session to session-not-found without any paged read', async () => {
    const h = await harness({
      events: [],
      readFrom: () => Promise.resolve(undefined),
    })
    const response = await h.api.sessions.history(request({ sessionId: sid('ghost') }))
    expect(response.result.ok).toBe(false)
    if (response.result.ok) return
    expect(response.result.error.code).toBe('session-not-found')
    expect(h.readFrom).not.toHaveBeenCalled()
  })

  it('carries the cold projection baseline on the tail page and skips it on loadOlder', async () => {
    const cache = stubCache(17)
    const h = await harness({ events: threeTurns(), cache })
    const tail = await h.api.sessions.history(request({ sessionId: sid('s'), maxMessages: 1 }))
    expect(tail.result.ok).toBe(true)
    if (!tail.result.ok) return
    expect(tail.result.value.projections).toEqual({ asOfSeq: 17, values: {} })
    expect(cache.coldSnapshot).toHaveBeenCalledOnce()
    const older = await h.api.sessions.history(request({ sessionId: sid('s'), beforeSeq: 7, maxMessages: 1 }))
    expect(older.result.ok).toBe(true)
    if (!older.result.ok) return
    expect(older.result.value.projections).toBeUndefined()
  })

  it('serves the page without projections when the cache fold fails', async () => {
    const cache = stubCache(17)
    cache.coldSnapshot.mockImplementation(() => Promise.reject(new Error('fold exploded')))
    const h = await harness({ events: threeTurns(), cache })
    const response = await h.api.sessions.history(request({ sessionId: sid('s'), maxMessages: 1 }))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) return
    expect(response.result.value.projections).toBeUndefined()
  })

  it('serves without projections when no projection cache is mounted', async () => {
    const h = await harness({ events: threeTurns() })
    const response = await h.api.sessions.history(request({ sessionId: sid('s'), maxMessages: 1 }))
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) return
    expect(response.result.value.projections).toBeUndefined()
  })
})


/** Expand wire entries to the raw event stream they encode (packed chunk rows decode losslessly). */
function wireEvents(entries: readonly { event?: SessionEvent; packed?: unknown }[]): SessionEvent[] {
  return entries.flatMap(entry => entry.packed === undefined ? [entry.event as SessionEvent] : decodeStorageRecord(entry.packed))
}

/** The event-type sequence one history page encodes, expanded. */
function wireTypes(entries: readonly { event?: SessionEvent; packed?: unknown }[]): string[] {
  return wireEvents(entries).map(event => event.type)
}
