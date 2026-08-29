/** Cold Session history pagination and live-event source. */

import type { Context } from '@deepseek-ai/cordis'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import { isChunkRow, packChunkRuns, type ChunkRow } from '@deepseek-ai/dsh-session/chunk-rows'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-subagent'
import { TypertRemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type {
  SessionAddress,
  SessionChunkRun,
  SessionEventEntry,
  SessionFollowRequest,
  SessionFollowFrame,
  SessionHistoryRecord,
  SessionPage,
  SessionPageRequest,
  SessionProjectionBaseline,
  SessionProjectionValues,
  SessionWireEvent,
} from './types.ts'

const DEFAULT_MAX_MESSAGES = 50
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

/**
 * Headroom read before a message-indexed cut: the cut seqs an append-origin
 * user message while the page cut lands at its group head (turn boundary and
 * any source events a few seqs earlier). The margin covers the ordinary lead
 * without re-reading a whole window; a longer lead fails the completeness
 * check and falls back to the full observation path.
 */
const PAGE_CUT_LEAD_MARGIN = 128

/** The optional indexed-seek persistence surface behind the page fast path. */
interface SeekablePersistence {
  messageCut(id: SessionId, maxMessages: number, beforeSeq?: number, signal?: AbortSignal): Promise<number | undefined>
  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }>
}

/** Implements cold-safe history operations delegated by the Session Controller. */
export class SessionHistoryController {
  private readonly closeFollowers = new Set<() => void>()

  /**
   * @param ctx - Host context carrying Session query and projection services.
   * @param promote - starts ordinary Session activation after snapshot delivery.
   */
  constructor(
    private readonly ctx: Context,
    private readonly promote: (observation: SessionObservation) => void,
  ) {
    ctx.effect(() => () => {
      for (const close of this.closeFollowers) close()
      this.closeFollowers.clear()
    }, 'session-controller.history')
  }

  /**
   * Read one message-aligned history page without activating an Agent.
   * @param request - durable address and backwards-page cursor.
   * @param signal - caller cancellation for persistence reads.
   * @returns a contiguous event page.
   */
  async page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage> {
    validatePageRequest(request)
    const indexed = await this.tryIndexedPage(request, signal)
    if (indexed !== undefined) return indexed
    using source = await this.sourceFor(request.address, signal, false)
    signal.throwIfAborted()
    const sourceLog = source.events
    const sourceCursor = sourceLog.at(-1)?.seq ?? -1
    if (request.throughSeq > sourceCursor) {
      reject(
        'bad-request',
        `session page through seq ${String(request.throughSeq)} is past cursor ${String(sourceCursor)}`,
        {},
      )
    }
    /* v8 ignore next -- Session and persistence validation guarantee a dense zero-based event prefix. */
    if (request.throughSeq >= 0 && sourceLog[request.throughSeq]?.seq !== request.throughSeq) {
      reject('internal', `session log does not contain through seq ${String(request.throughSeq)}`, {})
    }
    const page = paginate(
      sourceLog,
      request.beforeSeq,
      request.maxMessages ?? DEFAULT_MAX_MESSAGES,
      request.throughSeq,
    )
    const records = pageRecords(page.events)
    return {
      records,
      hasMore: page.hasMore,
    }
  }

