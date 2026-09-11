// Fork-owned page-boundary module (see FORK_SURFACE.md): the user-aligned,
// turn-complete history pagination that upstream's session-controller
// delegates to. Keeping this in one fork file leaves upstream's history.ts
// with a minimal injection surface for future syncs.
//
// One boundary walk serves BOTH read paths so they can never disagree on a
// page cut: user messages anchor pages (a whole-log fallback to any message
// for synthetic logs), each chosen message widens its cut through
// sourceEventSeqs, and the cut extends back to its owning turn's opening
// events so no page starts mid-turn.

import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'

/** Message types a page boundary may count. */
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

/**
 * Headroom read before a message-indexed cut: the cut seqs an append-origin
 * user message while the page cut lands at its group head (turn boundary and
 * any source events a few seqs earlier). The margin covers the ordinary lead
 * without re-reading a whole window; a compaction replacement widens its
 * group head across the whole shadowed range, so an incomplete window
 * retries once at the deep margin before falling back to the observation
 * path.
 */
const PAGE_CUT_LEAD_MARGIN = 128
const PAGE_CUT_DEEP_MARGIN = 4096

/** The optional indexed-seek persistence surface behind the page fast path. */
export interface SeekablePersistence {
  messageCut(id: SessionId, maxMessages: number, beforeSeq?: number, signal?: AbortSignal): Promise<number | undefined>
  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{
    meta: SessionHeader
    inheritedEventCount: SessionLogOffset
    events: SessionEvent[]
  }>
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
 * (index === seq), the suffix read passes its own length).
 * @returns The cut seq (0 when the window holds fewer than one full page),
 * the chosen message count, and whether the turn-aligned cut stopped at the
 * window head before reaching its owning turn (see {@link turnAlignedCut}).
 */
export function nthMessageCut(
  window: readonly SessionEvent[],
  maxMessages: number,
  endIndex = window.length,
): { readonly cut: number; readonly messages: number; readonly truncated: boolean } {
  let userCount = 0
  let userCut = 0
  let anyCount = 0
  let anyCut = 0
  for (let index = Math.min(endIndex, window.length) - 1; index >= 0; index--) {
    const event = window[index] as SessionEvent
    if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event)) continue
    const sources = (event as { readonly sourceEventSeqs?: readonly number[] }).sourceEventSeqs
    let groupStart: number = event.seq
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
  const chosen = userCount > 0
    ? { cut: userCut, messages: userCount }
    : { cut: anyCut, messages: anyCount }
  const aligned = turnAlignedCut(window, chosen.cut)
  return { cut: aligned.cut, messages: chosen.messages, truncated: aligned.truncated }
}

/**
 * Widen a message cut back to its owning turn's opening events: a page must
 * not start mid-turn, or the head turn reaches the client without its
 * turn/start and renders unfolded until the next page completes it — a
 * visible layout flip on every Load earlier. The walk stops at the previous
 * turn/end (or the window head), so only the turn's own opening events
 * (turn/start, seeds, context injection) join the page.
 *
 * @param window - Events in seq order (a dense log or a suffix read).
 * @param cut - The message cut to widen.
 * @returns The aligned cut and whether the walk ran out of window before that
 * turn's `turn/end`: a truncated cut still lands "inside" the window, so the
 * suffix fast path must reject it (the observation path holds the whole log).
 */
function turnAlignedCut(
  window: readonly SessionEvent[],
  cut: number,
): { readonly cut: number; readonly truncated: boolean } {
  if (cut <= 0) return { cut: 0, truncated: false }
  let index = window.findIndex(event => event.seq >= cut)
  /* v8 ignore next -- a cut beyond the window's last seq requires the
     messageCut backend to disagree with the readFrom suffix; the fast path
     validates the cut inside its window before this can fire. */
  if (index < 0) return { cut, truncated: false }
  while (index > 0) {
    const previous = window[index - 1] as SessionEvent
    if (previous.type === 'turn/end') return { cut: (window[index] as SessionEvent).seq, truncated: false }
    index--
  }
  const head = (window[0] as SessionEvent).seq
  // A walk that reaches seq 0 reached the log head, where nothing precedes the
  // turn, so the page still opens on that turn; any later head is truncated.
  return { cut: head, truncated: head > 0 }
}

/**
 * Message-aligned pagination over a seq-indexed SUFFIX (the fast-path read
 * starts at a positive seq, so array indexes are not seqs — the observation
 * pagination's dense-index assumption does not transfer).
 */
export function paginateSuffix(
  events: readonly SessionEvent[],
  beforeSeq: number | undefined,
  maxMessages: number,
  throughSeq: number,
): {
  readonly events: SessionEvent[]
  readonly hasMore: boolean
  readonly cut: number
  readonly messages: number
  readonly truncated: boolean
} {
  const end = Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1)
  const window = events.filter(event => event.seq < end)
  const chosen = nthMessageCut(window, maxMessages)
  return {
    events: window.filter(event => event.seq >= chosen.cut),
    hasMore: chosen.cut > 0,
    cut: chosen.cut,
    messages: chosen.messages,
    truncated: chosen.truncated,
  }
}

