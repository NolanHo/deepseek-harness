/**
 * Opt-in SQLite persistence provider. Logical sessions follow the handle
 * seam; the physical backend keeps schema-20 rows and restores stored logs
 * through the released format catalog.
 * @module @deepseek-ai/dsh-session-persistence-sqlite
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  SESSION_FORMAT_VERSION,
  SessionLogOffset,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import {
  SessionAlreadyExistsError,
  SessionPersistence,
  SessionPersistenceNotFoundError,
  materializeCreateHeader,
  matchesListSelection,
  type SessionHandle,
  type SessionPersistenceCreateOptions,
  type SessionPersistenceListOptions,
  type SessionPersistenceOpenOptions,
  type SessionPersistenceSnapshot,
  type SessionPersistenceStatOptions,
} from '@deepseek-ai/dsh-session-persistence'
import type { SessionAccess } from '@deepseek-ai/dsh-session-persistence'
import {
  SqliteBackendTracker,
  SqliteSessionHandle,
  type SqliteHandleStorage,
  type SqliteHandleState,
} from './handle.ts'
import type { JournalMode } from './schema.ts'
import { SqliteStore } from './store.ts'

export { SCHEMA_VERSION } from './schema.ts'

/** Default wait for another SQLite connection's write reservation. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000
/** Largest busy timeout accepted by SQLite's signed millisecond interface. */
export const MAX_BUSY_TIMEOUT_MS = 2_147_483_647
/** Largest page cache magnitude inside SQLite's signed 32-bit KiB range (INT32_MAX). */
export const MAX_CACHE_SIZE_KIB = 2_147_483_647
/** Default live-event coalescing window; not a backend completion deadline. */
export const DEFAULT_WRITE_BATCH_MAX_DELAY_MS = 200
/** Largest live-event coalescing window accepted by the fixed timer interface. */
export const MAX_WRITE_BATCH_DELAY_MS = 2_147_483_647

/** Plugin configuration. */
export interface Config {
  /** SQLite database path, or `:memory:` for an in-process database. */
  path: string
  /** Durable SQLite journal mode; defaults to `wal`. */
  journalMode?: JournalMode
  /** Maximum wait for another SQLite connection's lock; defaults to 5,000 ms. */
  busyTimeoutMs?: number
  /**
   * SQLite page cache per connection, in KiB. Omitting the field, or leaving
   * its `cordis.yml` value empty (an explicit null), executes no pragma and
   * keeps SQLite's default suggestion of 2,000 KiB (`-2000`, about 1.95 MiB);
   * `0` applies `-0`, a zero-page suggestion SQLite floors to its 10-page
   * minimum rather than its default.
   */
  cacheSizeKib?: number
  /** Fixed live-event coalescing window; not a backend completion deadline. */
  writeBatchMaxDelayMs?: number
  /**
   * Decompress stored session logs on the libuv thread pool instead of the
   * thread that reads them; defaults to `false`. Fork patch (FORK_SURFACE.md).
   *
   * A cold read decompresses every packed data column of the log, and the
   * synchronous decoder blocks the event loop for as long as that takes. This
   * switch hands those columns to `zlib.zstdDecompress` — same dictionary, same
   * result bytes, same stored rows — so the read yields between rows and
   * concurrent cold reads decompress in parallel up to the pool size
   * (`UV_THREADPOOL_SIZE`). Compression and the decodes a write transaction
   * holds stay synchronous, which keeps both states writing identical rows and
   * lets this switch be bisected or rolled back on its own.
   */
  asyncCodec?: boolean
  /**
   * Whole decoded logs one connection may retain, in decoded JSON text bytes;
   * `0` disables the cache and every read decodes afresh. Fork patch
   * (FORK_SURFACE.md).
   *
   * A cold read decompresses, parses, validates, and freezes every stored row.
   * Resuming a large session, and every other full-log read, repeats that work
   * on data that has not changed; a retained log answers the repeat with the
   * objects the first read already produced. Retention is only ever a hit on
   * the revision read from the session row in the same call that asks for it,
   * and every write path bumps that revision in the transaction that changes
   * the rows, so a hit cannot return events the database no longer holds —
   * named here because the deployment sizes the ceiling, while correctness
   * rests on that revision check rather than on invalidation.
   * @default 0
   */
  decodedLogCacheBytes?: number
}

