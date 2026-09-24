/**
 * Bounded page reads through the fork page-boundary plan: a page request that
 * already carries an exclusive upper bound reads the stored log only up to it,
 * serves the page an unbounded read would serve, and leaves the page to the
 * observation path when the bound cannot be proven. The opening window keeps
 * its unbounded read.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionLogOffset,
  SessionSeq,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import {
  readIndexedPage,
  readIndexedSuffix,
  type SeekablePersistence,
  type WindowPageCut,
} from '@deepseek-ai/dsh-api-session-controller/src/fork/page-boundary.ts'
import { paginate } from '@deepseek-ai/dsh-api-session-controller/src/history.ts'
import type { SessionPageRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import { createSessionTestRemote, testSessionPersistence } from './test-remote.ts'

const ownedContexts = new Set<Context>()
afterEach(async () => {
  await Promise.all([...ownedContexts].map(ctx => ctx.fiber.dispose()))
  ownedContexts.clear()
})

const sid = (id: string): SessionId => id as SessionId
const SESSION_ID = sid('page-bound')

/** `turns` closed turns; the user message of turn `i` (0-based) sits at `3i + 1`. */
function turnLog(turns: number): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let turn = 1; turn <= turns; turn++) {
    events.push({ type: 'turn/start', seq: SessionSeq(events.length), time: events.length, data: { turn } })
    events.push({
      type: 'user/message',
      seq: SessionSeq(events.length),
      time: events.length,
      surfaceOp: 'append',
      data: {
        id: MessageId(`page-${String(turn)}`),
        role: 'user',
        content: [{ type: 'text', text: `q${String(turn)}` }],
        source: { kind: 'user' },
      },
    })
    events.push({
      type: 'turn/end',
      seq: SessionSeq(events.length),
      time: events.length,
      data: { turn, reason: { kind: 'completed' } },
    })
  }
  return events
}

function header(): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SESSION_ID,
    createdAt: 1,
    cwd: '/proj',
    isSeeded: false,
  }
}

/** The store's own cut query: the oldest prompt of the last page below `beforeSeq`. */
function cutOf(events: readonly SessionEvent[], maxMessages: number, beforeSeq?: number): number | undefined {
  const prompts = events.filter(event => event.type === 'user/message'
    && event.surfaceOp === 'append'
    && (beforeSeq === undefined || event.seq < beforeSeq))
  return prompts.slice(-maxMessages)[0]?.seq
}

/**
 * The page rule the controller hands the indexed read: upstream's `paginate`
 * bound to one request. A windowed read must serve what this returns for the
 * same window, and what it returns for the whole log is the observation page.
 */
function windowCut(maxMessages: number, beforeSeq?: number): WindowPageCut {
  const bound = beforeSeq === undefined ? undefined : SessionLogOffset(beforeSeq)
  return (window, baseSeq, throughSeq) => paginate(
    window,
    bound,
    maxMessages,
    throughSeq === -1 ? -1 : SessionSeq(throughSeq),
    undefined,
    baseSeq,
  )
}

/** The page upstream's rule yields over a whole dense log. */
function wholeLogPage(
  events: readonly SessionEvent[],
  maxMessages: number,
  beforeSeq?: number,
): { readonly events: SessionEvent[]; readonly hasMore: boolean } {
  const cursor = events.at(-1)?.seq ?? -1
  return paginate(
    events,
    beforeSeq === undefined ? undefined : SessionLogOffset(beforeSeq),
    maxMessages,
    cursor === -1 ? -1 : SessionSeq(cursor),
  )
}

/** One recorded seek-surface read: its session, window start, exclusive end, and observed stored end. */
type ReadFromMock = Mock<(id: SessionId, fromSeq: number, throughSeqExclusive?: number) => Promise<{
  meta: SessionHeader
  inheritedEventCount: SessionLogOffset
  events: SessionEvent[]
  storedEnd: number
}>>

interface SourceOptions {
  /** Read and return only the events below the plan's exclusive bound. */
  readonly honorBound?: boolean
  /** Answer this cut instead of the store's own, for unsatisfiable-bound cases. */
  readonly cut?: number
  /** Stop this many seqs below the bound, as a truncated backend would. */
  readonly stopBelowBound?: number
  /** Start this many seqs above the requested window start, as a trimming backend would. */
  readonly trimHead?: number
  /** Omit this seq from the answered window, as a backend with a hole would. */
  readonly gapAt?: number
}

