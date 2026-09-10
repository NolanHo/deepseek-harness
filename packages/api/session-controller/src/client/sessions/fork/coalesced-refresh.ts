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
 * Activity flush window: one second. List timestamps display at minute
 * granularity, so a stamp within the second costs nothing visible, while a
 * busy side session's activity now drives the full list rebuild chain at
 * most once per second instead of up to five times.
 */
export const ACTIVITY_COALESCE_MS = 1_000
