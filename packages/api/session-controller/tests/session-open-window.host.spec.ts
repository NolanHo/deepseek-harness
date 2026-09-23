/**
 * Cold-session opening fast path: the indexed suffix window serves the opening
 * page and the projection tail from one cut, sessions without a usable
 * checkpoint fall back to the full observation and install the record the next
 * open folds from, and every shape the window cannot prove (subagent
 * addresses, a persistence without the seek surface, a window short of a page)
 * keeps today's observation answer.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmAttemptId, MessageId } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionLogOffset,
  SessionSeq,
  interruptedTurnClosers,
} from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition, ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { SessionPersistence, SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { subagentIdentityProjectionDefinition } from '@deepseek-ai/dsh-subagent/src/projection.ts'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { SessionHistoryController } from '@deepseek-ai/dsh-api-session-controller/src/history.ts'
import {
  paginateSuffix,
  readIndexedSuffix,
  type SeekablePersistence,
} from '@deepseek-ai/dsh-api-session-controller/src/fork/page-boundary.ts'
import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types'
import { createSessionTestController, createSessionTestRemote, testSessionPersistence } from './test-remote.ts'

const ownedContexts = new Set<Context>()
const roots: string[] = []
afterEach(async () => {
  await Promise.all([...ownedContexts].map(ctx => ctx.fiber.dispose()))
  ownedContexts.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })))
})
let nextSession = 1

const sid = (id: string): SessionId => id as SessionId

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'open-window/marker': string | null
  }
  interface SessionProjectionMap {
    'open-window/marker': { marker: string } | null
  }
}

const cacheConfig = { writeEveryEvents: 10_000, writeIntervalMs: 600_000 }

/** One whole turn: opening, prompt, answer, close. */
function appendTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `q${String(turn)}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn,
    step: 1,
    stream: [],
    message: {
      role: 'assistant',
      id: MessageId(`a${String(turn)}`),
      content: [{ type: 'text', text: `a${String(turn)}` }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Whole-value page records for one event slice, matching the wire encoding. */
function pageRecords(events: readonly SessionEvent[]): Extract<SessionFollowFrame, { type: 'event' }>[] {
  return events.map(event => ({ type: 'event', event }) as Extract<SessionFollowFrame, { type: 'event' }>)
}

interface Mounted {
  readonly ctx: Context
  readonly sessionId: SessionId
  readonly meta: SessionHeader
  readonly events: readonly SessionEvent[]
  readonly maxMessages: number
  readonly cursor: number
  readonly records: Extract<SessionFollowFrame, { type: 'event' }>[]
  readonly hasMore: boolean
  readonly projections: ProjectionSnapshot
  readonly history: SessionHistoryController
  readonly promote: Mock<(observation: SessionObservation) => void>
  readonly inspect: Mock<(id: SessionId) => Promise<{ meta: SessionHeader; events: readonly SessionEvent[] }>>
  readonly stat: Mock<(id: SessionId) => Promise<{ header: SessionHeader; revision: SessionPersistenceRevision } | undefined>>
  readonly readFrom: Mock<(id: SessionId, fromSeq: number) => Promise<{
    meta: SessionHeader
    inheritedEventCount: SessionLogOffset
    events: readonly SessionEvent[]
  }>>
  readonly messageCut: Mock<(id: SessionId, limit: number, beforeSeq?: number) => Promise<number | undefined>>
  readonly seekable: Mock<(id: SessionId) => Promise<boolean>>
  /** Re-provide the persistence double, with or without the fork seek surface. */
  readonly providePersistence: (seekable: boolean) => void
  /** The mounted persistence double, for a provider that delegates to it. */
  readonly persistence: Record<string, unknown>
}

/**
 * A persistence provider registered as a real cordis Service, so `ctx.get`
 * answers its tracker proxy exactly as it does for the SQLite provider in
 * production. Its seek methods read their own state through `this`, so an
 * extracted method called against a wrapper object (rather than the proxy it
 * was read from) sees the wrapper and throws — the failure the windowed open
 * and the indexed page silently degrade on.
 */
class TrackerVisiblePersistence extends SessionPersistence {
  // Public state, not `#private`: cordis calls a service method with the shadow
  // object as `this`, and private fields exist only on the registered instance.
  private readonly base: Record<string, unknown>
  private readonly storedHeader: SessionHeader
  private readonly storedEvents: readonly SessionEvent[]

  constructor(
    ctx: Context,
    base: Record<string, unknown>,
    header: SessionHeader,
    events: readonly SessionEvent[],
  ) {
    super(ctx)
    this.base = base
    this.storedHeader = header
    this.storedEvents = events
  }

  override create(): Promise<SessionHandle> {
    return Promise.reject(new Error('tracker test provider is read-only'))
  }

  override open(...args: Parameters<SessionPersistence['open']>): ReturnType<SessionPersistence['open']> {
    return (this.base.open as SessionPersistence['open'])(...args)
  }

  override flush(): Promise<void> {
    return Promise.resolve()
  }

  override stat(...args: Parameters<SessionPersistence['stat']>): ReturnType<SessionPersistence['stat']> {
    return (this.base.stat as SessionPersistence['stat'])(...args)
  }

  override list(...args: Parameters<SessionPersistence['list']>): ReturnType<SessionPersistence['list']> {
    return (this.base.list as SessionPersistence['list'])(...args)
  }

  seekable(id: SessionId): Promise<boolean> {
    if (id !== this.storedHeader.id) return Promise.reject(new Error(`unknown session "${id}"`))
    return Promise.resolve(true)
  }

  messageCut(id: SessionId, limit: number, beforeSeq?: number): Promise<number | undefined> {
    if (id !== this.storedHeader.id) return Promise.reject(new Error(`unknown session "${id}"`))
    const window = beforeSeq === undefined
      ? this.storedEvents
      : this.storedEvents.filter(event => event.seq < beforeSeq)
    const prompts = window.filter(event => event.type === 'user/message' && event.surfaceOp === 'append')
    return Promise.resolve(prompts.slice(-limit)[0]?.seq)
  }

  readFrom(id: SessionId, fromSeq: number): Promise<{
    meta: SessionHeader
    inheritedEventCount: SessionLogOffset
    events: SessionEvent[]
  }> {
    if (id !== this.storedHeader.id) return Promise.reject(new Error(`unknown session "${id}"`))
    return Promise.resolve({
      meta: this.storedHeader,
      inheritedEventCount: SessionLogOffset(0),
      events: this.storedEvents.filter(event => event.seq >= fromSeq),
    })
  }
}

interface MountOptions {
  readonly turns?: number
  readonly maxMessages?: number
  /** Drop the fork seek surface, leaving the observation path. */
  readonly seekable?: boolean
  /** Mount the checkpoint cache only after the detach, so no record exists. */
  readonly cached?: boolean
  /** Append an interrupted final turn the stored log never closes. */
  readonly openTurn?: boolean
  /** Append bare prompts after the turns, for a log with no turn boundaries. */
  readonly userMessagesOnly?: number
  /** Append turns AFTER the checkpoint write, leaving its rows behind the log. */
  readonly staleTurns?: number
  /** Register the marker unit at this version, then bump it past the write. */
  readonly bumpMarkerUnit?: boolean
  /** Register the persistence as a real Service instead of a plain provided value. */
  readonly trackerService?: boolean
  /**
   * Answer the capability probe false while keeping both seek methods mounted:
   * the stored rows are a historical format whose seq space is re-based, so a
   * window read cannot address them.
   */
  readonly legacy?: boolean
}

