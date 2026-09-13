import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * Defers one Session's `api-session/removed` announcement while an in-place
 * history rewrite tears its Agent down and rebuilds it.
 *
 * The rewrite keeps the Session id and its durable log, and the same request
 * rebuilds the Agent, so the removal/addition pair is not a Session lifecycle
 * edge a client should see. Announced, it drops the row and the selection in
 * every connected client, which renders the new-Session frame until the
 * rebuild lands. A rewrite that ends without a live Agent again (a failed
 * truncate) releases the deferred announcement, so clients still learn that
 * the Session is gone.
 */
export class RewriteRemovalHold {
  private readonly held = new Set<SessionId>()
  private readonly deferred = new Set<SessionId>()

  /**
   * @param deps - live-Agent predicate and the announcement this hold defers.
   */
  constructor(private readonly deps: {
    /** Whether the Session has a live Agent again. */
    readonly isLive: (sessionId: SessionId) => boolean
    /** Publish one removal the rewrite did not undo. */
    readonly announceRemoved: (sessionId: SessionId) => void
  }) {}

  /**
   * Hold this Session's removal announcement until the returned release runs.
   * @param sessionId - Session whose Agent the rewrite is about to tear down.
   * @returns idempotent release; it announces the removal when the window ends
   *   with no live Agent.
   */
  hold(sessionId: SessionId): () => void {
    this.held.add(sessionId)
    let released = false
    return () => {
      if (released) return
      released = true
      this.held.delete(sessionId)
      if (!this.deferred.delete(sessionId)) return
      if (this.deps.isLive(sessionId)) return
      this.deps.announceRemoved(sessionId)
    }
  }

  /**
   * Take one disposal announcement into this hold.
   * @param sessionId - Session whose disposal is being announced.
   * @returns true when the caller must not announce the removal itself.
   */
  defer(sessionId: SessionId): boolean {
    if (!this.held.has(sessionId)) return false
    this.deferred.add(sessionId)
    return true
  }
}
