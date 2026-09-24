// Fork-owned activity-coalescing module (see FORK_SURFACE.md): ambient
// `api-session/activity` streams buffer per session instead of rebuilding the
// list on every event render.

/**
 * Coalesce ambient session-activity events before they reach the list
 * mutation channel. A lone activity applies immediately (zero added
 * latency, preserving the synchronous staging contract), while a
 * continuous stream — other sessions' `user/message` activity arriving
 * every event — buffers each session's latest timestamp and flushes once
 * per window, so the list rebuild chain stops running per event render.
 *
 * Lone means a session's first stamp while no batch is in flight: a window
 * that is already carrying somebody's stream defers every further stamp to
 * the flush, but a still-empty window publishes each session's first stamp on
 * arrival. A second session's single message is not part of the first one's
 * stream, and holding it for a whole window would delay that message's
 * freshness — the property the immediate path exists to keep.
 */
export class ActivityCoalescer<SessionKey extends string = string> {
  private windowTimer: ReturnType<typeof setTimeout> | undefined
  private pending = new Map<SessionKey, number>()
  /** Sessions already published immediately in the open window. */
  private readonly published = new Set<SessionKey>()

  /**
   * @param windowMs - trailing flush window for buffered activities.
   * @param flush - applies the buffered `(sessionId, updatedAt)` pairs.
   */
  constructor(
    private readonly windowMs: number,
    private readonly flush: (pending: ReadonlyMap<SessionKey, number>) => void,
  ) {}

  /**
   * Record one activity; a lone one applies immediately.
   * @param sessionId - the Session whose activity was observed.
   * @param updatedAt - the observed activity timestamp; a later activity for
   *   the same Session replaces it in the buffered batch.
   */
  collect(sessionId: SessionKey, updatedAt: number): void {
    if (this.windowTimer === undefined) {
      this.publish(sessionId, updatedAt)
      return
    }
    if (this.pending.size === 0 && !this.published.has(sessionId)) {
      this.publish(sessionId, updatedAt)
      return
    }
    this.pending.set(sessionId, updatedAt)
  }

  /** Stop the window timer and drop any buffered activities. */
  dispose(): void {
    if (this.windowTimer !== undefined) clearTimeout(this.windowTimer)
    this.windowTimer = undefined
    this.pending = new Map()
    this.published.clear()
  }

  /** Apply one activity now and open the window when none is running. */
  private publish(sessionId: SessionKey, updatedAt: number): void {
    this.published.add(sessionId)
    this.flush(new Map([[sessionId, updatedAt]]))
    if (this.windowTimer !== undefined) return
    this.windowTimer = setTimeout(() => {
      this.windowTimer = undefined
      this.published.clear()
      if (this.pending.size === 0) return
      const batch = this.pending
      this.pending = new Map()
      this.flush(batch)
    }, this.windowMs)
  }
}

/**
 * Activity flush window: one second. List timestamps display at minute
 * granularity, so a stamp within the second costs nothing visible, while a
 * busy side session's activity now drives the full list rebuild chain at
 * most once per second instead of up to five times.
 */
export const ACTIVITY_COALESCE_MS = 1_000