/** One seek surface over `events`; without `honorBound` it keeps the released two-argument tail read. */
function source(
  events: readonly SessionEvent[],
  options: SourceOptions = {},
): SeekablePersistence & { readonly readFrom: ReadFromMock } {
  const readFrom = vi.fn(async (id: SessionId, fromSeq: number, throughSeqExclusive?: number) => {
    if (id !== SESSION_ID) throw new Error(`unknown session "${id}"`)
    return {
      meta: header(),
      inheritedEventCount: SessionLogOffset(0),
      events: events.filter(event => event.seq >= fromSeq + (options.trimHead ?? 0)
        && event.seq !== options.gapAt
        && (options.honorBound !== true
          ? true
          : throughSeqExclusive === undefined
            ? true
            : event.seq < throughSeqExclusive - (options.stopBelowBound ?? 0))),
      storedEnd: events.at(-1)?.seq ?? -1,
    }
  })
  return {
    seekable: (id: SessionId) => Promise.resolve(id === SESSION_ID),
    messageCut: (_id: SessionId, maxMessages: number, beforeSeq?: number) =>
      Promise.resolve(options.cut ?? cutOf(events, maxMessages, beforeSeq)),
    readFrom,
  } satisfies SeekablePersistence & { readonly readFrom: ReadFromMock }
}

const signal = (): AbortSignal => new AbortController().signal

