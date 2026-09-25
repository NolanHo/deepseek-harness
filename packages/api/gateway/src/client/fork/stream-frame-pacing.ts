/** Fork-owned journal frame pacing (see FORK_SURFACE.md): the journal consumer
 * returns to the event loop between bounded batches of decoded frames instead
 * of draining a whole WebSocket message burst in one task. */

/**
 * Consumer work allowed in one event-loop turn, in milliseconds.
 *
 * The deployed client was measured under a 4x CPU throttling rate, where 4 ms of
 * folding work becomes about one 60 Hz frame (16 ms) of wall time; bounding a
 * batch here keeps the work of a single turn at that size so the renderer still
 * gets the next turn. The budget is measured from the last yield, so it also
 * ends the batch on a frame whose own work alone reaches it.
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

/** Budget one stream has spent since its last return to the event loop. */
interface TurnBudget {
  /** Frames recorded since the last yield. */
  frames: number
  /** Clock reading of the last yield, or of the first recorded frame. */
  startedAt: number
}

/**
 * Pacing state per stream lifetime, keyed by the stream's cancellation signal:
 * two consumers draining in the same turn must not inherit each other's spent
 * budget, and a disposed stream's entry becomes collectable with its signal.
 */
const turnBudgets = new WeakMap<AbortSignal, TurnBudget>()

/**
 * Record one consumed frame and yield to the event loop once a batch budget is
 * spent.
 *
 * Called between fully processed frames — the caller published the previous
 * frame before this call — so nothing here interrupts a frame's own work. A
 * batch ends when either `FRAME_PACING_FRAME_BUDGET` frames were recorded or
 * `performance.now() - startedAt` reaches `FRAME_PACING_TIME_BUDGET_MS`, where
 * `startedAt` is the time of the last yield, or of the first recorded frame
 * before any yield. The budget covers the wait for the next frame too, so a
 * stream that spends the whole budget on one frame returns to the event loop
 * once per frame; a turn carries at most one frame's own work plus the cheap
 * frames that fit the remaining budget.
 *
 * @param signal - cancellation lifetime of the stream being consumed; the wait settles as soon as it aborts.
 * @returns after the frame is recorded and, when a batch budget was spent, after the host ran one macrotask.
 */
export async function afterFrame(signal: AbortSignal): Promise<void> {
  const now = performance.now()
  let budget = turnBudgets.get(signal)
  if (budget === undefined) {
    budget = { frames: 0, startedAt: now }
    turnBudgets.set(signal, budget)
  }
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
 * `MessageChannel` carries the wait because a hidden page throttles timers to
 * about one per second, which would drag out a backgrounded Session's stream.
 *
 * @param signal - cancellation lifetime raced against the wait.
 * @returns when the macrotask ran or the signal aborted, whichever happened first.
 */
function yieldToEventLoop(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
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
