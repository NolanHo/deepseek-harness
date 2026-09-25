/**
 * Durable session-persistence Service Definition (`ctx.sessionPersistence`). Backends store
 * {@link SessionEvent}s as the event-sourced log and carry non-replayable
 * {@link SessionHeader} metadata separately; callers address one stored
 * session through a {@link SessionHandle} obtained from `create`/`open`.
 * @module @deepseek-ai/dsh-session-persistence
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionHandle, SessionAccess } from './handle.ts'
import type { SessionPersistenceRevision } from './revision.ts'

// Re-export the metadata vocabulary so Consumers import it from the Service Definition.
export type { SessionHeader } from '@deepseek-ai/dsh-session'
export { SessionPersistenceRevision } from './revision.ts'
export type {
  SessionAccess,
  SessionHandle,
  SessionHandleAppendOptions,
  SessionHandleFlushOptions,
  SessionHandleReadOptions,
  SessionHandleReadResult,
  SessionHandleTruncateOptions,
} from './handle.ts'
export {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionFormatUnsupportedError,
  SessionHandleClosedError,
  SessionOwnershipLostError,
  SessionPersistenceCorruptionError,
  SessionPersistenceNotFoundError,
  SessionReadOnlyError,
  sessionFormatVersionRefusal,
} from './errors.ts'
export type { SessionLocation } from './errors.ts'
export {
  assertContiguous,
  assertStoredId,
  assertVersion,
  materializeAppendBatch,
  materializeCreateHeader,
  validateStoredEvents,
} from './storage-contract.ts'

/**
 * Lightweight stored-session observation returned by {@link SessionPersistence.stat}
 * and {@link SessionPersistence.list} without reading the full event log.
 */
export interface SessionPersistenceSnapshot {
  /** Detached metadata for one stored session. */
  readonly header: SessionHeader
  /** Opaque change token; see {@link SessionPersistence.stat}. */
  readonly revision: SessionPersistenceRevision
  /** Logical event count, when the backend can provide it cheaply from metadata; otherwise absent. */
  readonly eventCount?: number
  /** Physical artifact byte size, when the backend can provide it cheaply (JSONL); otherwise absent. */
  readonly sizeBytes?: number
}

/** Options for {@link SessionPersistence.create}. */
export interface SessionPersistenceCreateOptions {
  /** Optional cancellation observed before backend work starts. */
  readonly signal?: AbortSignal
  /**
   * Exact fork-inherited prefix length. Required when `header.isSeeded` is
   * true and must be omitted (or `0`) otherwise; the backend refuses a
   * mismatch at create.
   */
  readonly inheritedEventCount?: SessionLogOffset
}

/**
 * Logical Session header paired with its exact inherited cut for body-bearing
 * storage operations. `isSeeded` marks fork lineage on the header; the
 * numeric cut travels beside it, never inside the replayable event log.
 */
export interface SessionStorageMetadata {
  /** Validated immutable Session header. */
  readonly meta: SessionHeader
  /** Number of leading events inherited from the Session's fork parent. */
  readonly inheritedEventCount: SessionLogOffset
}

/** Immutable logical session read: storage metadata plus the complete validated event log. */
export interface SessionInspection extends SessionStorageMetadata {
  /** Contiguous validated events from seq 0. */
  readonly events: readonly SessionEvent[]
}

/** Options for {@link SessionPersistence.open}. */
export interface SessionPersistenceOpenOptions {
  /** Optional cancellation observed before backend work starts. */
  readonly signal?: AbortSignal
}

/** Options for {@link SessionPersistence.stat}. */
export interface SessionPersistenceStatOptions {
  /** Optional cancellation for backend metadata reads. */
  readonly signal?: AbortSignal
}

/** Row selection over stored session headers; absent keeps every row. */
export interface SessionPersistenceListSelection {
  /**
   * Origin selection: `listed` keeps every row whose `origin` is not
   * `subagent` — roots and fork children alike — while `all` keeps every row.
   * Defaults to `all`.
   */
  readonly scope?: 'listed' | 'all'
  /**
   * When set, the selection keeps exactly the rows whose `parentSession` is
   * this id, whatever their origin, and ignores
   * {@link SessionPersistenceListSelection.scope}.
   */
  readonly parentSessionId?: SessionId
}

/** Options for {@link SessionPersistence.list}. */
export interface SessionPersistenceListOptions extends SessionPersistenceListSelection {
  /** Optional cancellation for backend listing work. */
  readonly signal?: AbortSignal
}