  /**
   * Follow events appended after an initial cursor on one durable address.
   * @param request - durable address and last committed sequence already held by the caller.
   * @param signal - stream cancellation owned by the Remote carrier.
   * @returns a complete opening snapshot followed by gap-free event frames.
   */
  async *follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    validateFollowRequest(request)
    const { address } = request
    const target = addressId(address)
    const buffered: SessionEvent[] = []
    let snapshotCursor: number | undefined
    let wake: (() => void) | undefined
    const notify = (): void => {
      const resume = wake
      wake = undefined
      resume?.()
    }
    const follower = { closed: false }
    const close = (): void => {
      follower.closed = true
      notify()
    }
    this.closeFollowers.add(close)
    const disposeEvent = this.ctx.on('session/event', (session, event) => {
      if (session.id !== target) return
      buffered.push(event)
      notify()
    }, { global: true })
    const disposeCreated = this.ctx.on('session/created', (session) => {
      if (session.id !== target) return
      // Constructor seed events have no session/event notification. Normally
      // only the end-seed suffix is new; if persistence advanced after the
      // opening observation, replay everything beyond that snapshot cursor.
      const suffix = session.events.slice(snapshotCursor === undefined
        ? session.firstLiveSeq
        : snapshotCursor + 1)
      buffered.unshift(...suffix)
      notify()
    }, { global: true })
    const onAbort = (): void => { notify() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      using source = await this.sourceFor(address, signal, true)
      const events = source.events
      signal.throwIfAborted()
      const cursor = source.cursor
      snapshotCursor = cursor
      const page = paginate(events, undefined, request.maxMessages ?? DEFAULT_MAX_MESSAGES)
      yield {
        type: 'snapshot',
        header: source.header,
        cursor,
        records: pageRecords(page.events),
        hasMore: page.hasMore,
        projections: source.projections === undefined
          ? { asOfSeq: cursor, values: {} }
          : projectionBlock(source.projections),
      }
      if (address.kind === 'session' && source.source === 'prepared') {
        const promotion = source.retain()
        try {
          this.promote(promotion)
        } catch (error: unknown) {
          promotion[Symbol.dispose]()
          throw error
        }
      }
      let nextSeq = cursor + 1
      while (!follower.closed && !signal.aborted) {
        const item = buffered.shift()
        if (item === undefined) {
          await new Promise<void>((resolve) => { wake = resolve })
          continue
        }
        if (item.seq < nextSeq) continue
        if (item.seq !== nextSeq) {
          reject('internal', `session event stream skipped seq ${String(nextSeq)}`, {})
        }
        nextSeq++
        yield entryFor(item)
      }
    } finally {
      this.closeFollowers.delete(close)
      signal.removeEventListener('abort', onAbort)
      disposeCreated()
      disposeEvent()
    }
  }

  /**
   * Indexed-seek fast path for ordinary Session pages: the persistence
   * backend answers the maxMessages-th append-origin user message below the
   * page end in one indexed scan (~3ms on SQLite), so the page reads only
   * its minimal suffix instead of observing the whole log. Subagent pages
   * need catalog projections and stay on the observation path. Returns
   * undefined whenever the backend cannot answer or the suffix does not
   * provably hold a complete page — the caller then falls back to the full
   * observation path.
   */
  private async tryIndexedPage(
    request: SessionPageRequest,
    signal: AbortSignal,
  ): Promise<SessionPage | undefined> {
    if (request.address.kind !== 'session') return undefined
    const persistence = this.ctx.get('sessionPersistence') as SeekablePersistence | undefined
    if (persistence?.messageCut === undefined || persistence.readFrom === undefined) return undefined
    const id = addressId(request.address)
    const maxMessages = request.maxMessages ?? DEFAULT_MAX_MESSAGES
    const end = request.throughSeq >= 0
      ? Math.min(request.throughSeq + 1, request.beforeSeq ?? request.throughSeq + 1)
      : request.beforeSeq
    try {
      const cut = await persistence.messageCut(id, maxMessages, end, signal)
      signal.throwIfAborted()
      if (cut === undefined) return undefined
      const fromSeq = Math.max(0, cut - PAGE_CUT_LEAD_MARGIN)
      const suffix = await persistence.readFrom(id, fromSeq, signal)
      signal.throwIfAborted()
      if (suffix.meta.id !== id) return undefined
      if (suffix.meta.cwd === undefined) rejectNotFound(request.address)
      validateAddress(request.address, suffix.meta, undefined)
      if (request.throughSeq > (suffix.events.at(-1)?.seq ?? -1)) {
        reject(
          'bad-request',
          `session page through seq ${String(request.throughSeq)} is past cursor ${String(suffix.events.at(-1)?.seq ?? -1)}`,
          {},
        )
      }
      if (request.throughSeq >= 0 && !suffix.events.some(event => event.seq === request.throughSeq)) {
        reject('internal', `session log does not contain through seq ${String(request.throughSeq)}`, {})
      }
      const page = paginateSuffix(suffix.events, request.beforeSeq, maxMessages, request.throughSeq)
      // The window provably holds the page only when the cut lands inside the
      // read suffix; otherwise the caller re-reads the whole observation.
      if (!(page.cut >= fromSeq && page.messages >= maxMessages)) return undefined
      return {
        records: pageRecords(page.events),
        hasMore: page.hasMore,
      }
    } catch (error: unknown) {
      // The fast path is an optimization: any failure — including a generic
      // not-found from readFrom — re-runs through the observation path, which
      // owns the request's error mapping and subagent validation.
      if (error instanceof TypertRemoteFailure) throw error
      return undefined
    }
  }

  private async sourceFor(
    address: SessionAddress,
    signal: AbortSignal,
    withProjections: boolean,
  ): Promise<SessionObservation> {
    const sessionId = addressId(address)
    try {
      const observation = await this.ctx.sessionQuery.observeSession(sessionId, {
        signal,
        projectionMode: withProjections || address.kind === 'subagent' ? 'all' : 'none',
      })
      if (observation.header.cwd === undefined) {
        observation[Symbol.dispose]()
        rejectNotFound(address)
      }
      try {
        validateAddress(address, observation.header, observation.projections)
      } catch (error: unknown) {
        observation[Symbol.dispose]()
        throw error
      }
      return observation
    } catch (error: unknown) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') rejectNotFound(address)
      throw error
    }
  }

}

