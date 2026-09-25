/** Cold Session history pagination and live-event source. */

import type { Context } from '@deepseek-ai/cordis'
import { Deque } from '@deepseek-ai/dsh-deque'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import {
  isAppendSurfaceEvent,
  SessionLogOffset,
  SessionSeq,
} from '@deepseek-ai/dsh-session'
// Fork patch (FORK_SURFACE.md): the indexed physical read behind both history
// fast paths lives in the fork-owned page-boundary module, which cuts every
// window with this file's own `paginate`; this file keeps the injections.
import { readIndexedPage, type SeekablePersistence, type WindowPageCut } from './fork/page-boundary.ts'
// Fork patch (FORK_SURFACE.md): the cold opening snapshot's windowed read lives
// in the fork-owned open-window module; this file keeps the try and its fallback.
import { readOpeningWindow, type OpeningWindow, type OpeningWindowServices } from './fork/open-window.ts'
import type {
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionLogOffset as SessionLogOffsetType,
  SessionSeqCursor,
} from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-subagent'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  SessionAddress,
  SessionAssistantStreamBaseline,
  SessionAssistantStreamFrame,
  SessionEventEntry,
  SessionFollowRequest,
  SessionFollowFrame,
  SessionHistoryRecord,
  SessionPage,
  SessionPageRequest,
  SessionProjectionBaseline,
  SessionProjectionValues,
  SessionWireHeader,
  SessionWireEvent,
} from './types.ts'
import { SessionAssistantStreamAccumulator } from './assistant-stream.ts'

const DEFAULT_MAX_MESSAGES = 50
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

// Fork patch (FORK_SURFACE.md): the seek surface both fork fast paths (the
// `page()`/`loadOlder` indexed page and the windowed opening) extract;
// binding it is what makes those paths reachable from a real provider.
/**
 * The mounted persistence's seek surface, with each method bound to the value
 * `ctx.get` answers.
 *
 * Cordis hands a service read from another fiber to its caller as a tracker
 * proxy, and a method taken off that proxy only restores the provider's own
 * `this` when it is called on the proxy itself (`vendor/cordis/src/utils.ts`,
 * `createShadowMethod`: the apply trap rebinds `thisArg` to the shadow only
 * when `thisArg === outer`). A wrapper object carrying the extracted methods
 * therefore calls them with the wrapper as `this`, which breaks every provider
 * whose methods read their own state.
 *
 * @param ctx - the context holding the mounted persistence.
 * @returns the bound surface, or undefined when the mounted persistence does
 *   not expose one (including a backend without the `seekable` gate, which the
 *   read plan calls before anything else).
 */
function seekSurface(ctx: Context): SeekablePersistence | undefined {
  const candidate = ctx.get('sessionPersistence') as Partial<SeekablePersistence> | undefined
  if (candidate === undefined) return undefined
  const { seekable, messageCut, readFrom } = candidate
  if (seekable === undefined || messageCut === undefined || readFrom === undefined) return undefined
  return {
    seekable: seekable.bind(candidate),
    messageCut: messageCut.bind(candidate),
    readFrom: readFrom.bind(candidate),
  }
}
/** Implements cold-safe history operations delegated by the Session Controller. */
export class SessionHistoryController {
  private readonly closeFollowers = new Set<() => void>()
  private readonly assistantStreams = new Map<SessionId, SessionAssistantStreamAccumulator>()