/**
 * SQLite `SessionPersistence` provider with a schema-owned physical codec.
 */
export class SqliteSessionPersistence extends SessionPersistence {
  override readonly name = 'session-persistence-sqlite'

  static Config: z<Config> = z.object({
    path: z.string().required(),
    journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
    busyTimeoutMs: z.number().step(1).min(0).max(MAX_BUSY_TIMEOUT_MS).default(DEFAULT_BUSY_TIMEOUT_MS),
    cacheSizeKib: z.number().step(1).min(0).max(MAX_CACHE_SIZE_KIB),
    writeBatchMaxDelayMs: z.number().step(1).min(1).max(MAX_WRITE_BATCH_DELAY_MS)
      .default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS),
    asyncCodec: z.boolean().default(false),
    decodedLogCacheBytes: z.natural().default(0),
  })

  private readonly store: SqliteStore
  private readonly tracker: SqliteBackendTracker
  private readonly writeBatchMaxDelayMs: number

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    this.writeBatchMaxDelayMs = config.writeBatchMaxDelayMs ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS
    this.store = new SqliteStore({
      path: config.path,
      journalMode: config.journalMode ?? 'wal',
      busyTimeoutMs: config.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
      // A YAML `cacheSizeKib:` left valueless arrives as null through the
      // schema — outside the field's declared type, hence the widening — and
      // keeps SQLite's default exactly like an omitted field.
      ...config.cacheSizeKib === undefined || (config.cacheSizeKib as unknown) === null
        ? {}
        : { cacheSizeKib: config.cacheSizeKib },
      asyncCodec: config.asyncCodec ?? false,
      decodedLogCacheBytes: config.decodedLogCacheBytes ?? 0,
    })
    this.tracker = new SqliteBackendTracker(this.name)
    // Registered before the tracker's teardown so disposal closes every open
    // handle (draining routed events) before the database connection.
    ctx.effect(() => () => this.store.close(), `${this.name} database connection`)
    this.tracker.install(ctx)
  }

  /** Reject self-contained path and ownership failures without loading Node SQLite. */
  protected async [Service.init](): Promise<void> {
    await this.store.validatePath()
  }

  /**
   * Create a new stored session and take its write ownership. The session is
   * visible to this process immediately; the physical row appears on the
   * first append or flush.
   * @param header - the immutable header to store.
   * @param options - optional cancellation and the exact fork-inherited cut.
   * @returns the owned write handle.
   */
  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    const snapshot = materializeCreateHeader(header)
    const inheritedEventCount = storageCut(snapshot, options?.inheritedEventCount)
    await this.store.validatePath()
    options?.signal?.throwIfAborted()
    if (await this.store.hasSession(snapshot.id, options?.signal)) {
      throw new SessionAlreadyExistsError(snapshot.id)
    }
    options?.signal?.throwIfAborted()
    this.tracker.registerCreated(snapshot, inheritedEventCount)
    return this.tracker.adopt(new SqliteSessionHandle(
      this.handleStorage(),
      snapshot.id,
      snapshot,
      'write',
      { cursor: 0, materialized: false, inheritedEventCount },
      this.writeBatchMaxDelayMs,
    ))
  }

  /**
   * Open an existing stored session for `read` or single-writer `write`.
   * A write open of a historical-format session publishes the migrated log
   * durably before granting access.
   * @param id - the stored session to open.
   * @param access - `read` (no ownership) or `write` (atomic in-process claim).
   * @param options - optional cancellation.
   * @returns the open handle.
   */
  async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    await this.store.validatePath()
    options?.signal?.throwIfAborted()
    if (access === 'read') {
      const pending = this.tracker.pendingOf(id)
      if (pending !== undefined) {
        return this.tracker.adopt(new SqliteSessionHandle(
          this.handleStorage(),
          id,
          pending.header,
          'read',
          { cursor: 0, materialized: false, inheritedEventCount: pending.inheritedEventCount },
          this.writeBatchMaxDelayMs,
        ))
      }
      const stored = await this.store.loadStoredLog(id, options?.signal)
      if (stored === undefined) throw new SessionPersistenceNotFoundError(id)
      return this.tracker.adopt(new SqliteSessionHandle(
        this.handleStorage(),
        id,
        stored.meta,
        'read',
        { cursor: 0, materialized: true, inheritedEventCount: stored.inheritedEventCount },
        this.writeBatchMaxDelayMs,
      ))
    }
    this.tracker.claimWrite(id)
    try {
      const stored = await this.store.loadStoredLog(id, options?.signal)
      if (stored === undefined) throw new SessionPersistenceNotFoundError(id)
      if (stored.storedVersion !== SESSION_FORMAT_VERSION) {
        // Publish the migrated log before granting write access, so later
        // reads never mix stored-format generations in one session's rows.
        await this.store.publishStoredLog(
          { meta: stored.meta, inheritedEventCount: stored.inheritedEventCount },
          stored.events,
        )
        options?.signal?.throwIfAborted()
      }
      const state: SqliteHandleState = {
        cursor: stored.events.length,
        materialized: true,
        inheritedEventCount: stored.inheritedEventCount,
        // Publishing already replaced every row, so a torn tail survives
        // only on current-format opens.
        ...stored.storedVersion === SESSION_FORMAT_VERSION && stored.tornFrom !== undefined
          ? { tornTruncateTo: stored.tornFrom }
          : {},
      }
      return this.tracker.adopt(new SqliteSessionHandle(
        this.handleStorage(),
        id,
        stored.meta,
        'write',
        state,
        this.writeBatchMaxDelayMs,
      ))
    } catch (error: unknown) {
      this.tracker.releaseClaim(id)
      throw error
    }
  }

  /**
   * Flush every active write handle in one durability barrier; see the seam
   * contract.
   * @returns resolution once every write handle active at the call has flushed.
   */
  flush(): Promise<void> {
    return this.tracker.flushAll()
  }

  /**
   * Observe one stored session without reading its event log.
   * @param id - the stored session to observe.
   * @param options - optional cancellation.
   * @returns the snapshot, or `undefined` when the session does not exist.
   */
  async stat(
    id: SessionId,
    options?: SessionPersistenceStatOptions,
  ): Promise<SessionPersistenceSnapshot | undefined> {
    options?.signal?.throwIfAborted()
    await this.store.validatePath()
    options?.signal?.throwIfAborted()
    const pending = this.tracker.pendingOf(id)
    if (pending !== undefined) return { header: pending.header, revision: pending.revision }
    return this.store.stat(id, options?.signal)
  }

  /**
   * List the stored sessions visible to this process in a row selection:
   * durable rows selected in SQL, plus this process's created-but-unmaterialized
   * sessions that belong to the same selection.
   * @param options - optional cancellation and row selection.
   * @returns one snapshot per selected session, in no promised order.
   */
  async list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    const signal = options?.signal
    const snapshots: SessionPersistenceSnapshot[] = []
    const listed = new Set<SessionId>()
    // Snapshot pending entries BEFORE scanning storage: a session whose first
    // append lands mid-scan is then still in this snapshot, so
    // create-to-list visibility never has a hole.
    const pending = [...this.tracker.pendingEntries()]
    for (const stored of await this.store.list(signal, options)) {
      listed.add(stored.header.id)
      snapshots.push({ header: stored.header, revision: stored.revision })
    }
    for (const [id, entry] of pending) {
      // A pending row never reaches the SQL scan, so the same selection is
      // applied to its in-memory header.
      if (!listed.has(id) && matchesListSelection(entry.header, options)) {
        snapshots.push({ header: entry.header, revision: entry.revision })
      }
    }
    signal?.throwIfAborted()
    return snapshots
  }

  /**
   * Fork-owned seek surface (see FORK_SURFACE.md row 36): whether this stored
   * session can answer a bounded seq window at all. Historical rows cannot —
   * their log restores into a re-based sequence space — so the gated fast
   * paths bail before paying a window read for them.
   * @param id - the stored session to probe.
   * @param signal - optional cancellation for backend read work.
   * @returns true when a direct suffix read is addressable for this session.
   */
  seekable(id: SessionId, signal?: AbortSignal): Promise<boolean> {
    return this.store.seekable(id, signal)
  }

  /**
   * Fork-owned seek surface (see FORK_SURFACE.md row 36): the indexed Nth
   * append-origin user-message cut behind the session-controller's page
   * boundary. The store answers in one scan; sequential media answers nothing.
   * @param id - the stored session to seek.
   * @param maxMessages - message count of the page cut.
   * @param beforeSeq - optional exclusive upper bound for older-page seeks.
   * @param signal - optional cancellation for backend read work.
   * @returns the cut seq, or `undefined` when no such message exists.
   */
  messageCut(id: SessionId, maxMessages: number, beforeSeq?: number, signal?: AbortSignal): Promise<number | undefined> {
    return this.store.userMessageCut(id, maxMessages, beforeSeq, signal)
  }

  /**
   * Fork-owned seek surface (see FORK_SURFACE.md row 36): read the stored
   * events from `fromSeq` onward for the session-controller's paged cold
   * history reads, optionally only up to an exclusive upper bound so an older
   * page never reads the rows past its own cut. Current-format sessions seek by
   * seq; historical sessions restore the whole log once and slice, which cannot
   * address an indexed cut (see the store's `seekable`).
   * @param id - the stored session to read.
   * @param fromSeq - first event offset to include.
   * @param throughSeqExclusive - optional exclusive upper bound; rows whose
   *   first logical seq is at or past it are neither read nor returned.
   * @param signal - optional cancellation for backend read work.
   * @returns the validated current-format suffix, including the highest stored
   *   logical seq this read observed (-1 for an empty log).
   */
  readFrom(
    id: SessionId,
    fromSeq: number,
    throughSeqExclusive?: number,
    signal?: AbortSignal,
  ): Promise<{
    meta: SessionHeader
    inheritedEventCount: SessionLogOffset
    events: readonly SessionEvent[]
    storedEnd: number
  }> {
    return this.store.loadStoredFrom(id, fromSeq, throughSeqExclusive, signal).then((stored) => {
      if (stored === undefined) throw new SessionPersistenceNotFoundError(id)
      return stored
    })
  }

  /** The handle-facing storage adapter delegating physical work to the store. */
  private handleStorage(): SqliteHandleStorage {
    return {
      persistBatch: (header, events, isMaterialized, inheritedEventCount) =>
        this.store.appendBatch({ meta: header, inheritedEventCount }, events, isMaterialized)
          .then(() => { this.tracker.materialized(header.id) }),
      persistHeader: (header, inheritedEventCount) =>
        this.store.materializeHeader({ meta: header, inheritedEventCount })
          .then(() => { this.tracker.materialized(header.id) }),
      truncateTornTail: (header, inheritedEventCount, tornMarker) =>
        this.store.commitRepair({ meta: header, inheritedEventCount }, tornMarker, []),
      truncateLog: (header, inheritedEventCount, toSeq, appended) =>
        this.store.truncateLog({ meta: header, inheritedEventCount }, toSeq, appended),
      readStoredLog: async (id, signal) => {
        const stored = await this.store.loadStoredLog(id, signal)
        if (stored === undefined) throw new SessionPersistenceNotFoundError(id)
        return { eventState: 'shared-frozen', events: stored.events, revision: stored.revision }
      },
      hasPendingSession: id => this.tracker.hasPending(id),
      releaseHandle: (handle, materialized) => {
        this.tracker.release(handle, materialized)
      },
    }
  }
}

/** Validate and normalize the exact fork cut paired with one header. */
function storageCut(meta: SessionHeader, inheritedEventCount?: SessionLogOffset): SessionLogOffset {
  if (meta.isSeeded && inheritedEventCount === undefined) {
    throw new TypeError('seeded session metadata requires an inherited event count')
  }
  const cut = SessionLogOffset(inheritedEventCount ?? 0)
  if (!meta.isSeeded && cut !== 0) {
    throw new TypeError('unseeded session metadata inherited event count must be 0')
  }
  return cut
}

export default SqliteSessionPersistence