describe('indexed page reads with an exclusive bound', () => {
  const events = turnLog(400)
  const cursor = events.at(-1)?.seq ?? -1
  const older = { id: SESSION_ID, seedMessages: 3, beforeSeq: 901, throughSeq: cursor }

  it('reads an older page only up to its bound and serves the whole-log page', async () => {
    const bounded = source(events, { honorBound: true })
    const served = await readIndexedPage(bounded, older, windowCut(3, 901), () => {}, signal())
    // The page the whole log yields for this request: the released read covered
    // the tail past the bound, which upstream's cut filtered out anyway.
    const whole = wholeLogPage(events, older.seedMessages, older.beforeSeq)

    expect(served?.events.map(event => event.seq)).toEqual(whole.events.map(event => event.seq))
    expect(served?.hasMore).toBe(whole.hasMore)
    expect(bounded.readFrom.mock.calls[0]?.[1]).toBeLessThanOrEqual(901 - 128)
    expect(bounded.readFrom.mock.calls[0]?.[2]).toBe(901)
  })

  it('hands each read its own bound for caller-owned validation', async () => {
    const bounded = source(events, { honorBound: true })
    const seen: (number | undefined)[] = []
    await readIndexedPage(bounded, older, windowCut(3, 901), (_meta, _events, readEnd) => { seen.push(readEnd) }, signal())
    expect(seen).toEqual([901])
  })

  it('keeps the opening window plan unbounded', async () => {
    const bounded = source(events, { honorBound: true })
    const seen: (number | undefined)[] = []
    // The opening window's plan: no page-before bound and no cursor, so no
    // exclusive end exists and the read keeps the released whole-tail form.
    const read = await readIndexedSuffix(bounded, {
      id: SESSION_ID,
      seedMessages: 3,
      beforeSeq: undefined,
      windowFloor: () => 700,
    }, windowCut(3), (_meta, _events, readEnd) => { seen.push(readEnd) }, signal())

    expect(read?.page.events.map(event => event.seq))
      .toEqual(wholeLogPage(events, 3).events.map(event => event.seq))
    expect(bounded.readFrom.mock.calls.map(call => call[2])).toEqual([undefined, undefined])
    expect(seen).toEqual([undefined, undefined])
  })

  it('bounds the opening page at its cursor and serves the unbounded page', async () => {
    const bounded = source(events, { honorBound: true })
    const released = source(events)
    const plan = { id: SESSION_ID, seedMessages: 3, beforeSeq: undefined, throughSeq: cursor }
    const served = await readIndexedPage(bounded, plan, windowCut(3), () => {}, signal())
    const whole = await readIndexedPage(released, plan, windowCut(3), () => {}, signal())

    expect(served).toEqual(whole)
    expect(bounded.readFrom.mock.calls[0]?.[2]).toBe(cursor + 1)
  })

  it('answers an unsatisfiable bound without reading the log', async () => {
    const bounded = source(events, { honorBound: true, cut: 50 })
    const page = await readIndexedPage(
      bounded,
      { id: SESSION_ID, seedMessages: 3, beforeSeq: 0, throughSeq: cursor },
      windowCut(3, 0),
      () => {},
      signal(),
    )
    expect(page).toBeUndefined()
    expect(bounded.readFrom).not.toHaveBeenCalled()
  })

  it('serves no page from a suffix that stops short of its bound', async () => {
    // The store proves a bounded suffix dense up to its bound or re-runs whole
    // log; a backend answering short cannot be cut into a page, because that
    // page would silently drop every event between the suffix tail and the
    // bound. The caller's observation path owns the request instead.
    const short = source(events, { honorBound: true, stopBelowBound: 5 })
    await expect(readIndexedPage(short, older, windowCut(3, 901), () => {}, signal())).resolves.toBeUndefined()
    expect(short.readFrom).toHaveBeenCalled()
    // Answering nothing at all under the bound is the same refusal.
    const empty = source(events, { honorBound: true, stopBelowBound: 100_000 })
    await expect(readIndexedPage(empty, older, windowCut(3, 901), () => {}, signal())).resolves.toBeUndefined()

    // The same short suffix answers the opening plan, where no bound exists to
    // prove: the read is the whole tail and the page is cut from it.
    const opened = await readIndexedSuffix(short, {
      id: SESSION_ID,
      seedMessages: 3,
      beforeSeq: undefined,
    }, windowCut(3), () => {}, signal())
    expect(opened?.page.events.length).toBeGreaterThan(0)
  })

  it('serves no page from a window that is not the dense range it was asked for', async () => {
    // The cut arithmetic indexes the window by the seq it was read from, so a
    // backend answering a later start — or one with a hole — cannot be cut into
    // a page: the observation path answers instead of a page sliced at the
    // wrong offsets.
    const trimmed = source(events, { honorBound: true, trimHead: 40 })
    await expect(readIndexedPage(trimmed, older, windowCut(3, 901), () => {}, signal())).resolves.toBeUndefined()
    expect(trimmed.readFrom).toHaveBeenCalled()
    const gapped = source(events, { honorBound: true, gapAt: 800 })
    await expect(readIndexedPage(gapped, older, windowCut(3, 901), () => {}, signal())).resolves.toBeUndefined()
    expect(gapped.readFrom).toHaveBeenCalled()
  })

  it('accepts a two-argument validation closure', async () => {
    const bounded = source(events, { honorBound: true })
    let validated = 0
    const legacy = (_meta: SessionHeader, _events: readonly SessionEvent[]): void => { validated++ }
    const page = await readIndexedPage(bounded, older, windowCut(3, 901), legacy, signal())
    expect(page?.events.length).toBeGreaterThan(0)
    expect(validated).toBe(1)
  })
})

/** The wire page the remote result carries, for the seq-level assertions. */
interface PageResponse {
  readonly ok: boolean
  readonly value?: { readonly records: readonly { readonly event: { readonly seq: number } }[] }
}

interface PageRequest {
  readonly throughSeq: number
  readonly beforeSeq?: number
  readonly maxMessages?: number
  readonly turnWindow?: SessionPageRequest['turnWindow']
}