/**
 * Whether one stored header belongs to a listing selection. A backend applies
 * this to every header its storage cannot select in the read — a
 * created-but-unmaterialized session, or an artifact whose header the backend
 * must read anyway — so one listing never mixes selections.
 * @param header - candidate stored header.
 * @param selection - row selection; absent keeps every header.
 * @returns true when the header belongs to the selection.
 */
export function matchesListSelection(
  header: SessionHeader,
  selection?: SessionPersistenceListSelection,
): boolean {
  if (selection?.parentSessionId !== undefined) return header.parentSession === selection.parentSessionId
  if (selection?.scope === 'listed') return header.origin !== 'subagent'
  return true
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionPersistence: SessionPersistence
  }
}

/**
 * Durable session storage addressed through per-session handles.
 *
 * Storage semantics shared by every backend: events are contiguous from seq 0;
 * `append` never rewrites committed events, and the one committed-log rewrite
 * is the optional write-handle {@link SessionHandle.truncate} — a backend may
 * omit it, and a consumer that needs the rewrite fails loud on a backend
 * without the capability. A torn physical tail is never returned to a reader
 * and is truncated by the write path before its first append; reads validate
 * current-format records only and refuse unknown vocabulary fail-closed.
 * `append` persists best-effort; `flush` — per handle or service-wide — is
 * the durability barrier.
 *
 * Fork patch (FORK_SURFACE.md): the paragraph above drops upstream's absolute
 * never-rewritten claim for this one truncation path (`append` still never
 * rewrites committed events).
 *
 * Visibility: a created session is observable through `stat`/`list`/`open`
 * in this process from the moment `create` resolves, even while a backend
 * defers physical materialization (a pure optimization); other processes see
 * the session only once it materializes, and a session that never
 * materialized before a crash never existed. `SessionHandle.flush` forces
 * materialization.
 *
 * Freshness: once an `append` or `flush` resolves, reads started afterwards
 * on this backend instance observe at least that prefix.
 */
export abstract class SessionPersistence extends Service {
  /** Process-local instance identity, stable through Context proxies and distinct after service replacement. */
  readonly identity: symbol = Symbol('sessionPersistence')

  constructor(ctx: Context) {
    super(ctx, 'sessionPersistence')
  }

  /**
   * Create a new stored session and take its write ownership.
   * @param header - the immutable header (id, version, cwd, lineage) to store.
   * @param options - optional cancellation.
   * @returns a `write` handle owned by the caller; close it to release ownership.
   * @throws {SessionAlreadyExistsError} when the id already exists.
   */
  abstract create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle>

  /**
   * Open an existing stored session.
   *
   * `read` never takes ownership and works while another handle (or process)
   * holds write ownership. `write` atomically claims single-writer ownership;
   * an existing active owner rejects.
   * @param id - the stored session to open.
   * @param access - `read` or `write`.
   * @param options - optional cancellation.
   * @returns the open handle.
   * @throws {SessionPersistenceNotFoundError} when the session does not exist.
   * @throws {SessionAlreadyOwnedError} for `write` when ownership is taken.
   */
  abstract open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle>

  /**
   * Flush every active write handle owned by this service instance in one
   * durability barrier: each handle's routed live events drain durably and
   * its session materializes, exactly as that handle's own
   * `SessionHandle.flush` would. Read handles buffer nothing and are
   * untouched. A handle closed concurrently counts as flushed — close itself
   * drains durably.
   * @returns resolution once every write handle active at the call has flushed.
   * @throws {AggregateError} naming each session whose flush failed; the
   *   remaining handles still flush.
   */
  abstract flush(): Promise<void>

  /**
   * Observe one stored session without reading its event log or taking
   * ownership.
   *
   * The snapshot's `revision` is an opaque change token comparable only
   * against revisions from the same service instance and session id: equal
   * revisions may be treated as an unchanged log; unequal revisions promise
   * nothing. Write-ownership churn does not change a revision. It exists for
   * derived read-model caches keyed off `stat`/`list`; it plays no part in
   * open, read, or resume.
   * @param id - the stored session to observe.
   * @param options - optional cancellation.
   * @returns the snapshot, or `undefined` when the session does not exist.
   */
  abstract stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined>

  /**
   * List every stored session visible to this process, in no promised order.
   *
   * A backend may push the row selection into its own read so an excluded row
   * is never decoded; one that cannot select in storage returns every row, and
   * the caller applies the same selection to the returned headers.
   * @param options - optional cancellation and row selection.
   * @returns one snapshot per stored session in the selection.
   */
  abstract list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]>
}

export default SessionPersistence
