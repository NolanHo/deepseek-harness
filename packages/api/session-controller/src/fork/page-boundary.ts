// Fork-owned page-boundary module (see FORK_SURFACE.md): the indexed physical
// read behind the fork's history fast paths — the seekable suffix window, the
// proof that the window holds the page, and the ladder that widens it. The page
// rule itself is the caller's (upstream's `paginate`, handed in as a
// WindowPageCut), so an indexed read and the observation path serve one page.

import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'

/**
 * Headroom read before a message-indexed seek: the seek answers an
 * append-origin user message while the page cut lands on the Turn start that
 * owns the message floor, which the indexed seek does not itself locate. The
 * margin covers the ordinary lead — the prompt's own Turn start a few events
 * earlier, or a compaction replacement's group head a few seqs earlier —
 * without re-reading a whole window. A dense Turn puts its start further back
 * than the margin, so an incomplete window retries once at the deep margin
 * before falling back to the observation path, which reads the whole log to
 * cut the same page. That fallback is the price of Turn alignment: a single
 * Turn carrying more events than the deep margin can never prove its cut from
 * either window, so every request for that Session pays the whole-log read
 * (measured: one 6,000-message Turn in a 6,011-event log served `undefined`
 * from both attempts and fell back; the page it then served matched the
 * observation path's page).
 */
const PAGE_CUT_LEAD_MARGIN = 128
const PAGE_CUT_DEEP_MARGIN = 4096

/** The optional indexed-seek persistence surface behind the page fast path. */
export interface SeekablePersistence {
  /**
   * Whether this session can answer a bounded seq window at all. Called before
   * any other member, so a backend whose stored rows are not addressable by the
   * cuts `messageCut` answers (a re-based historical log, for instance) pays
   * nothing and both fast paths fall through to the observation path.
   * @param id - the stored session to probe.
   * @param signal - optional cancellation for backend read work.
   * @returns true when `messageCut` and `readFrom` share one seq space.
   */
  seekable(id: SessionId, signal?: AbortSignal): Promise<boolean>
  messageCut(id: SessionId, maxMessages: number, beforeSeq?: number, signal?: AbortSignal): Promise<number | undefined>
  /**
   * Read the stored events from `fromSeq` on, or only up to
   * `throughSeqExclusive` when a page end exists: the returned events are then
   * exactly the stored ones in `[fromSeq, throughSeqExclusive)`, dense and
   * complete whenever the stored log holds rows at or past that bound.
   * @param id - the stored session to read.
   * @param fromSeq - first event offset to include.
   * @param throughSeqExclusive - optional exclusive upper bound, absent for a
   *   read that must reach the log's own end (the opening window).
   * @param signal - optional cancellation for backend read work.
   * @returns the validated suffix window, including the highest stored logical
   *   seq it observed: the log's own end for an unbounded read, and for a
   *   bounded one the end of the stored row space, which that read's window
   *   never reaches (-1 for an empty log).
   */
  readFrom(id: SessionId, fromSeq: number, throughSeqExclusive?: number, signal?: AbortSignal): Promise<{
    meta: SessionHeader
    inheritedEventCount: SessionLogOffset
    events: SessionEvent[]
    storedEnd: number
  }>
}

/** One read window's page, cut by the caller's page rule. */
export interface WindowPage {
  /** Page events, from the cut to the window end. */
  readonly events: readonly SessionEvent[]
  /** Whether an earlier page exists below the cut. */
  readonly hasMore: boolean
  /**
   * Absolute seq of the page's first event, or the window head when the walk
   * found no cut inside the window.
   */
  readonly cut: number
  /** Whether the backwards walk reached the window head without cutting. */
  readonly exhausted: boolean
}

/**
 * The page one window yields under the caller's page rule: upstream's
 * `paginate` in `history.ts`, bound to the request's page size, page-before
 * bound, and turn window. Both history read paths apply that one rule, so an
 * indexed suffix read and a whole-log observation cut the same page.
 *
 * @param window - the read window's events, dense and in seq order.
 * @param baseSeq - absolute seq of the window's first event; 0 for a whole log.
 * @param throughSeq - inclusive absolute page end.
 * @returns the page events, the cut seq, and whether the walk ran out of window
 *   before cutting: a walk that reaches the window head cannot prove its cut is
 *   the whole log's cut, so the caller widens the window or falls back.
 */
export type WindowPageCut = (
  window: readonly SessionEvent[],
  baseSeq: number,
  throughSeq: number,
) => WindowPage

/** The fast-path ladder's read plan over one indexed seek. */
export interface IndexedPagePlan {
  readonly id: SessionId
  /**
   * Indexed seed size: the persistence answers the max-th append-origin user
   * message below the page end, and the read starts a margin above it. A
   * request carrying a turn window seeds from that window's message floor.
   */
  readonly seedMessages: number
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
  /** The page the caller's rule cut from {@link events}. */
  readonly page: { readonly events: readonly SessionEvent[]; readonly hasMore: boolean }
}

/**
 * Read one indexed suffix window. The plan's seed cut starts a suffix read from
 * a margin above it, bounded by the page's own exclusive end and reaching the
 * log head when the seed sits within that margin; a projection floor below the
 * start restarts the read there so one window serves both the page and the
 * fold, a window that cannot hold the (compaction-widened) cut retries once at
 * the deep margin, and an unsatisfiable or unprovable window returns undefined
 * so the caller falls back to the observation path.
 *
 * @param source - The seekable persistence (messageCut + readFrom).
 * @param plan - The page request's resolved addressing.
 * @param cut - The caller's page rule (see {@link WindowPageCut}); the window
 *   is served only when the rule's cut is provably the whole log's cut.
 * @param validateSuffix - Caller-owned request validation over each read
 *   suffix (identity, address, the exclusive end in force, the stored end the
 *   read observed); throws to reject the request. Callers that only validate
 *   identity and address keep a two-argument closure.
 * @param signal - Cancellation shared with the request.
 * @returns The accepted window and its page, or undefined when the backend
 * cannot answer or the window cannot hold the page.
 */
