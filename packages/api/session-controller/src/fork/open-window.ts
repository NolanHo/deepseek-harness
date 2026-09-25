// Fork-owned session-open window module (see FORK_SURFACE.md): a cold
// Session's opening snapshot is read as one seekable suffix window — the
// history page and the projection tail come from the same read at the same
// cut — instead of decoding the whole log. Upstream's history.ts keeps only
// the marked call and its observation fallback.

import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type {
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionSeqCursor,
} from '@deepseek-ai/dsh-session'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
// Fork-owned read face of the projection cache (see its src/fork/checkpoint-read.ts).
import { readCheckpoint } from '@deepseek-ai/dsh-session-projection-cache'
import type SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import { readIndexedSuffix, type SeekablePersistence, type WindowPageCut } from './page-boundary.ts'

/** The services one windowed open reads through. */
export interface OpeningWindowServices {
  /** Fork seek surface (messageCut + readFrom) of the mounted persistence. */
  readonly persistence: SeekablePersistence
  /** Persisted projection checkpoints. */
  readonly cache: SessionProjectionCache
  /** Projection registry folding the read tail. */
  readonly projections: SessionProjectionRegistry
}

/** One cold Session's opening snapshot, cut at the accepted window's end. */
export interface OpeningWindow {
  /** Stored Session metadata the window was read with. */
  readonly header: SessionHeader
  /** Last observed event seq, or -1 for an empty log. */
  readonly cursor: SessionSeqCursor
  /** The Turn-aligned opening page. */
  readonly events: readonly SessionEvent[]
  /** Whether older history exists below the page. */
  readonly hasMore: boolean
  /** Every projection value at {@link cursor}. */
  readonly projections: ProjectionSnapshot
}

/**
 * Read one cold Session's opening snapshot from a single seekable suffix
 * window. Requires a stored checkpoint record for the Session's lifecycle (no
 * record, no fold shortcut) and a log whose tail is closed, so the served
 * projection block equals what a full observation yields; any other shape
 * returns undefined and the caller's observation path answers.
 *
 * @param services - the seekable persistence, checkpoint cache, and registry.
 * @param request - the addressed Session and its indexed seed size.
 * @param cut - the caller's page rule, upstream's `paginate` bound to the
 *   opening request (see {@link WindowPageCut}).
 * @param validateSuffix - caller-owned address validation over each read suffix.
 * @param signal - cancellation shared with the request.
 * @returns the opening snapshot, or undefined when no window can serve it.
 */
export async function readOpeningWindow(
  services: OpeningWindowServices,
  request: { readonly sessionId: SessionId; readonly seedMessages: number },
  cut: WindowPageCut,
  validateSuffix: (meta: SessionHeader, events: readonly SessionEvent[]) => void,
  signal: AbortSignal,
): Promise<OpeningWindow | undefined> {
  const read = await readIndexedSuffix(
    services.persistence,
    {
      id: request.sessionId,
      seedMessages: request.seedMessages,
      beforeSeq: undefined,
      windowFloor: (meta, inheritedEventCount) => {
        const found = readCheckpoint(services.cache, meta, inheritedEventCount)
        // No usable record, or none the current units can seed (floor 0 means
        // at least one row must refold from the log head): the observation path
        // owns the request rather than a fold this window cannot seed.
        if (found === undefined || found.seq === undefined || found.seq === 0) return undefined
        return found.seq
      },
    },
    cut,
    validateSuffix,
    signal,
  )
  if (read === undefined) return undefined
  // Re-resolve against the ACCEPTED read: a restarted or retried read may have
  // answered another lifecycle under the same id, and only rows that match the
  // accepted header may seed this fold.
  const resolved = readCheckpoint(services.cache, read.meta, read.inheritedEventCount)
  if (resolved === undefined) return undefined
  // A recovered tail folds differently from the stored log: the balanced
  // opening a full observation serves cannot be produced from this window.
  if (!closedTail(read.events, read.fromSeq)) return undefined
  const projections = services.projections.restore(
    resolved.rows,
    read.events,
    SessionLogOffset(read.fromSeq),
    read.meta,
    read.inheritedEventCount,
  )
  return {
    header: read.meta,
    // The accept test rejects a page-less window, so an accepted window holds
    // events and the page end is a real seq.
    cursor: SessionSeq(read.throughSeq),
    events: read.page.events,
    hasMore: read.page.hasMore,
    projections: projections.snapshot,
  }
}

/**
 * Whether one accepted read window proves the stored log equals its balanced
 * view. `interruptedTurnClosers` emits nothing whenever the log's last turn
 * boundary is a `turn/end`, so a window whose last boundary is one is closed
 * and a window whose last boundary is a `turn/start` is not. A window with no
 * boundary at all is closed only as the log's own tail: a boundary below its
 * head would decide the closers, so only a window reaching the log head
 * (`fromSeq === 0`) proves it covers them.
 * @param events - the accepted read window, in seq order.
 * @param fromSeq - the window's first seq, 0 at the log head.
 * @returns true when no synthetic recovery closer is owed.
 */
function closedTail(events: readonly SessionEvent[], fromSeq: number): boolean {
  for (let index = events.length - 1; index >= 0; index--) {
    const type = (events[index] as SessionEvent).type
    if (type === 'turn/end') return true
    if (type === 'turn/start') return false
  }
  return fromSeq === 0
}