function projectionBlock(
  snapshot: NonNullable<SessionObservation['projections']>,
): SessionProjectionBaseline {
  return {
    asOfSeq: snapshot.asOfSeq,
    // Projection definitions validate whole JSON values before snapshot publication.
    values: snapshot.values as SessionProjectionValues,
  }
}

function validatePageRequest(request: SessionPageRequest): void {
  if (!Number.isSafeInteger(request.throughSeq) || request.throughSeq < -1) {
    reject('bad-request', 'throughSeq must be an integer greater than or equal to -1', {})
  }
  if (request.beforeSeq !== undefined
    && (!Number.isSafeInteger(request.beforeSeq) || request.beforeSeq < 0)) {
    reject('bad-request', 'beforeSeq must be a non-negative safe integer', {})
  }
  if (request.maxMessages !== undefined
    && (!Number.isSafeInteger(request.maxMessages) || request.maxMessages <= 0)) {
    reject('bad-request', 'maxMessages must be a positive safe integer', {})
  }
}

function validateFollowRequest(request: SessionFollowRequest): void {
  if (request.maxMessages !== undefined
    && (!Number.isSafeInteger(request.maxMessages) || request.maxMessages <= 0)) {
    reject('bad-request', 'maxMessages must be a positive safe integer', {})
  }
}

function addressId(address: SessionAddress): SessionId {
  return address.kind === 'session' ? address.sessionId : address.childSessionId
}

/**
 * Backwards message walk shared by BOTH paging paths, so the indexed fast
 * path and the observation fallback can never disagree on a boundary. User
 * messages anchor pages — every page starts at a turn's opening user message
 * and its provenance group head — with a whole-window fallback to any
 * message for synthetic logs that carry no user messages. Each chosen
 * message widens its cut through `sourceEventSeqs`, so pages never split a
 * replacement or provenance group.
 *
 * @param window - Events in seq order (a dense log or an already-filtered
 * suffix read).
 * @param maxMessages - Page size in user messages (fallback: any message).
 * @param endIndex - Exclusive walk bound: the dense log passes the seq end
 * (index === seq), the suffix read passes its own length.
 * @returns The cut seq (0 when the window holds fewer than one full page)
 * and the chosen message count.
 */
function nthMessageCut(
  window: readonly SessionEvent[],
  maxMessages: number,
  endIndex = window.length,
): { readonly cut: number; readonly messages: number } {
  let userCount = 0
  let userCut = 0
  let anyCount = 0
  let anyCut = 0
  for (let index = Math.min(endIndex, window.length) - 1; index >= 0; index--) {
    const event = window[index] as SessionEvent
    if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event)) continue
    const sources = (event as { readonly sourceEventSeqs?: readonly number[] }).sourceEventSeqs
    let groupStart = event.seq
    if (sources !== undefined) {
      for (const source of sources) groupStart = Math.min(groupStart, source)
    }
    if (event.type === 'user/message') {
      userCount++
      // The cut pins only at the max-th user message; a window short of a
      // full page stays whole (cut 0) like the any-message fallback below.
      if (userCount === maxMessages) {
        userCut = groupStart
        break
      }
    }
    // The fallback candidate pins once at the max-th message from the end;
    // earlier messages never move it, matching the zero-user window's cut.
    anyCount++
    if (anyCount === maxMessages) anyCut = groupStart
  }
  return userCount > 0
    ? { cut: userCut, messages: userCount }
    : { cut: anyCut, messages: anyCount }
}