/** The fast-path ladder's read plan over one indexed seek. */
export interface IndexedPagePlan {
  readonly id: SessionId
  readonly maxMessages: number
  readonly beforeSeq: number | undefined
  /**
   * Inclusive page end, or omitted to end at the read suffix's own last seq
   * (the opening page, whose log end no caller holds yet).
   */
  readonly throughSeq?: number
  /**
   * Optional projection floor resolved from the first read's stored header
   * (a cache identity needs that metadata): a returned seq below the window
   * start restarts the read there, so one window serves the page and a
   * projection tail at the same cut. Returning `undefined` aborts the read.
   */
  readonly windowFloor?: (meta: SessionHeader, inheritedEventCount: SessionLogOffset) => number | undefined
}

/** One accepted indexed read: the page and the suffix window it was cut from. */
export interface IndexedRead {
  readonly meta: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  /** Window start seq: `events` is dense from here, the projection `baseSeq`. */
  readonly fromSeq: number
  /** Inclusive page end: the plan's cursor or the accepted window's last seq. */
  readonly throughSeq: number
  /** Every event of the accepted suffix read, in seq order. */
  readonly events: readonly SessionEvent[]
  /** The message-aligned page sliced from {@link events}. */
  readonly page: { readonly events: SessionEvent[]; readonly hasMore: boolean }
}

/**
 * Read one indexed suffix window. The plan's message cut seeds a shallow
 * suffix read; a projection floor below its start restarts the read there so
 * one window serves both, a window that cannot hold the (compaction-widened)
 * cut retries once at the deep margin, and an unsatisfiable window returns
 * undefined so the caller falls back to the observation path.
 *
 * @param source - The seekable persistence (messageCut + readFrom).
 * @param plan - The page request's resolved addressing.
 * @param validateSuffix - Caller-owned request validation over each read
 * suffix (identity, address, throughSeq); throws to reject the request.
 * @param signal - Cancellation shared with the request.
 * @returns The accepted window and its page, or undefined when the backend
 * cannot answer or the window cannot hold the page.
 */
export async function readIndexedSuffix(
  source: SeekablePersistence,
  plan: IndexedPagePlan,
  validateSuffix: (meta: SessionHeader, events: readonly SessionEvent[]) => void,
  signal: AbortSignal,
): Promise<IndexedRead | undefined> {
  const end = plan.throughSeq !== undefined && plan.throughSeq >= 0
    ? Math.min(plan.throughSeq + 1, plan.beforeSeq ?? plan.throughSeq + 1)
    : plan.beforeSeq
  const cut = await source.messageCut(plan.id, plan.maxMessages, end, signal)
  signal.throwIfAborted()
  if (cut === undefined) return undefined
  // A mismatched identity is a soft bail (the caller falls back), not a
  // rejected request; each read re-validates, including a restarted one.
  const read = async (fromSeq: number) => {
    const suffix = await source.readFrom(plan.id, fromSeq, signal)
    signal.throwIfAborted()
    if (suffix.meta.id !== plan.id) return undefined
    validateSuffix(suffix.meta, suffix.events)
    return suffix
  }
  let fromSeq = Math.max(0, cut - PAGE_CUT_LEAD_MARGIN)
  let suffix = await read(fromSeq)
  if (suffix === undefined) return undefined
  const floor = plan.windowFloor?.(suffix.meta, suffix.inheritedEventCount)
  if (plan.windowFloor !== undefined && floor === undefined) return undefined
  if (floor !== undefined && floor < fromSeq) {
    fromSeq = floor
    suffix = await read(fromSeq)
    if (suffix === undefined) return undefined
  }
  for (let attempt = 0; ; attempt++) {
    const throughSeq = plan.throughSeq ?? suffix.events.at(-1)?.seq ?? -1
    const page = paginateSuffix(suffix.events, plan.beforeSeq, plan.maxMessages, throughSeq)
    // The window provably holds the page only when the cut lands inside the
    // read suffix AND its owning turn's head does: a compaction replacement
    // widens its group head across the whole shadowed range, and a window
    // that starts inside the cut message's own turn truncates the head, so
    // one deep retry covers either before the caller re-reads the whole
    // observation.
    if (!page.truncated && page.cut >= fromSeq && page.messages >= plan.maxMessages) {
      return {
        meta: suffix.meta,
        inheritedEventCount: suffix.inheritedEventCount,
        fromSeq,
        throughSeq,
        events: suffix.events,
        page: { events: page.events, hasMore: page.hasMore },
      }
    }
    if (attempt > 0 || fromSeq === 0) return undefined
    const deep = Math.max(0, cut - PAGE_CUT_DEEP_MARGIN)
    fromSeq = floor === undefined ? deep : Math.min(deep, floor)
    suffix = await read(fromSeq)
    if (suffix === undefined) return undefined
  }
}

/**
 * Read one page through the indexed fast path; see {@link readIndexedSuffix}
 * for the read plan and the shared cut/margin ladder.
 *
 * @param source - The seekable persistence (messageCut + readFrom).
 * @param plan - The page request's resolved addressing.
 * @param validateSuffix - Caller-owned request validation over each read
 * suffix (identity, address, throughSeq); throws to reject the request.
 * @param signal - Cancellation shared with the request.
 * @returns The page events and hasMore, or undefined when the backend
 * cannot answer or the window cannot hold the page.
 */
export async function readIndexedPage(
  source: SeekablePersistence,
  plan: IndexedPagePlan,
  validateSuffix: (meta: SessionHeader, events: readonly SessionEvent[]) => void,
  signal: AbortSignal,
): Promise<{ readonly events: SessionEvent[]; readonly hasMore: boolean } | undefined> {
  const read = await readIndexedSuffix(source, plan, validateSuffix, signal)
  return read === undefined ? undefined : read.page
}