/** A seek surface whose window is addressable, for the windowed read cases. */
const canSeek = { seekable: () => Promise.resolve(true) } as const

/** The projection key the fixture's marker unit owns. */
const MARKER_KEY = 'open-window/marker' as const

/** One whole-value unit whose view carries its state version, for bump tests. */
function markerUnit(stateVersion: number) {
  return {
    key: MARKER_KEY,
    stateSchema: z.union([z.string(), z.null()]),
    init: () => null,
    apply: (state: string | null, event: SessionEvent) => event.type === 'user/message'
      // The version also shapes the fold, so a record folded by a previous
      // version produces an observably different value when it is (wrongly) used.
      ? `${(event.data.content[0] as { text?: string }).text ?? ''}${stateVersion === 2 ? '!' : ''}`
      : state,
    wire: {
      viewSchema: z.union([z.object({ marker: z.string() }), z.null()]),
      view: (state: string | null) => (state === null ? null : { marker: `v${String(stateVersion)}:${state}` }),
    },
    stateVersion,
  } satisfies ProjectionDefinition<typeof MARKER_KEY, string | null>
}

/**
 * Mount one cold Session over an in-memory persistence double: the live log is
 * captured with the reference values a full observation returns, and its
 * owning fiber is disposed so the Session is cold for the opening read.
 */