export async function readIndexedSuffix(
  source: SeekablePersistence,
  plan: IndexedPagePlan,
  cut: WindowPageCut,
  validateSuffix: (
    meta: SessionHeader,
    events: readonly SessionEvent[],
    readEndExclusive?: number,
    storedEnd?: number,
  ) => void,
  signal: AbortSignal,
): Promise<IndexedRead | undefined> {
  // The capability probe comes first: a backend that cannot address a bounded
  // window must cost nothing, not one full read per attempted margin.
  const addressable = await source.seekable(plan.id, signal)
  signal.throwIfAborted()
  if (!addressable) return undefined
  const end = plan.throughSeq !== undefined && plan.throughSeq >= 0
    ? Math.min(plan.throughSeq + 1, plan.beforeSeq ?? plan.throughSeq + 1)
    : plan.beforeSeq
  const seed = await source.messageCut(plan.id, plan.seedMessages, end, signal)
  signal.throwIfAborted()
  if (seed === undefined) return undefined
  // A mismatched identity is a soft bail (the caller falls back), not a
  // rejected request; each read re-validates, including a restarted one.
  const read = async (fromSeq: number) => {
    // An end at or below the window start cannot hold a page — the cut below it
    // would have to precede the window — so the request goes unread.
    if (end !== undefined && end <= fromSeq) return undefined
    const suffix = await source.readFrom(plan.id, fromSeq, end, signal)
    signal.throwIfAborted()
    if (suffix.meta.id !== plan.id) return undefined
    validateSuffix(suffix.meta, suffix.events, end, suffix.storedEnd)
    // The page cut and the projection fold both index this window by
    // `seq - fromSeq`, so a non-empty answer must hold exactly the stored rows
    // in [fromSeq, last]: one that starts elsewhere or skips a seq cannot be cut
    // into a page, and the caller's observation path answers instead.
    if (suffix.events.length > 0) {
      const first = suffix.events[0] as SessionEvent
      const last = suffix.events[suffix.events.length - 1] as SessionEvent
      if (first.seq !== fromSeq || suffix.events.length !== last.seq - fromSeq + 1) return undefined
    }
    // A bounded read proves its own end: the backend answers the stored events
    // dense up to it, or the whole log below it. A suffix that stops short of
    // the bound — or answers nothing under it — cannot be cut into a page,
    // because that page would silently drop every event between its tail and the
    // bound; the observation path answers instead. An empty answer to an
    // unbounded read carries no offset and is judged by the page rule.
    if (end !== undefined && (suffix.events.at(-1)?.seq ?? -1) !== end - 1) return undefined
    return suffix
  }
  let fromSeq = Math.max(0, seed - PAGE_CUT_LEAD_MARGIN)
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
    const page = cut(suffix.events, fromSeq, throughSeq)
    // A cut inside the window IS the whole log's cut: the walk made every
    // decision the observation path's walk makes from the same page end. A walk
    // that ran out of window proves its cut only when the window is the log
    // prefix below that end (`fromSeq === 0`). A cut below the window head is
    // the same unproven shape for a caller-supplied rule, whose contract places
    // it at or above `baseSeq`. Unproven shapes take the ladder rather than
    // serving a page the observation path would not.
    const proven = !page.exhausted && page.cut >= fromSeq
    // A page-less window is never worth serving: the observation path answers
    // the same page, and the windowed open reads its cursor off the page tail.
    if (page.events.length > 0 && (proven || fromSeq === 0)) {
      return {
        meta: suffix.meta,
        inheritedEventCount: suffix.inheritedEventCount,
        fromSeq,
        throughSeq,
        events: suffix.events,
        page: { events: page.events, hasMore: page.hasMore },
      }
    }
    if (attempt > 0) return undefined
    const deep = Math.max(0, seed - PAGE_CUT_DEEP_MARGIN)
    fromSeq = floor === undefined ? deep : Math.min(deep, floor)
    suffix = await read(fromSeq)
    if (suffix === undefined) return undefined
  }
}

/**
 * Read one page through the indexed fast path; see {@link readIndexedSuffix}
 * for the read plan, the page rule, and the shared seed/margin ladder.
 *
 * @param source - The seekable persistence (messageCut + readFrom).
 * @param plan - The page request's resolved addressing.
 * @param cut - The caller's page rule (see {@link WindowPageCut}).
 * @param validateSuffix - Caller-owned request validation over each read
 * suffix (identity, address, the exclusive end in force, the stored end the
 * read observed); throws to reject the request.
 * @param signal - Cancellation shared with the request.
 * @returns The page events and hasMore, or undefined when the backend
 * cannot answer or the window cannot hold the page.
 */
export async function readIndexedPage(
  source: SeekablePersistence,
  plan: IndexedPagePlan,
  cut: WindowPageCut,
  validateSuffix: (
    meta: SessionHeader,
    events: readonly SessionEvent[],
    readEndExclusive?: number,
    storedEnd?: number,
  ) => void,
  signal: AbortSignal,
): Promise<{ readonly events: readonly SessionEvent[]; readonly hasMore: boolean } | undefined> {
  const read = await readIndexedSuffix(source, plan, cut, validateSuffix, signal)
  return read === undefined ? undefined : read.page
}
