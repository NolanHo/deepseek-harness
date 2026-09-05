/**
 * Coalesce ambient session-activity events before they reach the list
 * mutation channel. A lone activity applies immediately (zero added
 * latency, preserving the synchronous staging contract), while a
 * continuous stream — other sessions' `user/message` activity arriving
 * every event — buffers each session's latest timestamp and flushes once
 * per window, so the list rebuild chain stops running per event render.
 */
export class ActivityCoalescer<SessionKey extends string = string> {
  private windowTimer: ReturnType<typeof setTimeout> | undefined
  private pending = new Map<SessionKey, number>()

  /**
   * @param windowMs - trailing flush window for buffered activities.
   * @param flush - applies the buffered `(sessionId, updatedAt)` pairs.
   */
  constructor(
    private readonly windowMs: number,
    private readonly flush: (pending: ReadonlyMap<SessionKey, number>) => void,
  ) {}

  /** Record one activity; the first of a window applies immediately. */
  collect(sessionId: SessionKey, updatedAt: number): void {
    if (this.windowTimer === undefined) {
      this.flush(new Map([[sessionId, updatedAt]]))
      this.windowTimer = setTimeout(() => {
        this.windowTimer = undefined
        if (this.pending.size > 0) {
          const batch = this.pending
          this.pending = new Map()
          this.flush(batch)
        }
      }, this.windowMs)
      return
    }
    this.pending.set(sessionId, updatedAt)
  }

  /** Stop the window timer and drop any buffered activities. */
  dispose(): void {
    if (this.windowTimer !== undefined) clearTimeout(this.windowTimer)
    this.windowTimer = undefined
    this.pending = new Map()
  }
}

/**
 * Activity flush window: below the interaction budget, so a busy side
 * session's activity stamps the list at most five times per second
 * instead of once per user-message event.
 */
export const ACTIVITY_COALESCE_MS = 200