/**
 * Message-aligned pagination over a seq-indexed SUFFIX (the fast-path read
 * starts at a positive seq, so array indexes are not seqs — the observation
 * pagination's dense-index assumption does not transfer).
 */
function paginateSuffix(
  events: readonly SessionEvent[],
  beforeSeq: number | undefined,
  maxMessages: number,
  throughSeq: number,
): { readonly events: SessionEvent[]; readonly hasMore: boolean; readonly cut: number; readonly messages: number } {
  const end = Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1)
  const window = events.filter(event => event.seq < end)
  const chosen = nthMessageCut(window, maxMessages)
  return {
    events: window.filter(event => event.seq >= chosen.cut),
    hasMore: chosen.cut > 0,
    cut: chosen.cut,
    messages: chosen.messages,
  }
}

function validateAddress(
  address: SessionAddress,
  header: SessionHeader,
  projections: SessionObservation['projections'],
): void {
  if (address.kind === 'session') {
    if (header.origin === 'subagent') {
      reject('agent-busy', 'subagent Sessions require their durable parent address', {
        reason: 'use subagent delivery for this child session',
      })
    }
    return
  }
  if (header.origin !== 'subagent' || header.parentSession !== address.parentSessionId) {
    reject('subagent-unauthorized', 'subagent does not belong to the supplied parent', {
      childSessionId: address.childSessionId,
    })
  }
  const identity = projections?.values.subagent
  if (identity === null) {
    reject('subagent-catalog-diagnostic', 'subagent descriptor is corrupt', {
      parentSessionId: address.parentSessionId,
      childSessionId: address.childSessionId,
      reason: 'corrupt',
    })
  }
  if (identity === undefined || identity.seq < (header.seedLength ?? 0)) {
    reject('subagent-catalog-diagnostic', 'subagent descriptor is unavailable', {
      parentSessionId: address.parentSessionId,
      childSessionId: address.childSessionId,
      reason: 'unsupported',
    })
  }
  if (identity.mode !== address.mode) {
    reject('subagent-unauthorized', 'subagent mode does not match the supplied address', {
      childSessionId: address.childSessionId,
    })
  }
}

function rejectNotFound(address: SessionAddress): never {
  if (address.kind === 'session') {
    reject('session-not-found', `session "${address.sessionId}" not found`, { sessionId: address.sessionId })
  }
  reject('subagent-not-found', 'subagent is unavailable', {
    parentSessionId: address.parentSessionId,
    childSessionId: address.childSessionId,
  })
}

function reject(code: string, message: string, details: object): never {
  throw new TypertRemoteFailure({ code, message, details })
}

function paginate(
  events: readonly SessionEvent[],
  beforeSeq: number | undefined,
  maxMessages: number,
  throughSeq = events.at(-1)?.seq ?? -1,
): { readonly events: SessionEvent[]; readonly hasMore: boolean } {
  const end = Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1)
  // The observation log is dense (index === seq), so walking array indexes
  // below `end` scopes the same `seq < end` window the indexed suffix path
  // filters; one boundary rule serves both paths and they can never disagree
  // on a page cut.
  const chosen = nthMessageCut(events, maxMessages, end)
  return { events: events.slice(chosen.cut, end), hasMore: chosen.cut > 0 }
}

function entryFor(event: SessionEvent): SessionEventEntry {
  return {
    type: 'event',
    // Session.append validates and freezes event data as JSON before publication.
    event: event as unknown as SessionWireEvent,
  }
}

function chunkEntryFor(row: ChunkRow): SessionChunkRun {
  switch (row.type) {
    case 'text-chunks':
      return {
        type: 'chunks',
        event: { type: 'chunkrow/text-chunks', seq: row.seq0, time: row.time0, data: row.data },
      }
    case 'reasoning-chunks':
      return {
        type: 'chunks',
        event: { type: 'chunkrow/reasoning-chunks', seq: row.seq0, time: row.time0, data: row.data },
      }
    case 'tool-call-chunks':
      return {
        type: 'chunks',
        event: { type: 'chunkrow/tool-call-chunks', seq: row.seq0, time: row.time0, data: row.data },
      }
  }
}

/** Encode one bounded logical page without changing its pagination cut. */
function pageRecords(events: readonly SessionEvent[]): SessionHistoryRecord[] {
  return packChunkRuns(events).map(record => isChunkRow(record)
    ? chunkEntryFor(record)
    : entryFor(record))
}
