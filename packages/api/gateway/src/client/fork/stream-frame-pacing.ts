/** Fork-owned journal frame pacing (see FORK_SURFACE.md): the journal consumer
 * returns to the event loop between bounded batches of decoded frames instead
 * of draining a whole WebSocket message burst in one task. */

/**
 * Consumer work allowed in one event-loop turn, in milliseconds.
 *
 * The deployed client was measured under a 4x CPU throttling rate, where 4 ms of
 * folding work becomes about one 60 Hz frame (16 ms) of wall time; bounding a
 * batch here keeps the work of a single turn at that size so the renderer still
 * gets the next turn.
 */
export const FRAME_PACING_TIME_BUDGET_MS = 4

/**
 * Frames allowed in one event-loop turn regardless of measured time.
 *
 * Frame processing can be cheap enough that a burst never reaches the time
 * budget, and `performance.now()` resolution can hide short batches; the frame
 * count bounds the batch either way.
 */
export const FRAME_PACING_FRAME_BUDGET = 32

/** Budget one stream has spent in the current event-loop turn. */
interface TurnBudget {
  /** Frames recorded since the batch began. */
  frames: number
  /** Clock reading when the batch began, restarted after an idle gap. */
  startedAt: number
  /** Clock reading of the previous frame, which identifies an idle gap. */
  lastFrameAt: number
}

/**
 * Pacing state per stream lifetime, keyed by the stream's cancellation signal:
 * two consumers draining in the same turn must not inherit each other's spent
 * budget, and a disposed stream's entry becomes collectable with its signal.
 */
const turnBudgets = new WeakMap<AbortSignal, TurnBudget>()

/**
 * Record one consumed frame and yield to the event loop once the turn's budget
 * is spent.
 *
 * Called between fully processed frames — the caller published the previous
 * frame before this call — so nothing here interrupts a frame's own work. A gap
 * of at least the time budget since the previous frame means the event loop
 * already had its turn, and the frame starts a fresh batch instead of inheriting
 * an exhausted one.
 *
 * @param signal - cancellation lifetime of the stream being consumed; the wait settles as soon as it aborts.
 * @returns after the frame is recorded and, when the budget was spent, after the host ran one macrotask.
 */
export async function afterFrame(signal: AbortSignal): Promise<void> {
  const now = performance.now()
  let budget = turnBudgets.get(signal)
  if (budget === undefined) {
    budget = { frames: 0, startedAt: now, lastFrameAt: now }
    turnBudgets.set(signal, budget)
  }
  if (now - budget.lastFrameAt >= FRAME_PACING_TIME_BUDGET_MS) budget.startedAt = now
  budget.lastFrameAt = now
  budget.frames += 1
  if (budget.frames < FRAME_PACING_FRAME_BUDGET
    && now - budget.startedAt < FRAME_PACING_TIME_BUDGET_MS) return
  budget.frames = 0
  budget.startedAt = now
  await yieldToEventLoop(signal)
}

/**
 * Wait for one host macrotask, or settle as soon as the stream is cancelled.
 *
 * `MessageChannel` is preferred because a hidden page throttles timers to about
 * one per second, which would drag out a backgrounded Session's stream; the
 * timer is the fallback for hosts that provide no `MessageChannel` (jsdom among
 * them).
 *
 * @param signal - cancellation lifetime raced against the wait.
 * @returns when the macrotask ran or the signal aborted, whichever happened first.
 */
function yieldToEventLoop(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  if (typeof MessageChannel !== 'function') {
    return new Promise<void>((resolve) => {
      const settle = (): void => {
        signal.removeEventListener('abort', settle)
        resolve()
      }
      signal.addEventListener('abort', settle, { once: true })
      setTimeout(settle, 0)
    })
  }
  const channel = new MessageChannel()
  return new Promise<void>((resolve) => {
    const settle = (): void => {
      signal.removeEventListener('abort', settle)
      channel.port1.close()
      channel.port2.close()
      resolve()
    }
    channel.port1.addEventListener('message', settle)
    signal.addEventListener('abort', settle, { once: true })
    channel.port1.start()
    channel.port2.postMessage(undefined)
  })
}
