// Fork-owned live-observation memo module (see FORK_SURFACE.md): the change
// signal that tells whether one attached session's observation can be reused.
// Upstream's SqliteSessionQueryEngine delegates memo lookup, recompute, and
// eviction to this one file, keeping its index.ts at a minimal injection
// surface for future syncs.

import type { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'

/** One memoized observation and the Session state it was built from. */
interface MemoEntry<TObservation> {
  /** The Session instance observed; a replacement under the same id recomputes. */
  session: Session
  /** The Session's log length when the observation was built. */
  seq: SessionLogOffset
  observation: TObservation
}

/**
 * Live observations memoized per attached Session, keyed by the Session's own
 * log length and by the Session instance that produced the observation.
 *
 * The change signal must be cheap: materializing the log is the expensive half
 * of an observation (clone, fingerprint, and document extraction over the whole
 * log — tens of megabytes for a large attached Session), so the memo decides
 * reuse before any event read. `session.seq` is an O(1) getter for the log
 * length. Attached logs mutate by append only (replacements and edits append
 * too), so an unchanged length means unchanged content; a Session object
 * replaced under the same id (rewrite, restore) recomputes because the
 * instance differs.
 */
export class LiveObservationMemo<TObservation> {
  private readonly memo = new Map<SessionId, MemoEntry<TObservation>>()

  /**
   * Return the memoized observation while the Session's log length and instance
   * are unchanged; otherwise recompute, memoize, and return the fresh
   * observation. `recompute` is the only caller of the Session's event read, so
   * an unchanged Session never materializes its log.
   * @param session - the attached session being observed.
   * @param recompute - builds the observation when the change signal moved.
   * @returns the cached observation for an unchanged Session, else the recomputed one.
   */
  observe(session: Session, recompute: () => TObservation): TObservation {
    const seq = session.seq
    const cached = this.memo.get(session.id)
    if (cached !== undefined && cached.session === session && cached.seq === seq) {
      return cached.observation
    }
    const observation = recompute()
    this.memo.set(session.id, { session, seq, observation })
    return observation
  }

  /**
   * Bound the memo to the currently attached sessions: drop every memoized
   * session absent from the newest observation pass.
   * @param active - sessions present in the newest observation pass.
   */
  evictDetached(active: ReadonlyMap<SessionId, unknown>): void {
    for (const id of this.memo.keys()) {
      if (!active.has(id)) this.memo.delete(id)
    }
  }
}
