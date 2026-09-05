// Fork-owned live-observation memo module (see FORK_SURFACE.md): the event
// fingerprint that tells whether one attached session's observation changed.
// Upstream's SqliteSessionQueryEngine delegates memo lookup, recompute, and
// eviction to this one file, keeping its index.ts at a minimal injection
// surface for future syncs.

import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

/**
 * Live observations memoized per session: recomputation clones and fingerprints
 * every event (tens of millions of JSON bytes for large attached logs), so each
 * attached session would otherwise be recomputed on every search. Attached logs
 * mutate by append only (replacements and edits append too), so the event count
 * plus the tail seq/time identifies the observation content.
 */
export class LiveObservationMemo<TObservation> {
  private readonly memo = new Map<SessionId, { key: string; observation: TObservation }>()

  /**
   * Return the memoized observation while the session's event tail fingerprint
   * (event count plus tail seq/time) is unchanged; otherwise recompute,
   * memoize, and return the fresh observation.
   * @param sessionId - the attached session being observed.
   * @param events - the session's current events, in seq order.
   * @param recompute - builds the observation when the fingerprint moved.
   * @returns the cached observation for an unchanged fingerprint, else the recomputed one.
   */
  observe(
    sessionId: SessionId,
    events: readonly SessionEvent[],
    recompute: () => TObservation,
  ): TObservation {
    const tail = events.at(-1)
    const key = `${events.length}:${tail?.seq ?? 'none'}:${tail?.time ?? 'none'}`
    const cached = this.memo.get(sessionId)
    if (cached !== undefined && cached.key === key) return cached.observation
    const observation = recompute()
    this.memo.set(sessionId, { key, observation })
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