  /**
   * @param ctx - Host context carrying Session query and projection services.
   * @param promote - starts ordinary Session activation after snapshot delivery.
   */
  constructor(
    private readonly ctx: Context,
    private readonly promote: (observation: SessionObservation) => void,
  ) {
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      let stream = this.assistantStreams.get(agent.session.id)
      if (stream === undefined) {
        stream = new SessionAssistantStreamAccumulator()
        this.assistantStreams.set(agent.session.id, stream)
      }
      stream.accept(frame, cursorBeforeNext(agent.session.seq))
    }, { global: true })
    ctx.on('agent/disposed', ({ agent }) => {
      this.assistantStreams.delete(agent.session.id)
    }, { global: true })
    ctx.effect(() => () => {
      for (const close of this.closeFollowers) close()
      this.closeFollowers.clear()
    }, 'session-controller.history')
  }

  /**
   * Read one Turn-aligned history page without activating an Agent.
   * @param request - durable address and backwards-page cursor.
   * @param signal - caller cancellation for persistence reads.
   * @returns a contiguous event page.
   */
  async page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage> {
    validatePageRequest(request)
    const indexed = await this.tryIndexedPage(request, signal)
    if (indexed !== undefined) return indexed
    const throughSeq: SessionSeqCursor = request.throughSeq === -1
      ? -1
      : SessionSeq(request.throughSeq)
    const beforeSeq = request.beforeSeq === undefined
      ? undefined
      : SessionLogOffset(request.beforeSeq)
    using source = await this.sourceFor(request.address, signal, false)
    signal.throwIfAborted()
    const sourceLog = source.events
    const sourceCursor: SessionSeqCursor = sourceLog.at(-1)?.seq ?? -1
    if (throughSeq > sourceCursor) {
      throw new RemoteError(
        'gateway/bad-request',
        `session page through seq ${String(throughSeq)} is past cursor ${String(sourceCursor)}`,
        {},
      )
    }
    /* v8 ignore next -- Session and persistence validation guarantee a dense zero-based event prefix. */
    if (throughSeq >= 0 && sourceLog[throughSeq]?.seq !== throughSeq) {
      throw new RemoteError('gateway/internal', `session log does not contain through seq ${String(throughSeq)}`, {})
    }
    const page = paginate(
      sourceLog,
      beforeSeq,
      request.maxMessages ?? DEFAULT_MAX_MESSAGES,
      throughSeq,
      request.turnWindow,
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
   * @returns a complete opening snapshot followed by gap-free durable events and opted-in assistant frames.
   */
  async *follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    validateHistoryWindow(request)
    const { address } = request
    const target = addressId(address)
    const buffered = new Deque<
      | { readonly type: 'event'; readonly event: SessionEvent }
      | {
        readonly type: 'assistant-stream'
        readonly frame: SessionAssistantStreamFrame
        readonly ordinal: number
      }
    >()
    let snapshotCursor: SessionSeqCursor | undefined
    let assistantStreamOrdinal = 0
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
      buffered.pushBack({ type: 'event', event })
      notify()
    }, { global: true })
    const disposeCreated = this.ctx.on('session/created', (session) => {
      if (session.id !== target) return
      // Constructor seed events have no session/event notification. Normally
      // only the end-seed suffix is new; if persistence advanced after the
      // opening observation, replay everything beyond that snapshot cursor.
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const suffix = session.snapshotEvents(snapshotCursor === undefined
        ? session.firstLiveSeq
        : SessionLogOffset(snapshotCursor + 1))
      for (let index = suffix.length - 1; index >= 0; index -= 1) {
        buffered.pushFront({ type: 'event', event: suffix[index] as SessionEvent })
      }
      notify()
    }, { global: true })
    const disposeAssistantStream = request.assistantStream !== true
      ? undefined
      : this.ctx.on('agent/assistant-stream', ({ agent, frame }) => {
        if (agent.session.id !== target) return
        buffered.pushBack({
          type: 'assistant-stream',
          frame: wireAssistantStreamFrame(frame, cursorBeforeNext(agent.session.seq)),
          ordinal: ++assistantStreamOrdinal,
        })
        notify()
      }, { global: true })
    const onAbort = (): void => { notify() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      // Fork patch (FORK_SURFACE.md): a cold open reads one seekable suffix
      // window instead of the whole log (see src/fork/open-window.ts). The
      // synchronous service check keeps the observation sequence below
      // unchanged for every deployment without the fork seek surface.
      const windowServices = this.windowServices(address, target)
      const windowed = windowServices === undefined
        ? undefined
        : await this.tryWindowedOpen(request, windowServices, signal)
      let cursor: SessionSeqCursor
      let assistantStreamOrdinalCut: number
      if (windowed !== undefined) {
        cursor = windowed.cursor
        snapshotCursor = cursor
        // The accumulator snapshot and this watermark are synchronous. Frames
        // through the cut are represented or superseded by that baseline,
        // including larger revisions from a retired Agent; later revision
        // resets reach Client continuity validation.
        const assistantStream = this.assistantStreamBaseline(target, request.assistantStream === true)
        assistantStreamOrdinalCut = assistantStreamOrdinal
        yield {
          type: 'snapshot',
          header: wireHeader(windowed.header),
          cursor,
          records: pageRecords(windowed.events),
          hasMore: windowed.hasMore,
          projections: projectionBlock(windowed.projections),
          ...assistantStream === undefined ? {} : { assistantStream },
        }
      } else {
        using source = await this.sourceFor(address, signal, true)
        const events = source.events
        signal.throwIfAborted()
        cursor = source.cursor
        snapshotCursor = cursor
        const page = paginate(events, undefined, request.maxMessages ?? DEFAULT_MAX_MESSAGES, cursor, request.turnWindow)
        // See the windowed branch: the baseline and its watermark are one
        // synchronous read after the source settles.
        const assistantStream = this.assistantStreamBaseline(target, request.assistantStream === true)
        assistantStreamOrdinalCut = assistantStreamOrdinal
        yield {
          type: 'snapshot',
          header: wireHeader(source.header),
          cursor,
          records: pageRecords(page.events),
          hasMore: page.hasMore,
          projections: source.projections === undefined
            ? { asOfSeq: cursor, values: {} }
            : projectionBlock(source.projections),
          ...assistantStream === undefined ? {} : { assistantStream },
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
      }
      let nextOffset = SessionLogOffset(cursor + 1)
      while (!follower.closed && !signal.aborted) {
        const item = buffered.popFront()
        if (item === undefined) {
          await new Promise<void>((resolve) => { wake = resolve })
          continue
        }
        if (item.type === 'assistant-stream') {
          if (item.ordinal > assistantStreamOrdinalCut) {
            yield { type: 'assistant-stream', frame: item.frame }
          }
          continue
        }
        const expectedSeq = SessionSeq(nextOffset)
        if (item.event.seq < expectedSeq) continue
        if (item.event.seq !== expectedSeq) {
          throw new RemoteError('gateway/internal', `session event stream skipped seq ${String(expectedSeq)}`, {})
        }
        nextOffset = SessionLogOffset(nextOffset + 1)
        yield entryFor(item.event)
      }
    } finally {
      this.closeFollowers.delete(close)
      signal.removeEventListener('abort', onAbort)
      disposeCreated()
      disposeEvent()
      disposeAssistantStream?.()
    }
  }

  /**
   * Indexed-seek fast path for ordinary Session pages: the persistence
   * backend answers the page floor's append-origin user message (the turn
   * window's `minMessages`, else the request's cap) below the page end in one
   * indexed scan (~3ms on SQLite), so the page reads only the suffix that
   * holds it instead of observing the whole log. Subagent pages
   * need catalog projections and stay on the observation path. Returns
   * undefined whenever the backend cannot answer or the suffix does not
   * provably hold the page the observation path cuts — the caller then falls
   * back to the full observation path.
   */
  private async tryIndexedPage(
    request: SessionPageRequest,
    signal: AbortSignal,
  ): Promise<SessionPage | undefined> {
    if (request.address.kind !== 'session') return undefined
    const persistence = seekSurface(this.ctx)
    if (persistence === undefined) return undefined
    try {
      const page = await readIndexedPage(persistence, {
        id: addressId(request.address),
        // Fork patch (FORK_SURFACE.md): the client's turn window carries the page
        // floor; `maxMessages` is only the cap the observation path also applies.
        seedMessages: request.turnWindow?.minMessages ?? request.maxMessages ?? DEFAULT_MAX_MESSAGES,
        beforeSeq: request.beforeSeq,
        throughSeq: request.throughSeq,
      },
      // Fork patch (FORK_SURFACE.md): the window is cut by this file's own
      // `paginate`, so the indexed read serves the observation page.
      this.windowCut(request.beforeSeq, request.maxMessages ?? DEFAULT_MAX_MESSAGES, request.turnWindow),
      (meta, events, readEnd, storedEnd) => {
        if (meta.cwd === undefined) rejectNotFound(request.address)
        validateAddress(request.address, meta, SessionLogOffset(0), undefined)
        // A read bounded below the request cursor serves an older page: the
        // bound keeps the read's own tail below the cursor, so the released
        // cursor checks run against the stored end this read observed instead.
        // The stored rows are a dense zero-based prefix, so a cursor at or
        // below that end is present and one above it is past the log.
        if (readEnd !== undefined && readEnd <= request.throughSeq) {
          if ((events.at(-1)?.seq ?? -1) >= readEnd) {
            throw new RemoteError(
              'gateway/internal',
              `session page read reached past its bound ${String(readEnd)}`,
              {},
            )
          }
          // A provider still implementing the released three-argument
          // `readFrom(id, fromSeq, signal?)` receives the bound as its signal
          // and reports no observed end: the request fails loud instead of
          // being answered from a cursor nothing validated.
          if (storedEnd === undefined) {
            throw new RemoteError('gateway/internal', 'session page read did not report its stored end', {})
          }
          if (request.throughSeq > storedEnd) {
            throw new RemoteError(
              'gateway/bad-request',
              `session page through seq ${String(request.throughSeq)} is past cursor ${String(storedEnd)}`,
              {},
            )
          }
          /* v8 ignore next 3 -- the stored rows are a dense zero-based prefix,
             so every seq at or below `storedEnd` exists; the released absence
             rejection is kept for an end reported above a gap. */
          if (request.throughSeq >= 0 && storedEnd < request.throughSeq) {
            throw new RemoteError('gateway/internal', `session log does not contain through seq ${String(request.throughSeq)}`, {})
          }
          return
        }
        if (request.throughSeq > (events.at(-1)?.seq ?? -1)) {
          throw new RemoteError(
            'gateway/bad-request',
            `session page through seq ${String(request.throughSeq)} is past cursor ${String(events.at(-1)?.seq ?? -1)}`,
            {},
          )
        }
        if (request.throughSeq >= 0 && !events.some(event => event.seq === request.throughSeq)) {
          throw new RemoteError('gateway/internal', `session log does not contain through seq ${String(request.throughSeq)}`, {})
        }
      }, signal)
      if (page === undefined) return undefined
      return { records: pageRecords(page.events), hasMore: page.hasMore }
    } catch (error: unknown) {
      // The fast path is an optimization: any failure — including a generic
      // not-found from readFrom — re-runs through the observation path, which
      // owns the request's error mapping and subagent validation.
      if (error instanceof RemoteError) throw error
      return undefined
    }
  }

  /**
   * Fork patch (FORK_SURFACE.md): the opening-snapshot fast path — one
   * seekable suffix window when the mounted persistence exposes the indexed
   * seek surface and the projection cache holds a fold shortcut for the
   * Session (see src/fork/open-window.ts). Subagent addresses, an attached
   * Session, a missing seek surface or checkpoint, and every window the fast
   * path cannot prove return undefined for the observation fallback below.
   * @param request - the addressed opening request.
   * @param services - the resolved seekable persistence, cache, and registry.
   * @param signal - stream cancellation owned by the Remote carrier.
   * @returns the windowed opening snapshot, or undefined for the fallback.
   */
  private async tryWindowedOpen(
    request: SessionFollowRequest,
    services: OpeningWindowServices,
    signal: AbortSignal,
  ): Promise<OpeningWindow | undefined> {
    const { address } = request
    const sessionId = addressId(address)
    try {
      const windowed = await readOpeningWindow(
        services,
        // Fork patch (FORK_SURFACE.md): the client's turn window carries the page
        // floor; `maxMessages` is only the cap the observation path also applies.
        { sessionId, seedMessages: request.turnWindow?.minMessages ?? request.maxMessages ?? DEFAULT_MAX_MESSAGES },
        // Fork patch (FORK_SURFACE.md): the opening window is cut by this file's
        // own `paginate` under the request's turn window, exactly as the
        // observation branch below cuts it.
        this.windowCut(undefined, request.maxMessages ?? DEFAULT_MAX_MESSAGES, request.turnWindow),
        (meta, _events) => {
          if (meta.cwd === undefined) rejectNotFound(address)
          validateAddress(address, meta, SessionLogOffset(0), undefined)
        },
        signal,
      )
      // An attach raced the window read: the store is authoritative now, and
      // the observation path picks it up.
      if (windowed !== undefined && this.ctx.sessions.get(sessionId) !== undefined) return undefined
      return windowed
    } catch (error: unknown) {
      // The fast path is an optimization: any failure — including a generic
      // not-found from readFrom — re-runs through the observation path, which
      // owns the request's error mapping and subagent validation.
      if (error instanceof RemoteError) throw error
      return undefined
    }
  }

  /**
   * Fork patch (FORK_SURFACE.md): the page rule the indexed fast paths cut a
   * read window with — this file's own `paginate`, bound to the request's page
   * size, page-before bound, and turn window. One rule for both paths is what
   * keeps an indexed suffix read and the whole-log observation serving the same
   * page for the same request.
   * @param beforeSeq - the request's exclusive page bound, undefined when the
   *   page ends at the read's own cursor (the opening page).
   * @param maxMessages - the request's message floor in messages.
   * @param turnWindow - the request's turn window, undefined when it carries none.
   * @returns the rule the fork read plan applies to each window it accepts.
   */
  private windowCut(
    beforeSeq: number | undefined,
    maxMessages: number,
    turnWindow: SessionPageRequest['turnWindow'],
  ): WindowPageCut {
    const bound = beforeSeq === undefined ? undefined : SessionLogOffset(beforeSeq)
    return (window, baseSeq, throughSeq) => paginate(
      window,
      bound,
      maxMessages,
      throughSeq === -1 ? -1 : SessionSeq(throughSeq),
      turnWindow,
      baseSeq,
    )
  }

  /**
   * The opted-in Assistant-stream baseline for one opening snapshot.
   * @param target - the addressed Session identity.
   * @param opted - whether the request opted into Assistant frames.
   * @returns the accumulator snapshot, or undefined when not opted in.
   */
  private assistantStreamBaseline(
    target: SessionId,
    opted: boolean,
  ): SessionAssistantStreamBaseline | undefined {
    return opted ? this.assistantStreams.get(target)?.snapshot() ?? { revision: 0 } : undefined
  }

  /**
   * Fork patch (FORK_SURFACE.md): resolve the services the windowed open
   * reads through, or undefined when this request cannot take it. Kept
   * synchronous so an unserviceable request never pays an extra async hop
   * before the observation.
   * @param address - durable address of the request.
   * @param sessionId - the addressed Session identity.
   * @returns the window services, or undefined for the observation fallback.
   */
  private windowServices(
    address: SessionAddress,
    sessionId: SessionId,
  ): OpeningWindowServices | undefined {
    if (address.kind !== 'session') return undefined
    // An attached Session's authoritative read is the store's own log.
    if (this.ctx.sessions.get(sessionId) !== undefined) return undefined
    const persistence = seekSurface(this.ctx)
    const cache = this.ctx.get('sessionProjectionCache')
    const projections = this.ctx.get('sessionProjections')
    if (persistence === undefined || cache === undefined || projections === undefined) {
      return undefined
    }
    return { persistence, cache, projections }
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
        validateAddress(
          address,
          observation.header,
          observation.inheritedEventCount,
          observation.projections,
        )
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

function cursorBeforeNext(nextSeq: SessionLogOffsetType): SessionSeqCursor {
  return nextSeq === 0 ? -1 : SessionSeq(nextSeq - 1)
}

function wireAssistantStreamFrame(
  frame: AssistantStreamFrame,
  durableCursor: SessionSeqCursor,
): SessionAssistantStreamFrame {
  if (frame.type === 'start') return { ...frame, startedAfterSeq: durableCursor }
  if (frame.type === 'end') return frame
  return {
    ...frame,
    chunk: frame.chunk as JsonValue,
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
  if (!Number.isSafeInteger(request.throughSeq)
    || request.throughSeq < -1
    || Object.is(request.throughSeq, -0)) {
    throw new RemoteError('gateway/bad-request', 'throughSeq must be an integer greater than or equal to -1', {})
  }
  if (request.beforeSeq !== undefined
    && (!Number.isSafeInteger(request.beforeSeq)
      || request.beforeSeq < 0
      || Object.is(request.beforeSeq, -0))) {
    throw new RemoteError('gateway/bad-request', 'beforeSeq must be a non-negative safe integer', {})
  }
  validateHistoryWindow(request)
}

function validateHistoryWindow(request: Pick<SessionPageRequest, 'maxMessages' | 'turnWindow'>): void {
  if (request.maxMessages !== undefined
    && (!Number.isSafeInteger(request.maxMessages) || request.maxMessages <= 0)) {
    throw new RemoteError('gateway/bad-request', 'maxMessages must be a positive safe integer', {})
  }
  const window = request.turnWindow
  if (window !== undefined) {
    if (!Number.isSafeInteger(window.minMessages) || window.minMessages <= 0
      || window.minMessages > (request.maxMessages ?? DEFAULT_MAX_MESSAGES)) {
      throw new RemoteError('gateway/bad-request', 'turnWindow.minMessages must be a positive safe integer no greater than maxMessages', {})
    }
    if (!Number.isSafeInteger(window.minTurns) || window.minTurns <= 0) {
      throw new RemoteError('gateway/bad-request', 'turnWindow.minTurns must be a positive safe integer', {})
    }
  }
}

function addressId(address: SessionAddress): SessionId {
  return address.kind === 'session' ? address.sessionId : address.childSessionId
}




function validateAddress(
  address: SessionAddress,
  header: SessionHeader,
  inheritedEventCount: SessionLogOffsetType,
  projections: SessionObservation['projections'],
): void {
  if (address.kind === 'session') {
    if (header.origin === 'subagent') {
      throw new RemoteError('session/agent-busy', 'subagent Sessions require their durable parent address', {
        reason: 'use subagent delivery for this child session',
      })
    }
    return
  }
  if (header.origin !== 'subagent' || header.parentSession !== address.parentSessionId) {
    throw new RemoteError('subagent/unauthorized', 'subagent does not belong to the supplied parent', {
      childSessionId: address.childSessionId,
    })
  }
  const identity = projections?.values.subagent
  if (identity === null) {
    throw new RemoteError('subagent/catalog-diagnostic', 'subagent descriptor is corrupt', {
      parentSessionId: address.parentSessionId,
      childSessionId: address.childSessionId,
      reason: 'corrupt',
    })
  }
  if (identity === undefined || identity.seq < inheritedEventCount) {
    throw new RemoteError('subagent/catalog-diagnostic', 'subagent descriptor is unavailable', {
      parentSessionId: address.parentSessionId,
      childSessionId: address.childSessionId,
      reason: 'unsupported',
    })
  }
  if (address.mode !== 'unknown' && identity.mode !== address.mode) {
    throw new RemoteError('subagent/unauthorized', 'subagent mode does not match the supplied address', {
      childSessionId: address.childSessionId,
    })
  }
}

function rejectNotFound(address: SessionAddress): never {
  if (address.kind === 'session') {
    throw new RemoteError('session/not-found', `session "${address.sessionId}" not found`, { sessionId: address.sessionId })
  }
  throw new RemoteError('subagent/not-found', 'subagent is unavailable', {
    parentSessionId: address.parentSessionId,
    childSessionId: address.childSessionId,
  })
}

/**
 * Cut one backwards page with the session's page rule. The walk's own stop —
 * the max-th append-origin message below the page end, widened to its origin
 * group head, or, when `turnWindow` is set, the turn/start carrying both its
 * minima — only selects where the page may start; the cut itself is the
 * enclosing Turn start. A message stop landing inside a Turn widens backward to
 * that Turn's `turn/start`, so no page head exposes a partial Turn (an
 * assistant/message, step, or tool record without the Turn that opened it).
 * `maxMessages` is therefore a floor, not a hard cap: the cut Turn's residual
 * part beyond the budget stays on the page. Only a walk that reaches no Turn
 * start stops at the window head and reports `exhausted`, which the indexed
 * fast path reads as an unproven window and widens or falls back; the log head
 * is then the boundary, with no older Turn start to align to.
 *
 * Fork patch (FORK_SURFACE.md): the indexed fast path applies this same walk to
 * a dense suffix window (`baseSeq` is that window's first seq), so the indexed
 * read and the observation cut one page; the export serves that seam and the
 * paging specs' differential oracle.
 *
 * @param events - the log or one dense suffix window of it, in seq order.
 * @param beforeSeq - exclusive page-before bound, undefined when the page ends at `throughSeq`.
 * @param maxMessages - append-origin message floor the walk counts to before it widens back to a Turn start.
 * @param throughSeq - inclusive page end seq, -1 before any event exists.
 * @param turnWindow - optional turn minima the walk also stops at.
 * @param baseSeq - absolute seq of `events[0]`; 0 for a whole log.
 * @returns the page events, whether older history exists, the absolute cut seq
 *   (never below `baseSeq`), and whether the walk reached the window head
 *   without cutting.
 */
export function paginate(
  events: readonly SessionEvent[],
  beforeSeq: SessionLogOffsetType | undefined,
  maxMessages: number,
  throughSeq: SessionSeqCursor,
  turnWindow?: SessionPageRequest['turnWindow'],
  // Fork patch (FORK_SURFACE.md): the indexed fast path hands this walk a dense
  // suffix window whose first element sits at `baseSeq`; the observation path
  // reads the whole log and leaves it at 0, so both paths cut one page.
  baseSeq = 0,
): {
  readonly events: SessionEvent[]
  readonly hasMore: boolean
  /**
   * Absolute seq of the page's first event; always at or above `baseSeq`, and
   * `baseSeq` exactly when the walk ran out of window before finding a Turn
   * start (see `exhausted`).
   */
  readonly cut: number
  /**
   * Whether the backwards walk reached the window head without cutting. A
   * windowed caller reads this as an unproven window: the slice it holds may
   * still start inside a Turn, so it widens its read or falls back to the whole
   * log instead of serving that slice.
   */
  readonly exhausted: boolean
} {
  const end = SessionLogOffset(Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1))
  let count = 0
  let turns = 0
  let cut = baseSeq
  let exhausted = true
  // Seq the message floor selected; the walk continues below it to the Turn
  // start that owns it, so the cut is a Turn start or the window head.
  let stopSeq = -1
  for (let index = end - 1 - baseSeq; index >= 0; index--) {
    const event = events[index] as SessionEvent
    const at = SessionLogOffset(index + baseSeq)
    if (event.type === 'turn/start') {
      if (turnWindow !== undefined) turns++
      const windowStop = turnWindow !== undefined
        && count >= turnWindow.minMessages
        && turns >= turnWindow.minTurns
      if (windowStop || (stopSeq >= 0 && at <= stopSeq)) {
        cut = at
        exhausted = false
        break
      }
      continue
    }
    if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event)) continue
    count++
    const sources = event.sourceEventSeqs
    let groupStart = event.seq
    if (sources !== undefined) {
      for (const source of sources) {
        if (source < groupStart) groupStart = source
      }
    }
    if (count >= maxMessages && stopSeq < 0) stopSeq = groupStart
  }
  // A walk that ran out of window before finding a Turn start cannot prove its
  // cut: the caller reads that off `exhausted` and widens its window instead of
  // serving this slice.
  return {
    events: events.slice(Math.max(cut - baseSeq, 0), Math.max(end - baseSeq, 0)),
    hasMore: cut > 0,
    cut,
    exhausted,
  }
}

/** Translate current logical Session metadata to the browser wire. */
function wireHeader(header: SessionHeader): SessionWireHeader {
  return { ...header }
}

function entryFor(event: SessionEvent): SessionEventEntry {
  return {
    type: 'event',
    // Session.append validates and freezes event data as JSON before publication.
    event: event as unknown as SessionWireEvent,
  }
}

/** Encode one bounded logical page without changing its pagination cut. */
function pageRecords(events: readonly SessionEvent[]): SessionHistoryRecord[] {
  return events.map(entryFor)
}