async function mountSession(options: MountOptions = {}): Promise<Mounted> {
  const turns = options.turns ?? 60
  const maxMessages = options.maxMessages ?? 8
  const root = await mkdtemp(join(tmpdir(), 'dsh-open-window-'))
  roots.push(root)
  const ctx = new Context()
  ownedContexts.add(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  const cacheFiber = options.cached === false ? undefined : await ctx.plugin(SessionProjectionCache, cacheConfig)
  createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/proj' })
  const markerRegistration = options.bumpMarkerUnit === true
    ? ctx.sessionProjections.register(markerUnit(1))
    : undefined

  const sessionId = SessionId(`open-window-${String(nextSession++)}`)
  let session: Session | undefined
  const owner = await ctx.plugin(Object.assign((inner: Context) => {
    session = inner.sessions.create(sessionId, { meta: { createdAt: 7, cwd: '/proj' } })
  }, { inject: ['sessions'] }))
  if (session === undefined) throw new Error('session was not created')
  for (let turn = 1; turn <= turns; turn++) appendTurn(session, turn)
  if (options.openTurn === true) {
    session.append('turn/start', { turn: turns + 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'interrupted' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
  for (let index = 0; index < (options.userMessagesOnly ?? 0); index++) {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `bare-${String(index)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
  if (options.cached !== false) await ctx.sessionProjectionCache.write(session)
  for (let turn = turns + 1; turn <= turns + (options.staleTurns ?? 0); turn++) appendTurn(session, turn)
  if (options.staleTurns !== undefined) {
    // Drop the cache before the detach write lands, so the stored record keeps
    // the earlier cut and the cold open sees a genuinely stale checkpoint.
    await cacheFiber?.dispose()
  }
  markerRegistration?.()
  if (options.bumpMarkerUnit === true) ctx.sessionProjections.register(markerUnit(2))

  const events = [...session.snapshotEvents()]
  const meta = session.header
  const cursor = events.at(-1)?.seq ?? -1
  // The live registry at the same cut is what a full observation reproduces.
  const projections = ctx.sessionProjections.snapshot(session)
  const page = paginateSuffix(events, undefined, maxMessages, cursor)
  const inspect = vi.fn(async (id: SessionId) => {
    if (id !== sessionId) throw new Error(`unknown session "${id}"`)
    return { meta, events }
  })
  const stat = vi.fn(async (id: SessionId) => id === sessionId
    ? { header: meta, revision: SessionPersistenceRevision('open-window:1') }
    : undefined)
  const readFrom = vi.fn(async (id: SessionId, fromSeq: number) => {
    if (id !== sessionId) throw new Error(`unknown session "${id}"`)
    return { meta, inheritedEventCount: SessionLogOffset(0), events: events.filter(event => event.seq >= fromSeq) }
  })
  const messageCut = vi.fn(async (id: SessionId, limit: number, beforeSeq?: number) => {
    if (id !== sessionId) throw new Error(`unknown session "${id}"`)
    const window = beforeSeq === undefined ? events : events.filter(event => event.seq < beforeSeq)
    const prompts = window.filter(event => event.type === 'user/message' && event.surfaceOp === 'append')
    return prompts.slice(-limit)[0]?.seq
  })
  const seekable = vi.fn(async (id: SessionId) => {
    if (id !== sessionId) throw new Error(`unknown session "${id}"`)
    return options.legacy !== true
  })
  const adapted = testSessionPersistence(ctx, {
    list: () => Promise.resolve([meta]),
    inspect,
    stat,
    ...options.seekable === false ? {} : { seekable, messageCut, readFrom },
  })
  if (options.trackerService === true) new TrackerVisiblePersistence(ctx, adapted, meta, events)
  else ctx.provide('sessionPersistence', adapted as never)
  /** Toggle the fork seek surface on the mounted double, so one Session can be
   * opened through both the windowed and the observation path in one test. */
  const providePersistence = (windowed: boolean): void => {
    if (windowed) {
      adapted.seekable = seekable
      adapted.messageCut = messageCut
      adapted.readFrom = readFrom
    } else {
      delete adapted.seekable
      delete adapted.messageCut
      delete adapted.readFrom
    }
  }

  const promote = vi.fn((observation: SessionObservation) => { observation[Symbol.dispose]() })
  const history = new SessionHistoryController(ctx, promote)
  await owner.dispose()
  if (options.cached === false || options.staleTurns !== undefined) {
    await ctx.plugin(SessionProjectionCache, cacheConfig)
  }
  return {
    ctx,
    sessionId,
    meta,
    events,
    maxMessages,
    cursor,
    records: pageRecords(page.events),
    hasMore: page.hasMore,
    projections,
    history,
    promote,
    inspect,
    stat,
    readFrom,
    messageCut,
    seekable,
    providePersistence,
    persistence: adapted,
  }
}

/** Read and close one snapshot-first follow generation. */
async function opening(
  history: SessionHistoryController,
  sessionId: SessionId,
  maxMessages?: number,
): Promise<Extract<SessionFollowFrame, { type: 'snapshot' }>> {
  const abort = new AbortController()
  const iterator = history.follow({
    address: { kind: 'session', sessionId },
    ...(maxMessages === undefined ? {} : { maxMessages }),
  }, abort.signal)[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (first.done || first.value.type !== 'snapshot') throw new Error('follow did not open with a snapshot')
  // Resume past the opening yield so the follower parks in its live loop, then
  // end the generation.
  const parked = iterator.next()
  abort.abort()
  await parked
  await iterator.return?.()
  return first.value
}

/**
 * The live Session face a deferred mount publishes over already-stored events:
 * enough of the Session contract for the `session/created` and `session/event`
 * listeners that observe it.
 * @param mount - mounted fixture whose identity and header the Session carries.
 * @param events - events the mounting lifecycle holds beyond the constructor seed.
 * @param firstLiveSeq - first seq this process appended, i.e. the constructor
 *   seed length; a mount that seeds the stored log resumes one past its end.
 * @returns the Session face the mount publishes.
 */
function mountingSession(
  mount: Mounted,
  events: readonly SessionEvent[],
  firstLiveSeq: SessionLogOffset = SessionLogOffset(0),
): Session {
  return {
    id: mount.sessionId,
    header: mount.meta,
    inheritedEventCount: SessionLogOffset(0),
    firstLiveSeq,
    snapshotEvents: (fromSeq: SessionLogOffset = SessionLogOffset(0)) =>
      events.filter(event => event.seq >= fromSeq),
  } as unknown as Session
}

describe('windowed session open', () => {
  it('serves the page and its projections from one suffix read, never the full log', async () => {
    const mount = await mountSession()
    const snapshot = await opening(mount.history, mount.sessionId, mount.maxMessages)

    expect(snapshot.header).toEqual(mount.meta)
    expect(snapshot.records).toEqual(mount.records)
    expect(snapshot.hasMore).toBe(mount.hasMore)
    expect(snapshot.cursor).toBe(mount.cursor)
    expect(snapshot.projections).toEqual({
      asOfSeq: mount.projections.asOfSeq,
      values: mount.projections.values,
    })
    // The page tail IS the reported cursor; the gateway asserts this equality.
    expect(snapshot.records.at(-1)?.event.seq).toBe(snapshot.cursor)
    // One tail read serves both the page and the projection fold: the ladder
    // starts below the cut (one lead margin, per PAGE_CUT_LEAD_MARGIN) and
    // above the log head, so the whole log was never read. The fixture's page
    // arithmetic depends on that margin; better assertions stay behavioral.
    expect(mount.readFrom).toHaveBeenCalledOnce()
    expect(mount.readFrom.mock.calls[0]?.[1]).toBeGreaterThan(0)
    expect(mount.readFrom.mock.calls[0]?.[1]).toBeLessThanOrEqual(promptsCut(mount.events, mount.maxMessages))
    expect(mount.stat).not.toHaveBeenCalled()
    expect(mount.inspect).not.toHaveBeenCalled()
    expect(mount.promote).not.toHaveBeenCalled()
  })

  it('falls back without a checkpoint and installs the record its next open folds from', async () => {
    const mount = await mountSession({ cached: false })
    const expected = {
      records: mount.records,
      hasMore: mount.hasMore,
      cursor: mount.cursor,
      projections: { asOfSeq: mount.projections.asOfSeq, values: mount.projections.values },
    }

    const first = await opening(mount.history, mount.sessionId, mount.maxMessages)
    expect(first.records).toEqual(expected.records)
    expect(first.hasMore).toBe(expected.hasMore)
    expect(first.cursor).toBe(expected.cursor)
    expect(first.projections).toEqual(expected.projections)
    // Today's cold read answered, and its prepared cut is what gets promoted.
    // (The window probe read the tail first, found no checkpoint, and bailed.)
    expect(mount.inspect).toHaveBeenCalledOnce()
    expect(mount.promote).toHaveBeenCalledOnce()

    // The write-back is fire-and-forget: settle it, then the record must serve.
    await vi.waitFor(() => {
      expect(mount.ctx.sessionProjectionCache.cachedSnapshot(mount.meta, SessionLogOffset(0))).toBeDefined()
    }, { timeout: 5_000 })
    mount.inspect.mockClear()
    mount.promote.mockClear()

    const second = await opening(mount.history, mount.sessionId, mount.maxMessages)
    expect(second.records).toEqual(expected.records)
    expect(second.hasMore).toBe(expected.hasMore)
    expect(second.cursor).toBe(expected.cursor)
    expect(second.projections).toEqual(expected.projections)
    // The record serves the window: no whole-log read and nothing mounted.
    expect(mount.inspect).not.toHaveBeenCalled()
    expect(mount.readFrom).toHaveBeenCalled()
    expect(mount.promote).not.toHaveBeenCalled()
  })

  it('keeps the observation path for a persistence without the seek surface', async () => {
    const mount = await mountSession({ seekable: false })
    const snapshot = await opening(mount.history, mount.sessionId, mount.maxMessages)

    expect(snapshot.records).toEqual(mount.records)
    expect(snapshot.hasMore).toBe(mount.hasMore)
    expect(snapshot.cursor).toBe(mount.cursor)
    expect(snapshot.projections).toEqual({
      asOfSeq: mount.projections.asOfSeq,
      values: mount.projections.values,
    })
    expect(mount.messageCut).not.toHaveBeenCalled()
    expect(mount.readFrom).not.toHaveBeenCalled()
    expect(mount.inspect).toHaveBeenCalled()
  })

  it('falls back when the window cannot hold a full page', async () => {
    const mount = await mountSession({ turns: 2, maxMessages: 8 })
    const snapshot = await opening(mount.history, mount.sessionId, mount.maxMessages)

    expect(snapshot.records).toEqual(mount.records)
    expect(snapshot.hasMore).toBe(mount.hasMore)
    expect(snapshot.cursor).toBe(mount.cursor)
    expect(snapshot.projections).toEqual({
      asOfSeq: mount.projections.asOfSeq,
      values: mount.projections.values,
    })
    expect(mount.readFrom).toHaveBeenCalled()
    expect(mount.inspect).toHaveBeenCalled()
  })

  it('serves the same snapshot as the observation path for one Session', async () => {
    // Differential oracle: the non-seekable mount cannot take the window, so its
    // snapshot comes from the full observation — an implementation-independent
    // reference for the windowed mount of the same Session.
    const mount = await mountSession()
    mount.providePersistence(false)
    const reference = await opening(mount.history, mount.sessionId, mount.maxMessages)
    expect(mount.inspect).toHaveBeenCalled()
    // The observation path stats before it opens the log; the windowed path
    // never stats, so these counters independently witness which path served.
    expect(mount.stat).toHaveBeenCalledOnce()
    expect(mount.promote).toHaveBeenCalledOnce()
    mount.providePersistence(true)
    mount.inspect.mockClear()
    mount.stat.mockClear()
    mount.promote.mockClear()

    const windowed = await opening(mount.history, mount.sessionId, mount.maxMessages)

    expect(mount.inspect).not.toHaveBeenCalled()
    expect(mount.stat).not.toHaveBeenCalled()
    expect(mount.promote).not.toHaveBeenCalled()
    expect(windowed.header).toEqual(reference.header)
    expect(windowed.records).toEqual(reference.records)
    expect(windowed.hasMore).toBe(reference.hasMore)
    expect(windowed.cursor).toBe(reference.cursor)
    expect(windowed.projections).toEqual(reference.projections)
  })

  it('serves a whole-log page with hasMore false through the window', async () => {
    // Exactly maxMessages prompts: the aligned cut reaches the log head, so the
    // windowed page is the whole log and no older history exists.
    const mount = await mountSession({ turns: 8, maxMessages: 8 })
    const snapshot = await opening(mount.history, mount.sessionId, mount.maxMessages)

    expect(snapshot.hasMore).toBe(false)
    expect(snapshot.records[0]?.event).toMatchObject({ type: 'turn/start', seq: 0 })
    expect(snapshot.records.at(-1)?.event.seq).toBe(snapshot.cursor)
    expect(snapshot.projections).toEqual({
      asOfSeq: mount.projections.asOfSeq,
      values: mount.projections.values,
    })
    expect(mount.inspect).not.toHaveBeenCalled()
  })

  it('seeds a stale checkpoint by folding the log tail behind its rows', async () => {
    // The stored record predates 40 further turns (the production shape: the
    // last checkpoint write happens at a turn end, not at the log end).
    const mount = await mountSession({ turns: 60, staleTurns: 40 })
    const snapshot = await opening(mount.history, mount.sessionId, mount.maxMessages)

    expect(snapshot.cursor).toBe(mount.cursor)
    expect(snapshot.projections).toEqual({
      asOfSeq: mount.projections.asOfSeq,
      values: mount.projections.values,
    })
    // The projection floor sits behind the page window, so the read restarts
    // there instead of serving rows the fold cannot seed.
    expect(mount.readFrom.mock.calls.length).toBeGreaterThan(1)
    const [first, second] = mount.readFrom.mock.calls.map(call => call[1])
    expect(second).toBeLessThan(first as number)
    expect(mount.inspect).not.toHaveBeenCalled()
  })

  it('falls back when a projected unit outran its checkpoint state version', async () => {
    // A record exists, but one of its rows predates a state-version bump: the
    // registry cannot refold from it, so the observation path serves the
    // refolded values instead of a stale row.
    const mount = await mountSession({ bumpMarkerUnit: true })
    expect(mount.projections.values['open-window/marker']).toEqual({ marker: 'v2:q60!' })
    const snapshot = await opening(mount.history, mount.sessionId, mount.maxMessages)

    expect(snapshot.projections).toEqual({
      asOfSeq: mount.projections.asOfSeq,
      values: mount.projections.values,
    })
    expect(mount.messageCut).toHaveBeenCalled()
    expect(mount.inspect).toHaveBeenCalledOnce()
  })

  it('falls back when the accepted read answers another lifecycle', async () => {
    // The window plan resolves its checkpoint from the first read; a restarted
    // or retried read that answers a different lifecycle must not seed those
    // rows into this fold.
    const mount = await mountSession({ turns: 60, staleTurns: 40 })
    const other: SessionHeader = { ...mount.meta, createdAt: mount.meta.createdAt + 1 }
    mount.readFrom
      .mockImplementationOnce(async (_id: SessionId, fromSeq: number) => ({
        meta: mount.meta,
        inheritedEventCount: SessionLogOffset(0),
        events: mount.events.filter(event => event.seq >= fromSeq),
      }))
      .mockImplementation(async () => ({
        meta: other,
        inheritedEventCount: SessionLogOffset(0),
        events: mount.events,
      }))

    await opening(mount.history, mount.sessionId, mount.maxMessages)

    // First read served the window; the retried read answered another Session,
    // so the fast path bailed and the observation path answered.
    expect(mount.readFrom.mock.calls.length).toBeGreaterThan(1)
    expect(mount.inspect).toHaveBeenCalledOnce()
  })

  it('carries the opted-in Assistant baseline on a windowed opening', async () => {
    const mount = await mountSession()
    const agent = { id: mount.sessionId, session: { id: mount.sessionId, seq: SessionLogOffset(1) } } as unknown as Agent
    const attemptId = LlmAttemptId('open-window-attempt')
    mount.ctx.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'start', attemptId, revision: 1, turn: 1, step: 1 },
    })
    mount.ctx.emit('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', attemptId, revision: 2, index: 0, time: 2, chunk: { type: 'text-delta', index: 0, text: 'live' } },
    })
    const abort = new AbortController()
    const iterator = mount.history.follow({
      address: { kind: 'session', sessionId: mount.sessionId },
      assistantStream: true,
    }, abort.signal)[Symbol.asyncIterator]()
    const first = await iterator.next()
    abort.abort()
    await iterator.return?.()
    if (first.done || first.value.type !== 'snapshot') throw new Error('follow did not open with a snapshot')

    expect(first.value.assistantStream).toMatchObject({ revision: 2 })
    expect(mount.inspect).not.toHaveBeenCalled()
  })

  it('reports a stored Session without a workspace as not found', async () => {
    // The window reads the header itself, so it owns the same absence mapping
    // the observation path applies.
    const mount = await mountSession()
    mount.readFrom.mockImplementation(async (_id: SessionId, fromSeq: number) => ({
      // Header without `cwd`: the window owns the same absence mapping the
      // observation path applies.
      meta: {
        version: SESSION_FORMAT_VERSION,
        id: mount.sessionId,
        createdAt: mount.meta.createdAt,
        isSeeded: false,
      },
      inheritedEventCount: SessionLogOffset(0),
      events: mount.events.filter(event => event.seq >= fromSeq),
    }))

    await expect(opening(mount.history, mount.sessionId, mount.maxMessages))
      .rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('drops a window read that raced a Session attach', async () => {
    const mount = await mountSession()
    mount.readFrom.mockImplementation(async (id: SessionId, fromSeq: number) => {
      // The store attaches the identity while the window read is in flight.
      mount.ctx.sessions.create(id, { meta: { cwd: '/proj' } })
      return {
        meta: mount.meta,
        inheritedEventCount: SessionLogOffset(0),
        events: mount.events.filter(event => event.seq >= fromSeq),
      }
    })

    const snapshot = await opening(mount.history, mount.sessionId, mount.maxMessages)

    // The live store answered instead: no persistence read, the live cut.
    expect(mount.inspect).not.toHaveBeenCalled()
    expect(snapshot.cursor).toBe(-1)
  })

  it('never reads the whole log for a windowed open', async () => {
    const mount = await mountSession()
    const gateway = createSessionTestRemote(mount.ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/proj',
    })
    const abort = new AbortController()
    const iterator = gateway.follow({ address: { kind: 'session', sessionId: mount.sessionId } }, abort.signal)
      [Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done || first.value.type !== 'snapshot') throw new Error('follow did not open with a snapshot')
    expect(first.value.cursor).toBe(mount.cursor)
    // The window served the page: one suffix read, no capability stat, and the
    // persistence never answered its whole-log point read.
    expect(mount.readFrom).toHaveBeenCalledOnce()
    expect(mount.stat).not.toHaveBeenCalled()
    expect(mount.inspect).not.toHaveBeenCalled()

    // Park the follower and let everything behind the opening frame run: two
    // macrotasks and a microtask turn settle both a whole-log read chained off
    // the yield and one deferred behind a timer or an idle callback.
    const parked = iterator.next()
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    await Promise.resolve()
    expect(mount.inspect).not.toHaveBeenCalled()

    abort.abort()
    await parked
    await iterator.return?.()
  })

  it('keeps the windowed Session out of the live store until something asks for it', async () => {
    const mount = await mountSession()
    const resume = vi.spyOn(mount.ctx.agents, 'resume').mockRejectedValue(new Error('nothing may mount here'))
    // The gateway's own controller owns the follow request.
    const gateway = createSessionTestRemote(mount.ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/proj',
    })
    const abort = new AbortController()
    const iterator = gateway.follow({ address: { kind: 'session', sessionId: mount.sessionId } }, abort.signal)
      [Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done || first.value.type !== 'snapshot') throw new Error('follow did not open with a snapshot')
    expect(first.value.cursor).toBe(mount.cursor)

    const parked = iterator.next()
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(resume).not.toHaveBeenCalled()
    expect(mount.ctx.sessions.get(mount.sessionId)).toBeUndefined()
    expect(mount.ctx.agents.get(mount.sessionId)).toBeUndefined()
    abort.abort()
    await parked
    await iterator.return?.()
    resume.mockRestore()
  })

  it('mounts the windowed Session on demand when a later request resolves it', async () => {
    const mount = await mountSession()
    const snapshot = await opening(mount.history, mount.sessionId, mount.maxMessages)
    expect(snapshot.cursor).toBe(mount.cursor)
    // The windowed open read no whole log and mounted nothing.
    expect(mount.inspect).not.toHaveBeenCalled()
    expect(mount.ctx.sessions.get(mount.sessionId)).toBeUndefined()
    const resume = vi.spyOn(mount.ctx.agents, 'resume').mockResolvedValue({
      agent: { id: mount.sessionId } as Agent,
      dispose: () => Promise.resolve(),
    })
    const controller = createSessionTestController(mount.ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/proj',
    })

    // The deferred resolution pays the whole-log read and reaches the registry
    // for the same Session.
    const found = await controller.resolveAgent(mount.sessionId)

    expect('agent' in found).toBe(true)
    expect(mount.inspect.mock.calls[0]?.[0]).toBe(mount.sessionId)
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: mount.sessionId }))
    resume.mockRestore()
  })

  it('leaves the still-open follower healthy when the deferred resolution fails', async () => {
    const mount = await mountSession()
    const abort = new AbortController()
    const iterator = mount.history.follow({
      address: { kind: 'session', sessionId: mount.sessionId },
      maxMessages: mount.maxMessages,
    }, abort.signal)[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done || first.value.type !== 'snapshot') throw new Error('follow did not open with a snapshot')
    expect(first.value.cursor).toBe(mount.cursor)

    // The deferred resolution fails: its caller answers the failure the eager
    // activation used to report on `api-session/error` after the snapshot.
    const resume = vi.spyOn(mount.ctx.agents, 'resume').mockRejectedValueOnce(new Error('mount exploded'))
    const controller = createSessionTestController(mount.ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/proj',
    })
    const failed = await controller.resolveAgent(mount.sessionId)
    if (!('error' in failed)) throw new Error('the failed resolution answered an Agent')
    expect(failed.error.message).toContain('mount exploded')
    expect(mount.inspect).toHaveBeenCalled()
    // The failure left neither the live store nor the Agent registry holding it.
    expect(mount.ctx.sessions.get(mount.sessionId)).toBeUndefined()
    expect(mount.ctx.agents.get(mount.sessionId)).toBeUndefined()

    // A later resolution still mounts the Session, and the frames that mount
    // publishes reach the follower that stayed open across the failure.
    resume.mockResolvedValue({ agent: { id: mount.sessionId } as Agent, dispose: () => Promise.resolve() })
    const found = await controller.resolveAgent(mount.sessionId)
    expect('agent' in found).toBe(true)
    resume.mockRestore()
    const seeded = [mount.cursor + 1, mount.cursor + 2].map(seq => ({
      type: 'turn/start' as const,
      seq: SessionSeq(seq),
      time: seq,
      data: { turn: 90 + seq },
    })) as SessionEvent[]
    const session = mountingSession(mount, seeded)
    mount.ctx.emit('session/created', session)
    mount.ctx.emit('session/event', session, seeded[1] as SessionEvent)

    expect((await iterator.next()).value).toMatchObject({ type: 'event', event: { seq: mount.cursor + 1 } })
    expect((await iterator.next()).value).toMatchObject({ type: 'event', event: { seq: mount.cursor + 2 } })

    abort.abort()
    await iterator.return?.()
  })

  it('replays the constructor suffix when the Session is created during the window read', async () => {
    const mount = await mountSession()
    // The mounting lifecycle seeds the Session with the stored log, so its
    // first live seq is one past the window's cursor: the page tail, and the
    // seeded events above it, are the only frames the follower still owes.
    const firstLiveSeq = SessionLogOffset(mount.cursor + 1)
    const seeded = [mount.cursor + 1, mount.cursor + 2].map(seq => ({
      type: 'turn/start' as const,
      seq: SessionSeq(seq),
      time: seq,
      data: { turn: 90 + seq },
    })) as SessionEvent[]
    const session = mountingSession(mount, seeded, firstLiveSeq)
    const snapshotEvents = vi.spyOn(session, 'snapshotEvents')
    mount.readFrom.mockImplementation(async (id: SessionId, fromSeq: number) => {
      // The mount lands while the window read is in flight, before the follower
      // holds a snapshot cursor to replay above.
      mount.ctx.emit('session/created', session)
      return {
        meta: mount.meta,
        inheritedEventCount: SessionLogOffset(0),
        events: mount.events.filter(event => event.seq >= fromSeq),
      }
    })

    const abort = new AbortController()
    const iterator = mount.history.follow({
      address: { kind: 'session', sessionId: mount.sessionId },
      maxMessages: mount.maxMessages,
    }, abort.signal)[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done || first.value.type !== 'snapshot') throw new Error('follow did not open with a snapshot')

    expect(first.value.cursor).toBe(mount.cursor)
    // Without a cursor yet, the replay starts at the constructor boundary — not
    // at 0, which would re-push the whole seed — and joins the page tail.
    expect(snapshotEvents).toHaveBeenCalledWith(firstLiveSeq)
    expect(first.value.records.at(-1)?.event.seq).toBe(mount.cursor)
    expect((await iterator.next()).value).toMatchObject({ type: 'event', event: { seq: mount.cursor + 1 } })

    // A live append behind the replayed suffix still lands in seq order.
    mount.ctx.emit('session/event', session, seeded[1] as SessionEvent)
    expect((await iterator.next()).value).toMatchObject({ type: 'event', event: { seq: mount.cursor + 2 } })

    abort.abort()
    await iterator.return?.()
  })

  it('replays frames after the snapshot cursor when the Session mounts later', async () => {
    const mount = await mountSession()
    const abort = new AbortController()
    const iterator = mount.history.follow({
      address: { kind: 'session', sessionId: mount.sessionId },
      maxMessages: mount.maxMessages,
    }, abort.signal)[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done || first.value.type !== 'snapshot') throw new Error('follow did not open with a snapshot')
    expect(mount.inspect).not.toHaveBeenCalled()

    // The deferred mount publishes the Session it seeded: the follower replays
    // the constructor suffix above the snapshot cursor, then the live append.
    const seeded = [mount.cursor + 1, mount.cursor + 2].map(seq => ({
      type: 'turn/start' as const,
      seq: SessionSeq(seq),
      time: seq,
      data: { turn: 90 + seq },
    })) as SessionEvent[]
    const session = mountingSession(mount, seeded)
    mount.ctx.emit('session/created', session)
    mount.ctx.emit('session/event', session, seeded[1] as SessionEvent)

    expect((await iterator.next()).value).toMatchObject({ type: 'event', event: { seq: mount.cursor + 1 } })
    expect((await iterator.next()).value).toMatchObject({ type: 'event', event: { seq: mount.cursor + 2 } })

    abort.abort()
    await iterator.return?.()
  })

  it('never seeks a window for a historical session through the opening path', async () => {
    // 932 of the deployed store's 938 sessions are pre-format-change rows whose
    // log restores into a re-based seq space: the cut the index answers does not
    // address the restored events, so a window read costs a full log read and
    // yields nothing. The probe must answer before either method is called.
    const mount = await mountSession({ turns: 12, maxMessages: 4, legacy: true })

    const frame = await opening(mount.history, mount.sessionId, mount.maxMessages)

    expect(frame.records).toEqual(mount.records)
    expect(frame.hasMore).toBe(mount.hasMore)
    expect(mount.seekable).toHaveBeenCalledWith(mount.sessionId, expect.anything())
    expect(mount.messageCut).not.toHaveBeenCalled()
    expect(mount.readFrom).not.toHaveBeenCalled()
    // The observation path served it.
    expect(mount.stat).toHaveBeenCalled()
  })

  it('never seeks a window for a historical session through page()', async () => {
    const mount = await mountSession({ turns: 12, maxMessages: 4, legacy: true })

    const page = await mount.history.page({
      address: { kind: 'session', sessionId: mount.sessionId },
      throughSeq: mount.cursor,
      maxMessages: mount.maxMessages,
    }, new AbortController().signal)

    expect(page.records).toEqual(mount.records)
    expect(page.hasMore).toBe(mount.hasMore)
    expect(mount.messageCut).not.toHaveBeenCalled()
    expect(mount.readFrom).not.toHaveBeenCalled()
    expect(mount.stat).toHaveBeenCalled()
  })

  it('drives the seek surface of a provider read through its tracker proxy', async () => {
    // Production composition: the persistence is a Service, so `ctx.get`
    // answers a tracker proxy and a method taken off it must be called on that
    // proxy to see the provider's own `this` (vendor/cordis createShadowMethod).
    // A wrapper object around the extracted methods makes them throw, and the
    // opening read then falls back to the full observation path in silence.
    const mount = await mountSession({ turns: 12, maxMessages: 4, trackerService: true })

    const frame = await opening(mount.history, mount.sessionId, mount.maxMessages)

    expect(frame.records).toEqual(mount.records)
    // The observation path stats before opening the log; the windowed one never
    // reaches either, so a silent fallback cannot pass this test.
    expect(mount.stat).not.toHaveBeenCalled()
    expect(mount.inspect).not.toHaveBeenCalled()
  })

  it('drives the indexed older-page read through a provider tracker proxy', async () => {
    // The same surface serves `page()`/`loadOlder`, so the unbound form had
    // kept that fast path dormant in production too.
    const mount = await mountSession({ turns: 12, maxMessages: 4, trackerService: true })

    const page = await mount.history.page({
      address: { kind: 'session', sessionId: mount.sessionId },
      throughSeq: mount.cursor,
      maxMessages: mount.maxMessages,
    }, new AbortController().signal)

    expect(page.records).toEqual(mount.records)
    expect(mount.stat).not.toHaveBeenCalled()
  })

  it('installs the durable cut for a recovered log read through the session reader', { timeout: 30_000 }, async () => {
    // End-to-end wiring for the durable-event count: a crash-interrupted stored
    // log goes through the observation reader, and the checkpoint it installs
    // must stop at the stored end while the served block sits at the balanced
    // observation cut.
    const mount = await mountSession({ turns: 3, openTurn: true, cached: false })
    const durableEnd = mount.events.at(-1)?.seq ?? -1
    const balancedEnd = durableEnd + interruptedTurnClosers(mount.events).length
    expect(balancedEnd).toBeGreaterThan(durableEnd)

    using observation = await mount.ctx.sessionQuery.observeSession(mount.sessionId, { projectionMode: 'all' })
    expect(observation.projections?.asOfSeq).toBe(balancedEnd)

    await vi.waitFor(() => {
      expect(mount.ctx.sessionProjectionCache.cachedSnapshot(mount.meta, SessionLogOffset(0))?.asOfSeq)
        .toBe(durableEnd)
    }, { timeout: 5_000 })
  })

  it('keeps the observation path for subagent addresses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-open-window-child-'))
    roots.push(root)
    const ctx = new Context()
    ownedContexts.add(ctx)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SessionProjectionCache, cacheConfig)
    createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/proj' })
    ctx.sessionProjections.register(subagentIdentityProjectionDefinition)

    const parentId = sid('open-window-parent')
    const childId = sid('open-window-child')
    const events = [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
      {
        type: 'user/message',
        seq: SessionSeq(1),
        time: 2,
        data: createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }),
        surfaceOp: 'append',
      },
      {
        type: 'subagent/descriptor',
        seq: SessionSeq(2),
        time: 3,
        data: snapshotSubagentDescriptor({ mode: 'continuable', provider: 'spawn', label: 'child' }),
      },
      { type: 'turn/end', seq: SessionSeq(3), time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as SessionEvent[]
    const meta: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: childId,
      createdAt: 1,
      cwd: '/proj',
      isSeeded: false,
      parentSession: parentId,
      origin: 'subagent',
    }
    const readFrom = vi.fn(async () => ({ meta, inheritedEventCount: SessionLogOffset(0), events }))
    const messageCut = vi.fn(async () => 1)
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({ meta, events }),
      messageCut,
      readFrom,
    }) as never)
    const childHistory = new SessionHistoryController(ctx, vi.fn())
    const abort = new AbortController()
    const iterator = childHistory.follow({
      address: { kind: 'subagent', parentSessionId: parentId, childSessionId: childId, mode: 'continuable' },
    }, abort.signal)[Symbol.asyncIterator]()
    const first = await iterator.next()
    abort.abort()
    await iterator.return?.()
    if (first.done || first.value.type !== 'snapshot') throw new Error('follow did not open with a snapshot')

    expect(first.value.records.map(record => record.event.type)).toEqual(events.map(event => event.type))
    expect(first.value.projections.values.subagent).toMatchObject({ mode: 'continuable' })
    expect(messageCut).not.toHaveBeenCalled()
    expect(readFrom).not.toHaveBeenCalled()
  })

  it('falls back when the stored log ends inside an open turn', async () => {
    // The window shows an unclosed turn, so its fold would differ from the
    // balanced opening a full observation serves (asOfSeq included).
    const mount = await mountSession({ turns: 12, openTurn: true })
    const storedEnd = mount.events.at(-1)?.seq ?? -1
    const snapshot = await opening(mount.history, mount.sessionId, mount.maxMessages)

    expect(mount.inspect).toHaveBeenCalledOnce()
    expect(mount.messageCut).toHaveBeenCalled()
    expect(snapshot.cursor).toBeGreaterThan(storedEnd)
    expect(snapshot.projections.asOfSeq).toBe(snapshot.cursor)
  })

  it('falls back when the window read itself fails', async () => {
    const mount = await mountSession()
    mount.readFrom.mockRejectedValueOnce(new Error('backend exploded'))
    const snapshot = await opening(mount.history, mount.sessionId, mount.maxMessages)

    expect(snapshot.records).toEqual(mount.records)
    expect(snapshot.projections).toEqual({
      asOfSeq: mount.projections.asOfSeq,
      values: mount.projections.values,
    })
    expect(mount.inspect).toHaveBeenCalledOnce()
  })

  it('serves a boundary-free log whose window reaches the log head', async () => {
    // No turn events at all and the window starts at seq 0, so the closed tail
    // is provable and the read proceeds.
    const mount = await mountSession({ turns: 0, userMessagesOnly: 12, maxMessages: 4 })
    const snapshot = await opening(mount.history, mount.sessionId, mount.maxMessages)

    expect(snapshot.records).toEqual(mount.records)
    expect(snapshot.hasMore).toBe(mount.hasMore)
    expect(snapshot.cursor).toBe(mount.cursor)
    expect(snapshot.projections).toEqual({
      asOfSeq: mount.projections.asOfSeq,
      values: mount.projections.values,
    })
    expect(mount.readFrom.mock.calls[0]?.[1]).toBe(0)
    expect(mount.inspect).not.toHaveBeenCalled()
  })

  it('proves a boundary-free tail by reading through to the log head', async () => {
    // A log with no turn events at all: the shallow window cannot tell a closed
    // tail from one whose boundary sits above its start, so the plan retries
    // from the log head, where the whole log proves it. The checkpoint was
    // folded from this same log, so its floor is real rather than the
    // "nothing to seed" bail.
    const mount = await mountSession({ turns: 0, userMessagesOnly: 200 })
    const snapshot = await opening(mount.history, mount.sessionId, mount.maxMessages)

    expect(mount.readFrom.mock.calls[0]?.[1]).toBeGreaterThan(0)
    expect(mount.readFrom.mock.calls.at(-1)?.[1]).toBe(0)
    expect(snapshot.records[0]?.event.seq).toBe(0)
    expect(snapshot.records.at(-1)?.event.seq).toBe(snapshot.cursor)
    expect(snapshot.projections).toEqual({
      asOfSeq: mount.projections.asOfSeq,
      values: mount.projections.values,
    })
    expect(mount.inspect).not.toHaveBeenCalled()
  })

  it('keeps the subagent fence for a child addressed as an ordinary Session', async () => {
    const mount = await mountSession()
    mount.readFrom.mockResolvedValueOnce({
      meta: { ...mount.meta, parentSession: sid('open-window-parent'), origin: 'subagent' },
      inheritedEventCount: SessionLogOffset(0),
      events: mount.events,
    })

    await expect(opening(mount.history, mount.sessionId, mount.maxMessages)).rejects.toMatchObject({
      code: 'session/agent-busy',
    })
    expect(mount.inspect).not.toHaveBeenCalled()
  })

  it('streams an append after the windowed opening through the real controller', async () => {
    const mount = await mountSession()
    // The gateway's own controller owns the follow request; the mount that
    // publishes the append happens later, off this opening path.
    const gateway = createSessionTestRemote(mount.ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/proj',
    })
    const abort = new AbortController()
    const iterator = gateway.follow({ address: { kind: 'session', sessionId: mount.sessionId } }, abort.signal)
      [Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done || first.value.type !== 'snapshot') throw new Error('follow did not open with a snapshot')
    expect(first.value.cursor).toBe(mount.cursor)

    // A later append continues at the snapshot cursor and reaches the open
    // generation without a gap.
    const appended = {
      type: 'turn/start' as const,
      seq: SessionSeq(mount.cursor + 1),
      time: mount.cursor + 1,
      data: { turn: 61 },
    } as SessionEvent
    mount.ctx.emit('session/event', mountingSession(mount, [appended]), appended)

    expect((await iterator.next()).value).toMatchObject({ type: 'event', event: { seq: mount.cursor + 1 } })
    abort.abort()
    await iterator.return?.()
  })
})

describe('indexed suffix window', () => {
  /** A 60-turn log whose events are dense from seq 0. */
  function storedLog(): SessionEvent[] {
    const events: SessionEvent[] = []
    for (let turn = 1; turn <= 60; turn++) {
      events.push({ type: 'turn/start', seq: SessionSeq(events.length), time: events.length, data: { turn } })
      events.push({
        type: 'user/message',
        seq: SessionSeq(events.length),
        time: events.length,
        data: createUserMessage({ content: [{ type: 'text', text: `q${String(turn)}` }], source: { kind: 'user' } }),
        surfaceOp: 'append',
      })
      events.push({ type: 'turn/end', seq: SessionSeq(events.length), time: events.length, data: { turn, reason: { kind: 'completed' } } })
    }
    return events
  }

  it('restarts the read at a projection floor below the shallow window', async () => {
    const sessionId = sid('indexed-floor')
    const events = storedLog()
    const cursor = events.at(-1)?.seq ?? -1
    const meta: SessionHeader = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, cwd: '/proj', isSeeded: false }
    const persisted: SeekablePersistence = {
      ...canSeek,
      messageCut: (_id, maxMessages) => {
        const prompts = events.filter(event => event.type === 'user/message')
        return Promise.resolve(prompts.slice(-maxMessages)[0]?.seq)
      },
      readFrom: (_id, fromSeq) => Promise.resolve({
        meta,
        inheritedEventCount: SessionLogOffset(0),
        events: events.filter(event => event.seq >= fromSeq),
      }),
    }
    const readFrom = vi.spyOn(persisted, 'readFrom')
    const floor = 12

    const read = await readIndexedSuffix(persisted, {
      id: sessionId,
      maxMessages: 4,
      beforeSeq: undefined,
      windowFloor: () => floor,
    }, () => {}, new AbortController().signal)

    if (read === undefined) throw new Error('indexed read bailed')
    const expected = paginateSuffix(events, undefined, 4, cursor)
    const shallow = promptsCut(events, 4) - 128
    expect(readFrom.mock.calls.map(call => call[1])).toEqual([shallow, floor])
    expect(read.fromSeq).toBe(floor)
    expect(read.throughSeq).toBe(cursor)
    expect(read.page.events).toEqual(expected.events)
    expect(read.page.hasMore).toBe(expected.hasMore)
  })
  it('retries past a window head that truncates the cut turn, and bails when it cannot', async () => {
    // A prompt deep inside its own turn: a window whose head lands after the
    // turn's opening events must not serve the page, or the client renders an
    // unfolded head turn.
    const deepTurnLog = (fill: number): SessionEvent[] => [
      { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } },
      ...Array.from({ length: fill }, (_, index): SessionEvent => ({
        type: 'model/selection',
        seq: SessionSeq(index + 1),
        time: index + 1,
        data: { provider: 'p', model: 'm' },
      })),
      {
        type: 'user/message',
        seq: SessionSeq(fill + 1),
        time: fill + 1,
        data: createUserMessage({ content: [{ type: 'text', text: 'deep' }], source: { kind: 'user' } }),
        surfaceOp: 'append',
      },
      { type: 'turn/end', seq: SessionSeq(fill + 2), time: fill + 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const seek = (events: SessionEvent[], reads: number[], cut: number): SeekablePersistence => ({
      ...canSeek,
      messageCut: () => Promise.resolve(cut),
      readFrom: (_id, fromSeq) => {
        reads.push(fromSeq)
        // A third read means the ladder's one-deep-retry cap is gone: answer a
        // foreign Session so that mutation fails its assertions instead of
        // spinning a microtask loop that starves the test file's timers.
        const runaway = reads.length > 2
        return Promise.resolve({
          meta: {
            version: SESSION_FORMAT_VERSION,
            id: runaway ? sid('indexed-runaway') : sessionId,
            createdAt: 1,
            cwd: '/proj',
            isSeeded: false,
          },
          inheritedEventCount: SessionLogOffset(0),
          events: runaway ? [] : events.filter(event => event.seq >= fromSeq),
        })
      },
    })

    const sessionId = sid('indexed-truncated-turn')
    // The shallow window starts inside the turn, so the deep retry serves a page
    // that opens on the turn's own start.
    const shortReads: number[] = []
    const short = deepTurnLog(150)
    const served = await readIndexedSuffix(
      seek(short, shortReads, 151),
      { id: sessionId, maxMessages: 1, beforeSeq: undefined },
      () => {},
      new AbortController().signal,
    )
    if (served === undefined) throw new Error('indexed read bailed')
    expect(served.page.events[0]).toMatchObject({ type: 'turn/start', seq: 0 })
    expect(served.page.events.at(-1)?.seq).toBe(152)
    expect(shortReads).toEqual([shortReads[0], 0])
    expect(shortReads[0]).toBeGreaterThan(0)

    // A turn longer than the deep margin cannot be recovered, so the read bails
    // and the observation path answers with the same page.
    const longReads: number[] = []
    const long = deepTurnLog(5000)
    await expect(readIndexedSuffix(
      seek(long, longReads, 5001),
      { id: sessionId, maxMessages: 1, beforeSeq: undefined },
      () => {},
      new AbortController().signal,
    )).resolves.toBeUndefined()
    expect(longReads).toHaveLength(2)
    expect(longReads[1]).toBeLessThan(longReads[0] as number)
  })

  it('lowers the deep retry to a projection floor above the shallow window', async () => {
    // A log whose suffix holds fewer prompted messages than one page, with a
    // checkpoint floor far behind the requested cut: the retry starts at the
    // floor instead of the deep margin.
    const sessionId = sid('indexed-floor-retry')
    const events: SessionEvent[] = []
    for (let index = 0; index < 4300; index++) {
      events.push({ type: 'model/selection', seq: SessionSeq(index), time: index, data: { provider: 'p', model: 'm' } })
    }
    events.push({
      type: 'user/message',
      seq: SessionSeq(4300),
      time: 4300,
      data: createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }),
      surfaceOp: 'append',
    })
    const reads: number[] = []
    const meta: SessionHeader = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, cwd: '/proj', isSeeded: false }
    const persisted: SeekablePersistence = {
      ...canSeek,
      messageCut: () => Promise.resolve(4300),
      readFrom: (_id, fromSeq) => {
        reads.push(fromSeq)
        // The floor keeps the restart above seq 0, so the three reads this case
        // expects are all the ladder can make before its cap ends it: answer a
        // foreign Session afterwards, so a removed cap fails the length check
        // below instead of spinning a microtask loop that starves the file.
        if (reads.length > 3) {
          return Promise.resolve({
            meta: { ...meta, id: sid('indexed-runaway') },
            inheritedEventCount: SessionLogOffset(0),
            events: [],
          })
        }
        return Promise.resolve({ meta, inheritedEventCount: SessionLogOffset(0), events: events.filter(event => event.seq >= fromSeq) })
      },
    }

    await expect(readIndexedSuffix(
      persisted,
      { id: sessionId, maxMessages: 4, beforeSeq: undefined, windowFloor: () => 100 },
      () => {},
      new AbortController().signal,
    )).resolves.toBeUndefined()
    // Shallow start, the floor restart, then the deep retry capped at that
    // floor (the deep margin lies behind it).
    expect(reads).toHaveLength(3)
    expect(reads[0]).toBeGreaterThan(100)
    expect(reads[1]).toBe(100)
    expect(reads[2]).toBe(100)
  })

  it('probes the window capability before any cut or read', async () => {
    // The gate runs first: a backend that cannot address a bounded window must
    // not pay a cut query or a suffix read at all.
    const sessionId = sid('indexed-unaddressable')
    const messageCut = vi.fn(() => Promise.resolve(0))
    const readFrom: Mock<(id: SessionId, fromSeq: number) => Promise<{
      meta: SessionHeader
      inheritedEventCount: SessionLogOffset
      events: SessionEvent[]
    }>> = vi.fn(() => Promise.resolve({
      meta: { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, cwd: '/proj', isSeeded: false },
      inheritedEventCount: SessionLogOffset(0),
      events: [] as SessionEvent[],
    }))

    await expect(readIndexedSuffix({
      seekable: () => Promise.resolve(false),
      messageCut,
      readFrom,
    }, {
      id: sessionId,
      maxMessages: 4,
      beforeSeq: undefined,
    }, () => {}, new AbortController().signal)).resolves.toBeUndefined()
    expect(messageCut).not.toHaveBeenCalled()
    expect(readFrom).not.toHaveBeenCalled()
  })

  it('gives up after one deep retry when the window can never hold a page', async () => {
    // The ladder is bounded: a window short of a full page retries once at the
    // deep margin, then bails instead of looping. The cut sits far enough out
    // that the retry start stays above seq 0, so only the attempt cap ends the
    // ladder (a runaway would otherwise keep reading the same window forever).
    const sessionId = sid('indexed-bounded-retry')
    const events: SessionEvent[] = Array.from({ length: 5000 }, (_, index): SessionEvent => ({
      type: 'model/selection',
      seq: SessionSeq(index),
      time: index,
      data: { provider: 'p', model: 'm' },
    }))
    events.push({
      type: 'user/message',
      seq: SessionSeq(5000),
      time: 5000,
      data: createUserMessage({ content: [{ type: 'text', text: 'only' }], source: { kind: 'user' } }),
      surfaceOp: 'append',
    })
    const meta: SessionHeader = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, cwd: '/proj', isSeeded: false }
    const suffix = async (_id: SessionId, fromSeq: number) => ({
      meta,
      inheritedEventCount: SessionLogOffset(0),
      events: events.filter(event => event.seq >= fromSeq),
    })
    const readFrom: Mock<(id: SessionId, fromSeq: number) => Promise<{
      meta: SessionHeader
      inheritedEventCount: SessionLogOffset
      events: SessionEvent[]
    }>> = vi.fn()
      .mockImplementationOnce(suffix)
      .mockImplementationOnce(suffix)
      // Any further read is a mutation symptom: answer a different Session so a
      // runaway ladder fails the assertion below instead of hanging the suite.
      .mockImplementation(async () => ({
        meta: { ...meta, id: sid('indexed-runaway') },
        inheritedEventCount: SessionLogOffset(0),
        events: [],
      }))

    await expect(readIndexedSuffix(
      { ...canSeek, messageCut: () => Promise.resolve(5000), readFrom },
      { id: sessionId, maxMessages: 4, beforeSeq: undefined },
      () => {},
      new AbortController().signal,
    )).resolves.toBeUndefined()
    expect(readFrom).toHaveBeenCalledTimes(2)
    const [shallow, deep] = readFrom.mock.calls.map(call => call[1])
    expect(shallow).toBeGreaterThan(0)
    expect(deep).toBeGreaterThan(0)
    expect(deep).toBeLessThan(shallow as number)
  })

  it('bails when a restarted read answers another session', async () => {
    const sessionId = sid('indexed-restart-mismatch')
    const events = storedLog()
    const meta: SessionHeader = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, cwd: '/proj', isSeeded: false }
    const reads: number[] = []
    const persisted: SeekablePersistence = {
      ...canSeek,
      messageCut: (_id, maxMessages) => {
        const prompts = events.filter(event => event.type === 'user/message')
        return Promise.resolve(prompts.slice(-maxMessages)[0]?.seq)
      },
      readFrom: (_id, fromSeq) => {
        reads.push(fromSeq)
        // Every read after the first answers a different Session: the restart
        // and the deep retry both soft-bail instead of serving page events.
        return Promise.resolve(reads.length === 1
          ? { meta, inheritedEventCount: SessionLogOffset(0), events: events.filter(event => event.seq >= fromSeq) }
          : { meta: { ...meta, id: sid('another-session') }, inheritedEventCount: SessionLogOffset(0), events: [] })
      },
    }

    await expect(readIndexedSuffix(persisted, {
      id: sessionId,
      maxMessages: 4,
      beforeSeq: undefined,
      windowFloor: () => 12,
    }, () => {}, new AbortController().signal)).resolves.toBeUndefined()
    expect(reads).toEqual([promptsCut(events, 4) - 128, 12])

    // A window that cannot hold the page retries at the deep margin, then bails
    // on the mismatched identity the same way.
    reads.length = 0
    const shortWindow = { meta, inheritedEventCount: SessionLogOffset(0), events: [] as SessionEvent[] }
    const deepPersisted: SeekablePersistence = {
      ...canSeek,
      messageCut: () => Promise.resolve(promptsCut(events, 4)),
      readFrom: (_id, fromSeq) => {
        reads.push(fromSeq)
        return Promise.resolve(reads.length === 1
          ? shortWindow
          : { meta: { ...meta, id: sid('another-session') }, inheritedEventCount: SessionLogOffset(0), events: [] })
      },
    }

    await expect(readIndexedSuffix(deepPersisted, {
      id: sessionId,
      maxMessages: 4,
      beforeSeq: undefined,
    }, () => {}, new AbortController().signal)).resolves.toBeUndefined()
    expect(reads.length).toBe(2)
  })
})

/** The seq of the `maxMessages`-th-from-end append-origin prompt, as the backend seeks it. */
function promptsCut(events: readonly SessionEvent[], maxMessages: number): number {
  const prompts = events.filter(event => event.type === 'user/message')
  return prompts.slice(-maxMessages)[0]?.seq ?? 0
}
