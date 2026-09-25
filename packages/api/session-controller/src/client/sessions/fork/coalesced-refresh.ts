// Fork-owned activity-and-rebuild-churn module (see FORK_SURFACE.md): the list
// rebuild chain runs only when something a consumer can read changed. Ambient
// `api-session/activity` streams buffer per session instead of rebuilding the
// list on every event render, an accepted projection frame that republishes the
// value its row already holds is silent, and a rebuild whose rows, order, and
// state all match keeps the state the store publishes.

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionSnapshot } from '../manager.ts'
import type { SessionListState, SessionSummary } from '../service.ts'

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

/**
 * Whether an accepted projection frame republishes the value its row already
 * holds. `Object.is` on the published value is the whole test: every read of a
 * row — the key face's snapshot, `get`, `values()` — answers with `row.value`
 * itself, so an equal value leaves each of them identical for a consumer that
 * compares by reference. Structural comparison is deliberately absent: a frame
 * carrying a rebuilt value with equal fields is a different reference and stays
 * a change.
 * @param row - the row the key currently holds, or undefined without one.
 * @param value - the whole value the accepted frame carries.
 * @returns true when the frame publishes the value the row already holds.
 */
export function sameProjectionValue(row: { readonly value: unknown } | undefined, value: unknown): boolean {
  return row !== undefined && Object.is(row.value, value)
}

/**
 * Every field a projected list row publishes. `sameFields` compares exactly
 * these, so a field added to `SessionSummary` without being listed here would
 * let the store keep a stale row: extend this list with the field.
 */
const SUMMARY_FIELDS = [
  'id', 'title', 'displayTitle', 'cwd', 'parentId', 'origin', 'running', 'retainedBy', 'blank', 'updatedAt', 'projectionValues',
] as const satisfies readonly (keyof SessionSummary)[]

/**
 * Every field a session's projection snapshot publishes; extend it with any
 * field `SessionProjectionSnapshot` gains, for the reason above.
 */
const PROJECTION_FIELDS = [
  'values', 'state', 'error',
] as const satisfies readonly (keyof SessionProjectionSnapshot)[]

/**
 * Whether two records publish the same value for every listed field.
 * @param fields - the published fields to compare.
 * @param previous - the record the store publishes.
 * @param rebuilt - the record this rebuild computed.
 * @returns true when every listed field matches.
 */
function sameFields<T extends object>(fields: readonly (keyof T)[], previous: T, rebuilt: T): boolean {
  return fields.every(field => Object.is(previous[field], rebuilt[field]))
}

/**
 * Whether two rebuilds published the same sessions in the same order.
 * @param previous - the ids the store publishes.
 * @param rebuilt - the ids this rebuild computed.
 * @returns true when both carry the same identities in the same positions.
 */
function sameOrder(previous: readonly SessionId[], rebuilt: readonly SessionId[]): boolean {
  return previous.length === rebuilt.length && rebuilt.every((id, index) => previous[index] === id)
}

/**
 * Whether two rows-by-id records expose the same identities with the same row
 * objects (the caller hands in already-reconciled rows).
 * @param previous - the rows the store publishes.
 * @param rebuilt - the reconciled rows this rebuild would publish.
 * @returns true when both expose the same ids bound to the same objects.
 */
function sameRecords<T>(
  previous: Readonly<Record<SessionId, T>>,
  rebuilt: Readonly<Record<SessionId, T>>,
): boolean {
  const ids = Object.keys(rebuilt)
  return ids.length === Object.keys(previous).length
    && ids.every(id => previous[id as SessionId] === rebuilt[id as SessionId])
}

/**
 * Whether two projection records expose the same sessions with the same values
 * and the same explicit-read lifecycle.
 * @param previous - the projection snapshots the store publishes.
 * @param rebuilt - the projection snapshots this rebuild computed.
 * @returns true when every session carries an equal snapshot.
 */
function sameProjections(
  previous: Readonly<Record<SessionId, SessionProjectionSnapshot>>,
  rebuilt: Readonly<Record<SessionId, SessionProjectionSnapshot>>,
): boolean {
  const entries = Object.entries(rebuilt)
  if (entries.length !== Object.keys(previous).length) return false
  return entries.every(([id, snapshot]) => {
    const published = previous[id as SessionId]
    return published !== undefined && sameFields(PROJECTION_FIELDS, published, snapshot)
  })
}

/**
 * Reconcile one list rebuild with the state the store publishes. Every row
 * whose published fields all match keeps the object the store already holds —
 * row identity is what row-level memoization and the workspace browser key on —
 * and the state object itself is returned unchanged when the rebuild publishes
 * nothing a consumer can read differently, so a caller that skips the store
 * write for an unchanged state notifies no subscriber and renders nothing.
 * @param previous - the state `sessions.list` currently publishes.
 * @param rebuilt - the state this rebuild computed from the manager snapshot.
 * @returns the state to publish, or `previous` itself when nothing observable changed.
 */
export function reconcileListState(previous: SessionListState, rebuilt: SessionListState): SessionListState {
  const byId: Record<SessionId, SessionSummary> = {}
  for (const [id, row] of Object.entries(rebuilt.byId)) {
    const published = previous.byId[id as SessionId]
    byId[id as SessionId] = published !== undefined && sameFields(SUMMARY_FIELDS, published, row)
      ? published
      : row
  }
  if (previous.phase === rebuilt.phase
    && sameOrder(previous.ids, rebuilt.ids)
    && sameRecords(previous.byId, byId)
    && sameProjections(previous.projectionsBySession, rebuilt.projectionsBySession)) return previous
  return { ids: rebuilt.ids, byId, phase: rebuilt.phase, projectionsBySession: rebuilt.projectionsBySession }
}