/** Mount one controller over a provided persistence double. */
async function mountController(options: {
  readonly seekable: boolean
  readonly honorBound?: boolean
  /** Omit the observed stored end, as a released three-argument provider does. */
  readonly reportStoredEnd?: boolean
}): Promise<{
  readonly ctx: Context
  readonly page: (request: PageRequest) => Promise<unknown>
  readonly readFrom: ReadFromMock
}> {
  const events = turnLog(400)
  const ctx = new Context()
  ownedContexts.add(ctx)
  await ctx.plugin(SessionStore)
  const readFrom: ReadFromMock = vi.fn(async (id: SessionId, fromSeq: number, throughSeqExclusive?: number) => {
    if (id !== SESSION_ID) throw new Error(`unknown session "${id}"`)
    const answered = {
      meta: header(),
      inheritedEventCount: SessionLogOffset(0),
      events: events.filter(event => event.seq >= fromSeq
        && (options.honorBound === false
          || throughSeqExclusive === undefined
          || event.seq < throughSeqExclusive)),
    }
    // A provider still implementing the released three-argument `readFrom`
    // answers the same window but reports no observed stored end; the cast
    // models that shape against the fork's required field.
    if (options.reportStoredEnd === false) {
      return answered as unknown as Awaited<ReturnType<ReadFromMock>>
    }
    return { ...answered, storedEnd: events.at(-1)?.seq ?? -1 }
  })
  const adapted = testSessionPersistence(ctx, {
    list: () => Promise.resolve([header()]),
    inspect: () => Promise.resolve({ meta: header(), events }),
    ...options.seekable
      ? {
        seekable: () => Promise.resolve(true),
        messageCut: (_id: SessionId, maxMessages: number, beforeSeq?: number) =>
          Promise.resolve(cutOf(events, maxMessages, beforeSeq)),
        readFrom,
      }
      : {},
  })
  ctx.provide('sessionPersistence', adapted as never)
  const remote = createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: '/proj',
  })
  return {
    ctx,
    readFrom,
    page: request => remote.page({
      address: { kind: 'session', sessionId: SESSION_ID },
      throughSeq: request.throughSeq,
      ...request.beforeSeq === undefined ? {} : { beforeSeq: request.beforeSeq },
      ...request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages },
      ...request.turnWindow === undefined ? {} : { turnWindow: request.turnWindow },
    }),
  }
}

describe('history controller older pages', () => {
  it('serves the observation page from the bounded fast path', async () => {
    const bounded = await mountController({ seekable: true })
    const observed = await mountController({ seekable: false })
    const request = { throughSeq: 1199, beforeSeq: 901, maxMessages: 3 }

    expect(await bounded.page(request)).toEqual(await observed.page(request))
    // The page-before bound bounded the read, not the request cursor: against
    // the cursor this read ends below it, which the released validator rejected.
    expect(bounded.readFrom.mock.calls[0]?.[1]).toBeGreaterThan(0)
    expect(bounded.readFrom.mock.calls[0]?.[2]).toBe(901)
  })

  it('rejects a backend read that carries events at or past its bound', async () => {
    // A provider that ignores the new optional end breaks the read's contract:
    // the window it answered reaches past the bound the page was addressed
    // with, so the request fails loud instead of being cut from that window.
    const mount = await mountController({ seekable: true, honorBound: false })
    const response = await mount.page({ throughSeq: 1199, beforeSeq: 901, maxMessages: 3 }) as {
      readonly ok: boolean
      readonly error?: { readonly code: string }
    }

    expect(response.ok).toBe(false)
    expect(response.error?.code).toBe('gateway/internal')
  })

  it('keeps rejecting a request cursor past the log end', async () => {
    // A stale cursor still fails: the bounded read cannot reach it, so the
    // request leaves the fast path and the observation path owns the rejection.
    const mount = await mountController({ seekable: true })
    const response = await mount.page({ throughSeq: 5_000, beforeSeq: 4_000, maxMessages: 3 }) as {
      readonly ok: boolean
      readonly error?: { readonly code: string }
    }

    expect(response.ok).toBe(false)
    expect(response.error?.code).toBe('gateway/bad-request')
  })

  it('serves a page whose bound equals the request cursor', async () => {
    const bounded = await mountController({ seekable: true })
    const observed = await mountController({ seekable: false })
    const request = { throughSeq: 1199, beforeSeq: 1199, maxMessages: 3 }

    expect(await bounded.page(request)).toEqual(await observed.page(request))
    expect(bounded.readFrom.mock.calls[0]?.[2]).toBe(1199)
  })

  it('fails loud when a bounded read reports no stored end', async () => {
    // A provider still implementing the released three-argument
    // `readFrom(id, fromSeq, signal?)` cannot report the end its read observed.
    // The bound kept this read below the cursor, so the cursor has nothing left
    // to check it against: the request fails loud rather than being answered
    // from a cursor nothing validated.
    const mount = await mountController({ seekable: true, reportStoredEnd: false })
    const response = await mount.page({ throughSeq: 3_000, beforeSeq: 901, maxMessages: 3 }) as {
      readonly ok: boolean
      readonly error?: { readonly code: string }
    }

    expect(response.ok).toBe(false)
    expect(response.error?.code).toBe('gateway/internal')
  })

  it('rejects a request cursor past the log end for an older page', async () => {
    // The page-before bound keeps the bounded read below the cursor, so the
    // read's own tail cannot answer the released cursor check. A stale client
    // cursor must fail on the fast path exactly as the observation path fails
    // it, never be answered from a window that never reached it.
    const bounded = await mountController({ seekable: true })
    const observed = await mountController({ seekable: false })
    const request = { throughSeq: 3_000, beforeSeq: 901, maxMessages: 3 }
    const rejected = { ok: false, error: { code: 'gateway/bad-request' } }

    expect(await observed.page(request)).toMatchObject(rejected)
    expect(await bounded.page(request)).toMatchObject(rejected)
  })

  it('agrees with the observation path for every request shape', async () => {
    const bounded = await mountController({ seekable: true })
    const observed = await mountController({ seekable: false })
    const shapes: PageRequest[] = [
      { throughSeq: 3_000, beforeSeq: 901, maxMessages: 3 },
      { throughSeq: 5_000, beforeSeq: 901, maxMessages: 3 },
      { throughSeq: 5_000, beforeSeq: 4_000, maxMessages: 3 },
      { throughSeq: 1_200, beforeSeq: 1_200, maxMessages: 3 },
      { throughSeq: 1_199, beforeSeq: 1_199, maxMessages: 3 },
      { throughSeq: 1_199, beforeSeq: 901, maxMessages: 3 },
      { throughSeq: 1_198, beforeSeq: 400, maxMessages: 1 },
      { throughSeq: 1_199, beforeSeq: 901 },
      { throughSeq: 600, beforeSeq: 901, maxMessages: 3 },
      { throughSeq: 3_000, maxMessages: 3 },
      { throughSeq: 1_199, maxMessages: 3 },
      { throughSeq: 900, beforeSeq: 0, maxMessages: 3 },
      { throughSeq: 900, beforeSeq: 1, maxMessages: 3 },
      { throughSeq: 900, beforeSeq: 2, maxMessages: 3 },
      { throughSeq: 900, beforeSeq: 3, maxMessages: 3 },
      { throughSeq: 0, beforeSeq: 0, maxMessages: 3 },
      { throughSeq: 0, maxMessages: 3 },
      { throughSeq: -1, maxMessages: 3 },
      { throughSeq: -1, beforeSeq: 901, maxMessages: 3 },
      { throughSeq: -1, beforeSeq: 0, maxMessages: 3 },
      { throughSeq: 1_199, maxMessages: 500, turnWindow: { minMessages: 2, minTurns: 3 } },
      { throughSeq: 1_199, beforeSeq: 901, maxMessages: 500, turnWindow: { minMessages: 2, minTurns: 3 } },
      { throughSeq: 600, maxMessages: 500, turnWindow: { minMessages: 3, minTurns: 2 } },
      { throughSeq: 1_199, maxMessages: 500, turnWindow: { minMessages: 1, minTurns: 400 } },
      { throughSeq: 1_199, maxMessages: 8, turnWindow: { minMessages: 8, minTurns: 2 } },
    ]

    for (const shape of shapes) {
      expect(await bounded.page(shape), JSON.stringify(shape)).toEqual(await observed.page(shape))
    }
  })

  it('widens a turn-windowed page to the Turn start the observation cuts', async () => {
    // The production older-page request carries a turn window. Its cut needs a
    // message floor of two and three Turn starts crossed, which the page cap of
    // 500 never reaches, so the cut is the third Turn start back — not the
    // maxMessages-th message and not the turn window's own message floor.
    const bounded = await mountController({ seekable: true })
    const observed = await mountController({ seekable: false })
    const request: PageRequest = {
      throughSeq: 1_199,
      beforeSeq: 901,
      maxMessages: 500,
      turnWindow: { minMessages: 2, minTurns: 3 },
    }
    const page = await bounded.page(request) as PageResponse
    const reference = await observed.page(request) as PageResponse

    expect(page).toEqual(reference)
    // The cut is turn 299's Turn start; only the 500-message cap could cut
    // later, and only the turn window's message floor could cut at the prompt.
    expect(page.value?.records.map(record => record.event.seq))
      .toEqual([894, 895, 896, 897, 898, 899, 900])
    // The bounded read starts below the seed prompt, so the fast path served it.
    expect(bounded.readFrom.mock.calls[0]?.[1]).toBeGreaterThan(0)
  })
})
