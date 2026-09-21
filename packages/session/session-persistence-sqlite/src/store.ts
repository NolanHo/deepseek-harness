/**
 * SQLite storage primitives: transactional append-batch packing, physical
 * reads through the released format restore, schema validation, revisions,
 * repair, and lifecycle closure.
 * @module @deepseek-ai/dsh-session-persistence-sqlite/store
 */

import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionLogOffset,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import {
  SessionPersistenceCorruptionError,
  SessionPersistenceRevision,
  validateStoredEvents,
  type SessionStorageMetadata,
} from '@deepseek-ai/dsh-session-persistence'
import { type StoredLogicalEvent, MAX_PACKED_ROW_MEMBERS, packChunkRuns } from './codec.ts'
import {
  bindRecord,
  decodeRow,
  scanRows,
  scanRowsOnThreadPool,
  type BoundRecord,
  type StoredRowScan,
} from './compression.ts'
import { restoreStoredHeader, restoreStoredLog } from './restore.ts'
import {
  type EventRow,
  type JournalMode,
  currentHeaderOf,
  decodeEventRow,
  decodeSessionRow,
  decodeStoreIdentity,
  openDatabase,
  storedPhysicalHeaderOf,
  validateSchemaForMutation,
  type SessionRow,
} from './schema.ts'
import { sql } from './sql.ts'

/** Storage options resolved by the service provider. */
export interface SqliteStoreOptions {
  readonly path: string
  readonly journalMode: JournalMode
  readonly busyTimeoutMs: number
  /** SQLite page cache per connection, in KiB; omitted keeps SQLite's default. */
  readonly cacheSizeKib?: number
  /**
   * Decompress stored logs on the libuv thread pool instead of the calling
   * thread; the provider's `asyncCodec` configuration owns the choice, and an
   * omitted value keeps the synchronous behavior.
   */
  readonly asyncCodec?: boolean
  /**
   * Whole decoded logs this connection may retain, in decoded JSON text bytes;
   * an omitted or zero value retains nothing.
   */
  readonly decodedLogCacheBytes?: number
}

/** One cached whole-log read: the restored log and the bytes it is charged. */
interface DecodedLogCacheEntry {
  /** Revision this log was read at; a hit requires the same revision again. */
  readonly revision: SessionPersistenceRevision
  /** The restored, validated log returned to every hit unchanged. */
  readonly log: SqliteStoredLog
  /** UTF-8 byte length of the log's decoded JSON text. */
  readonly bytes: number
}

/** One stored log restored and validated to the current logical format. */
export interface SqliteStoredLog {
  /** Validated immutable current-format header. */
  readonly meta: SessionHeader
  /** Exact fork-inherited prefix length in current coordinates. */
  readonly inheritedEventCount: SessionLogOffset
  /** Validated, deeply frozen current-format events. */
  readonly events: readonly SessionEvent[]
  /** Source-qualified revision token for this stored log. */
  readonly revision: SessionPersistenceRevision
  /** The stored physical header version this log was restored from. */
  readonly storedVersion: number
  /** Physical deletion base for a torn tail, when the stored log ends torn. */
  readonly tornFrom?: number
}

/** One validated current-format suffix read for the seek-capable fork surface. */
export interface SqliteStoredSuffix {
  readonly meta: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  /** Valid contiguous current-format events with `seq >= fromSeq`. */
  readonly events: readonly SessionEvent[]
}

/** One lightweight stored-session observation: migrated header plus revision. */
export interface SqliteStoredSnapshot {
  readonly header: SessionHeader
  readonly revision: SessionPersistenceRevision
}

/** SQLite implementation of the physical storage hooks behind the session handle. */
export class SqliteStore {
  /** Backend label this store reports in rollback failure diagnostics. */
  readonly name = 'session-persistence-sqlite'
  private db!: DatabaseSync
  private databaseConstructor!: typeof import('node:sqlite')['DatabaseSync']
  private storeIdentity!: string
  private databasePath!: string
  private opened = false
  private pathReady: Promise<void> | undefined
  private ready: Promise<void> | undefined
  /**
   * Row scan for stored logs. Fork patch (FORK_SURFACE.md): only the scans that
   * read outside a transaction use it. A decode that runs while this store
   * holds a write transaction stays synchronous, so no await can leave a
   * transaction open across another statement on the connection.
   *
   * Awaiting this scan widens the gap between the read transaction that
   * selected the rows and the scan that classifies them, so a concurrent
   * append, repair, or truncate can commit in between. The scan still
   * classifies exactly the rows that transaction returned, and every mutation
   * re-reads the stored tail inside its own immediate transaction and rejects a
   * stale base instead of acting on it.
   */
  private readonly scanStoredRows: StoredRowScan
  /**
   * Bounded LRU of whole decoded logs keyed by session id, oldest first. A hit
   * requires the revision just read from the session row in this same call, so
   * a write by any connection or process misses instead of returning events the
   * database no longer holds. Every local mutation drops its session's entry
   * and `close()` drops the whole map.
   */
  private readonly decodedLogs = new Map<SessionId, DecodedLogCacheEntry>()
  /** Decoded JSON text bytes currently charged across {@link decodedLogs}. */
  private retainedDecodedLogBytes = 0
  /** Configured ceiling on {@link retainedDecodedLogBytes}; zero retains nothing. */
  private readonly decodedLogCacheBytes: number

  constructor(private readonly options: SqliteStoreOptions) {
    this.scanStoredRows = options.asyncCodec === true ? scanRowsOnThreadPool : scanRows
    this.decodedLogCacheBytes = options.decodedLogCacheBytes ?? 0
  }

  /**
   * Validate filesystem ownership without importing or opening Node SQLite.
   * @returns settlement of the store's one path-validation operation.
   */
  validatePath(): Promise<void> {
    this.pathReady ??= this.preparePath(this.options.path)
    return this.pathReady
  }

  /**
   * Lazily open and validate the database on first persistence use.
   * @returns settlement of the store's one database-open operation.
   */
  open(): Promise<void> {
    this.ready ??= this.openDb()
    return this.ready
  }

  private async preparePath(path: string): Promise<void> {
    const actual = path === ':memory:' ? path : resolve(path)
    if (actual !== ':memory:') {
      await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
      await validateParentDirectory(dirname(actual))
      await validateDatabaseFileIfPresent(actual)
    }
    this.databasePath = actual
  }

  private async openDb(): Promise<void> {
    await this.validatePath()
    if (this.databasePath !== ':memory:') {
      await createDatabaseFile(this.databasePath)
      await validateDatabaseFile(this.databasePath)
    }
    const { DatabaseSync } = await loadNodeSqlite()
    this.databaseConstructor = DatabaseSync
    this.db = await openDatabase(
      DatabaseSync,
      this.databasePath,
      this.options.journalMode,
      this.options.busyTimeoutMs,
      this.options.cacheSizeKib,
    )
    try {
      const row = this.db.prepare(sql('select-store-id')).get()
      if (row === undefined) {
        throw new Error(`session database at "${this.databasePath}" has no valid store identity`)
      }
      let storeId: string
      try {
        storeId = decodeStoreIdentity(row)
      } catch (error: unknown) {
        throw new Error(`session database at "${this.databasePath}" has no valid store identity`, { cause: error })
      }
      if (this.databasePath === ':memory:') {
        this.storeIdentity = `memory:store:${storeId}`
      } else {
        const identity = statSync(this.databasePath, { bigint: true })
        this.storeIdentity = `file:${identity.dev}:${identity.ino}:${identity.birthtimeNs}:store:${storeId}`
      }
      this.opened = true
    } catch (error: unknown) {
      this.db.close()
      throw error
    }
  }

  /**
   * Read, restore, and validate one stored session as the current logical log.
   * A torn physical tail is never part of the returned events; its deletion
   * base is reported for the write path.
   * @param id - the stored session to load.
   * @param signal - optional cancellation for the metadata and event reads.
   * @returns the restored log, or `undefined` when the session is absent.
   */
  async loadStoredLog(id: SessionId, signal?: AbortSignal): Promise<SqliteStoredLog | undefined> {
    await this.observe(signal)
    const snapshot = this.readTransaction(() => {
      const row = this.rowFor(id)
      if (row === undefined) return undefined
      const eventRows = this.db.prepare(sql('select-events')).all(this.sessionKey(id)).map(decodeEventRow)
      return { row, eventRows }
    })
    signal?.throwIfAborted()
    if (snapshot === undefined) return undefined
    const revision = sqliteRevision(this.storeIdentity, snapshot.row)
    const cached = this.decodedLogs.get(id)
    if (cached !== undefined && cached.revision === revision) {
      // Re-insert at the newest end: the eviction scan below walks oldest first.
      this.decodedLogs.delete(id)
      this.decodedLogs.set(id, cached)
      return cached.log
    }
    const scanned = await this.scanStoredRows(snapshot.eventRows)
    const restored = restoreStoredLog(storedPhysicalHeaderOf(snapshot.row), scanned.preserved, id)
    if (snapshot.row.version === SESSION_FORMAT_VERSION
      && Number(restored.inheritedEventCount) !== (snapshot.row.seed_length ?? 0)) {
      throw new SessionPersistenceCorruptionError(
        `session "${id}" seed cut column disagrees with its log (${snapshot.row.seed_length ?? 0} vs ${restored.inheritedEventCount})`,
        { cause: new Error('stored inherited cut mismatch') },
      )
    }
    const log: SqliteStoredLog = {
      ...restored,
      revision,
      storedVersion: snapshot.row.version,
      ...scanned.tornFrom === undefined ? {} : { tornFrom: scanned.tornFrom },
    }
    this.memoizeDecodedLog(id, log, scanned.decodedBytes)
    return log
  }

  /**
   * Read the stored events from `fromSeq` onward. Current-format sessions use
   * the physical suffix seek; historical sessions restore the whole log once
   * and slice it.
   *
   * The historical arm cannot serve an indexed page cut: it filters the
   * restored, re-based log by a `fromSeq` taken from the stored physical
   * sequence, so any cut the index reports past the re-based end selects
   * nothing. Callers that plan a window from {@link userMessageCut} must gate
   * on {@link seekable} instead of relying on this arm.
   * @param id - the stored session to read.
   * @param fromSeq - first event offset to include, in the retired log's own seq space.
   * @param signal - optional cancellation for backend read work.
   * @returns the validated suffix, or `undefined` when the session is absent.
   */
  async loadStoredFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<SqliteStoredSuffix | undefined> {
    await this.observe(signal)
    const row = this.rowFor(id)
    signal?.throwIfAborted()
    if (row === undefined) return undefined
    if (row.version !== SESSION_FORMAT_VERSION) {
      const full = await this.loadStoredLog(id, signal)
      if (full === undefined) return undefined
      return {
        meta: full.meta,
        inheritedEventCount: full.inheritedEventCount,
        events: full.events.filter(event => event.seq >= fromSeq),
      }
    }
    const snapshot = this.readTransaction(() => ({
      row,
      ...this.physicalSpanFrom(this.sessionKey(id), fromSeq),
    }))
    signal?.throwIfAborted()
    const { preserved } = await this.scanStoredRows(snapshot.eventRows, snapshot.base)
    const meta = currentHeaderOf(row)
    const events = preserved.filter(event => event.seq >= fromSeq) as SessionEvent[]
    validateStoredEvents(meta, events)
    return {
      meta,
      inheritedEventCount: SessionLogOffset(row.seed_length ?? 0),
      events,
    }
  }

  /**
   * Whether a stored session row exists; opens the database on first use.
   * @param id - the stored session to probe.
   * @param signal - optional cancellation before or after the metadata query.
   * @returns true when the session exists in this store.
   */
  async hasSession(id: SessionId, signal?: AbortSignal): Promise<boolean> {
    await this.observe(signal)
    const exists = this.rowFor(id) !== undefined
    signal?.throwIfAborted()
    return exists
  }

  /**
   * Whether this session's stored rows can answer a bounded seq window.
   *
   * Only current-format rows can: {@link loadStoredFrom} restores a historical
   * row's whole log through the format catalog, whose sequence numbers are
   * re-based over the restored events, so the physical `seq` values in the
   * `events` table — and the cuts `userMessageCut` answers, which select on
   * that column — address a different space than the restored suffix. A caller
   * that plans window reads from a cut must therefore probe this first; it
   * reads session metadata only and never touches event rows.
   * @param id - the stored session to probe.
   * @param signal - optional cancellation before or after the metadata query.
   * @returns true when a direct suffix read is addressable for this session.
   */
  // Fork patch (FORK_SURFACE.md): the fork fast paths' cheap gate; the fork
  // page-boundary reads a window only when this answers true.
  async seekable(id: SessionId, signal?: AbortSignal): Promise<boolean> {
    await this.observe(signal)
    const row = this.rowFor(id)
    signal?.throwIfAborted()
    return row?.version === SESSION_FORMAT_VERSION
  }

  /**
   * Observe one stored session header plus its source-qualified revision
   * without reading event rows.
   * @param id - the stored session to observe.
   * @param signal - optional cancellation before or after the metadata query.
   * @returns the migrated header and revision, or `undefined` when absent.
   */
  async stat(id: SessionId, signal?: AbortSignal): Promise<SqliteStoredSnapshot | undefined> {
    await this.observe(signal)
    const row = this.rowFor(id)
    signal?.throwIfAborted()
    if (row === undefined) return undefined
    return {
      header: restoreStoredHeader(storedPhysicalHeaderOf(row), id),
      revision: sqliteRevision(this.storeIdentity, row),
    }
  }

  /**
   * List every stored session with its migrated header and source-qualified
   * revision, without loading event rows.
   * @param signal - optional cancellation before or after the metadata query.
   * @returns one snapshot per stored session.
   */
  async list(signal?: AbortSignal): Promise<SqliteStoredSnapshot[]> {
    await this.observe(signal)
    const rows = this.sessionRows()
    signal?.throwIfAborted()
    return rows.map(row => ({
      header: restoreStoredHeader(storedPhysicalHeaderOf(row), SessionId(row.id)),
      revision: sqliteRevision(this.storeIdentity, row),
    }))
  }

  /**
   * Answer the indexed Nth append-origin user-message cut; see the fork's
   * page-boundary surface. The store answers in one scan.
   * @param id - the stored session to seek.
   * @param maxMessages - message count of the page cut.
   * @param beforeSeq - optional exclusive upper bound for older-page seeks.
   * @param signal - optional cancellation before or after the query.
   * @returns the cut seq, or `undefined` when no such message exists.
   */
  async userMessageCut(id: SessionId, maxMessages: number, beforeSeq?: number, signal?: AbortSignal): Promise<number | undefined> {
    await this.observe(signal)
    const snapshot = this.readTransaction(() => {
      const row = this.rowFor(id)
      if (row === undefined) return undefined
      const sessionKey = this.sessionKey(id)
      const ranked = beforeSeq === undefined
        ? this.db.prepare(sql('select-user-message-cut')).all(sessionKey, maxMessages)
        : this.db.prepare(sql('select-user-message-cut-before')).all(sessionKey, beforeSeq, maxMessages)
      const last = ranked.at(-1)
      const cut = last === undefined ? null : (last as { cut: number | null }).cut
      return cut ?? null
    })
    signal?.throwIfAborted()
    return snapshot ?? undefined
  }

  /**
   * Durably append one contiguous batch; lazily materializes the session row
   * on the first write.
   * @param storage - the session's current-format metadata.
   * @param events - the contiguous batch, in seq order.
   * @param isMaterialized - whether the session row already exists.
   */
  async appendBatch(
    storage: SessionStorageMetadata,
    events: readonly StoredLogicalEvent[],
    isMaterialized: boolean,
  ): Promise<void> {
    await this.open()
    if (events.length === 0) return
    this.db.exec(sql('begin-immediate'))
    try {
      validateSchemaForMutation(this.databaseConstructor, this.db, this.databasePath)
      const sessionKey = isMaterialized ? this.sessionKey(storage.meta.id) : this.writeRow(storage)
      const tailRows = this.tailRows(sessionKey)
      const currentLast = this.logicalLastEvent(storage.meta.id, tailRows)
      const expected = currentLast === undefined ? 0 : currentLast.seq + 1
      const first = events[0] as StoredLogicalEvent
      if (first.seq !== expected) {
        throw new Error(`session ${storage.meta.id} append starts at seq ${first.seq}, stored next seq is ${expected}`)
      }

      const insert = this.insertStatement()
      for (const record of packChunkRuns(events as readonly SessionEvent[])) this.insertRecord(insert, sessionKey, bindRecord(record))
      this.incrementRevision(storage.meta.id)
      this.commitSessionMutation(storage.meta.id)
    } catch (error: unknown) {
      this.rollback(error, 'append')
    }
  }

  /**
   * Durably materialize a header-only row for an explicitly flushed empty session.
   * @param storage - the session's current-format metadata.
   */
  async materializeHeader(storage: SessionStorageMetadata): Promise<void> {
    await this.open()
    this.db.exec(sql('begin-immediate'))
    try {
      validateSchemaForMutation(this.databaseConstructor, this.db, this.databasePath)
      this.writeRow(storage)
      this.commitSessionMutation(storage.meta.id)
    } catch (error: unknown) {
      /* v8 ignore next -- validate/write failure uses the same transaction rollback path covered by append and repair. */
      this.rollback(error, 'materialize empty session')
    }
  }

  /**
   * Publish one restored historical log as the stored current format: replace
   * every event row with the migrated current-format events and stamp the
   * session row's version. Granting write access to a historical session
   * publishes it first, so later reads never mix stored-format generations.
   * @param storage - the migrated current-format metadata.
   * @param events - the migrated current-format log, in seq order.
   */
  async publishStoredLog(storage: SessionStorageMetadata, events: readonly SessionEvent[]): Promise<void> {
    await this.open()
    if (events.length === 0) {
      await this.materializeHeader(storage)
      return
    }
    this.db.exec(sql('begin-immediate'))
    try {
      validateSchemaForMutation(this.databaseConstructor, this.db, this.databasePath)
      const sessionKey = this.sessionKey(storage.meta.id)
      this.writeRow(storage)
      this.db.prepare(sql('delete-events-from')).run(sessionKey, 0)
      const insert = this.insertStatement()
      for (const record of packChunkRuns(events)) this.insertRecord(insert, sessionKey, bindRecord(record))
      this.incrementRevision(storage.meta.id)
      this.commitSessionMutation(storage.meta.id)
    } catch (error: unknown) {
      this.rollback(error, 'publish stored migration')
    }
  }

  /**
   * Durably truncate a torn physical tail and optionally append repair
   * closers, inside one transaction.
   * @param storage - the session's current-format metadata.
   * @param tornMarker - physical deletion base, or `undefined` to skip truncation.
   * @param closers - contiguous repair events appended after truncation.
   */
  async commitRepair(
    storage: SessionStorageMetadata,
    tornMarker: number | undefined,
    closers: readonly StoredLogicalEvent[],
  ): Promise<void> {
    await this.open()
    if (tornMarker === undefined && closers.length === 0) return
    this.db.exec(sql('begin-immediate'))
    try {
      validateSchemaForMutation(this.databaseConstructor, this.db, this.databasePath)
      const row = this.rowFor(storage.meta.id)
      if (row === undefined) throw new Error(`session ${storage.meta.id} metadata row is missing`)
      const sessionKey = this.sessionKey(storage.meta.id)
      const currentRows = this.db.prepare(sql('select-events')).all(sessionKey).map(decodeEventRow)
      const current = scanRows(currentRows)
      if (tornMarker !== undefined) {
        if (current.tornFrom !== tornMarker) {
          throw new Error(`session ${storage.meta.id} repair is stale: physical tail no longer starts at seq ${tornMarker}`)
        }
        this.db.prepare(sql('delete-events-from'))
          .run(sessionKey, tornMarker)
      } else if (current.tornFrom !== undefined) {
        throw new Error(`session ${storage.meta.id} repair omitted current torn tail at seq ${current.tornFrom}`)
      }
      if (closers.length > 0) {
        const expected = current.preserved.at(-1)?.seq === undefined
          ? 0
          : (current.preserved.at(-1) as StoredLogicalEvent).seq + 1
        if (closers[0]?.seq !== expected) {
          throw new Error(`session ${storage.meta.id} repair is stale: closer starts at seq ${closers[0]?.seq}, stored next seq is ${expected}`)
        }
        const insert = this.insertStatement()
        for (const closer of closers) this.insertRecord(insert, sessionKey, bindRecord(closer))
      }
      this.incrementRevision(storage.meta.id)
      this.commitSessionMutation(storage.meta.id)
    } catch (error: unknown) {
      this.rollback(error, 'repair')
    }
  }

  /**
   * Durably discard every stored event from `toSeq` on, so the stored
   * next-seq becomes exactly `toSeq`. A packed row whose run spans the cut is
   * rewritten to keep only its members below it — deleting the whole row would
   * drop committed events below the cut; when the retained members cannot be
   * re-encoded faithfully, the transaction rolls back and the error surfaces.
   * A cut at or past the stored end discards nothing (no revision bump).
   * @param storage - the session's current-format metadata.
   * @param toSeq - first logical seq to discard; must not enter the inherited prefix.
   * @param appended - events to land at the cut in the same transaction, in
   *   seq order starting at `toSeq`; empty for a plain discard.
   */
  async truncateLog(storage: SessionStorageMetadata, toSeq: number, appended: readonly SessionEvent[] = []): Promise<void> {
    await this.open()
    if (!Number.isSafeInteger(toSeq) || toSeq < 0) {
      throw new TypeError(`truncate offset must be a non-negative safe integer, got ${String(toSeq)}`)
    }
    if (toSeq < Number(storage.inheritedEventCount)) {
      throw new TypeError(
        `session ${storage.meta.id} truncate offset ${toSeq} enters the fork-inherited prefix (${storage.inheritedEventCount})`,
      )
    }
    this.db.exec(sql('begin-immediate'))
    try {
      validateSchemaForMutation(this.databaseConstructor, this.db, this.databasePath)
      const row = this.rowFor(storage.meta.id)
      if (row === undefined) throw new Error(`session ${storage.meta.id} metadata row is missing`)
      const sessionKey = this.sessionKey(storage.meta.id)
      const current = scanRows(this.db.prepare(sql('select-events')).all(sessionKey).map(decodeEventRow))
      if (toSeq >= current.preserved.length) {
        // The valid log already ends at or before the cut: nothing to discard,
        // and the appended batch is the caller's ordinary append to land.
        const insert = this.insertStatement()
        for (const record of packChunkRuns(appended)) this.insertRecord(insert, sessionKey, bindRecord(record))
        this.incrementRevision(storage.meta.id)
        this.commitSessionMutation(storage.meta.id)
        return
      }
      // A packed row whose run head sits below the cut may still span it; that
      // row alone is rewritten, every row at or past the cut is deleted whole.
      const spanning = this.packedRowSpanning(sessionKey, toSeq)
      this.db.prepare(sql('delete-events-from')).run(sessionKey, toSeq)
      if (spanning !== undefined) {
        this.db.prepare(sql('delete-event-row')).run(sessionKey, spanning.seq)
        const kept = decodeRow(spanning).filter(event => event.seq < toSeq)
        const insert = this.insertStatement()
        for (const record of packChunkRuns(kept as readonly SessionEvent[])) {
          this.insertRecord(insert, sessionKey, bindRecord(record))
        }
      }
      if (appended.length > 0) {
        const first = appended[0] as SessionEvent
        if (first.seq !== toSeq) {
          throw new TypeError(`session ${storage.meta.id} truncate landing batch starts at seq ${String(first.seq)}, expected the cut ${String(toSeq)}`)
        }
        const insert = this.insertStatement()
        for (const record of packChunkRuns(appended)) this.insertRecord(insert, sessionKey, bindRecord(record))
      }
      this.incrementRevision(storage.meta.id)
      this.commitSessionMutation(storage.meta.id)
    } catch (error: unknown) {
      this.rollback(error, 'truncate')
    }
  }

  /**
   * Release the database handle at disposal; a store whose open never
   * completed releases nothing, and no store operation may follow.
   */
  async close(): Promise<void> {
    if (this.ready === undefined) {
      if (this.pathReady !== undefined) await Promise.allSettled([this.pathReady])
      return
    }
    await Promise.allSettled([this.ready])
    if (!this.opened) return
    this.opened = false
    this.decodedLogs.clear()
    this.retainedDecodedLogBytes = 0
    this.db.close()
  }

  private rowFor(id: SessionId): SessionRow | undefined {
    const value = this.db.prepare(sql('select-session')).get(id)
    return value === undefined ? undefined : decodeSessionRow(value)
  }

  /**
   * Retain one decoded log for the next read at the same revision, then evict
   * least-recently-used entries until the retained bytes fit the configured
   * ceiling. A log larger than the whole ceiling is never retained.
   * @param id - the session this log belongs to.
   * @param log - the restored log a hit returns unchanged.
   * @param bytes - UTF-8 byte length of the log's decoded JSON text.
   */
  private memoizeDecodedLog(id: SessionId, log: SqliteStoredLog, bytes: number): void {
    this.forgetDecodedLog(id)
    if (this.decodedLogCacheBytes === 0 || bytes > this.decodedLogCacheBytes) return
    this.decodedLogs.set(id, { revision: log.revision, log, bytes })
    this.retainedDecodedLogBytes += bytes
    for (const oldest of this.decodedLogs.keys()) {
      if (this.retainedDecodedLogBytes <= this.decodedLogCacheBytes) break
      this.forgetDecodedLog(oldest)
    }
  }

  /**
   * Drop one session's retained log and release the bytes it was charged.
   * @param id - the session whose entry this call drops.
   */
  private forgetDecodedLog(id: SessionId): void {
    const entry = this.decodedLogs.get(id)
    if (entry === undefined) return
    this.decodedLogs.delete(id)
    this.retainedDecodedLogBytes -= entry.bytes
  }

  /**
   * Commit one transaction that changed a session's stored rows and drop that
   * session's retained log. The revision bump the transaction already made
   * forces the next read to miss; dropping the entry releases the bytes now
   * instead of holding a superseded log until the ceiling evicts it.
   * @param id - the session this transaction changed.
   */
  private commitSessionMutation(id: SessionId): void {
    this.db.exec(sql('commit'))
    this.forgetDecodedLog(id)
  }

  private sessionKey(id: SessionId): number {
    const row = this.db.prepare(sql('select-session-key')).get(id) as { id: number } | undefined
    if (row === undefined) throw new Error(`session ${id} metadata row is missing`)
    return row.id
  }

  private async observe(signal: AbortSignal | undefined): Promise<void> {
    signal?.throwIfAborted()
    await this.open()
    signal?.throwIfAborted()
  }

  private readTransaction<T>(read: () => T): T {
    this.db.exec(sql('begin'))
    try {
      const value = read()
      this.db.exec(sql('commit'))
      return value
    } catch (error: unknown) {
      this.rollback(error, 'read')
    }
  }

  private sessionRows(): SessionRow[] {
    return this.db.prepare(sql('select-sessions')).all().map(decodeSessionRow)
  }

  private rollback(error: unknown, operation: string): never {
    try {
      this.db.exec(sql('rollback'))
    } catch (rollbackError: unknown) {
      /* v8 ignore next -- requires SQLite to fail both an operation and its immediate rollback. */
      throw new AggregateError([error, rollbackError], `${this.name} ${operation} failed and rollback also failed`)
    }
    throw error
  }

  private incrementRevision(id: SessionId): void {
    const updated = this.db.prepare(sql('update-session-revision'))
      .run(id)
    /* v8 ignore next -- materialized writes follow coordinator create(); other writes upsert in this transaction. */
    if (Number(updated.changes) !== 1) throw new Error(`session ${id} metadata row is missing`)
  }

  private tailRows(sessionKey: number): EventRow[] {
    const tail = this.db.prepare(sql('select-tail-events')).all(sessionKey, 2).map(decodeEventRow).reverse()
    if (tail.length === 0) return []
    return this.physicalSpanFrom(sessionKey, (tail[0] as EventRow).seq).eventRows
  }

  /** Select the bounded physical span that may represent `fromSeq`. */
  private physicalSpanFrom(
    sessionKey: number,
    fromSeq: number,
  ): { readonly base: number; readonly eventRows: EventRow[] } {
    const packedFloor = Math.max(0, fromSeq - MAX_PACKED_ROW_MEMBERS + 1)
    const packedPredecessors = this.db.prepare(sql('select-packed-predecessors'))
      .all(sessionKey, packedFloor, fromSeq)
      .map(decodeEventRow)
    let base = fromSeq
    for (const predecessor of packedPredecessors) {
      try {
        const last = decodeRow(predecessor).at(-1)
        if (last !== undefined && last.seq >= fromSeq) base = Math.min(base, predecessor.seq)
      } catch {
        // A malformed bounded predecessor may cover fromSeq; include it so the scanner fails closed.
        base = Math.min(base, predecessor.seq)
      }
    }
    const eventRows = this.db.prepare(sql('select-events-from')).all(sessionKey, base).map(decodeEventRow)
    return { base, eventRows }
  }

  /**
   * The packed row whose logical span includes `toSeq`, or `undefined` when
   * the cut lands at a row boundary. Row spans below the cut are contiguous
   * (validated by the caller's `scanRows`), so at most one row can span.
   * @param sessionKey - integer key of the session being truncated.
   * @param toSeq - first logical seq to discard.
   * @returns the spanning packed row.
   */
  private packedRowSpanning(sessionKey: number, toSeq: number): EventRow | undefined {
    const floor = Math.max(0, toSeq - MAX_PACKED_ROW_MEMBERS + 1)
    const predecessors = this.db.prepare(sql('select-packed-predecessors'))
      .all(sessionKey, floor, toSeq)
      .map(decodeEventRow)
    for (const predecessor of predecessors) {
      const members = decodeRow(predecessor)
      if (predecessor.seq + members.length > toSeq) return predecessor
    }
    return undefined
  }

  private logicalLastEvent(id: SessionId, tailRows: readonly EventRow[]): StoredLogicalEvent | undefined {
    if (tailRows.length === 0) return undefined
    const { preserved, tornFrom } = scanRows(tailRows, (tailRows[0] as EventRow).seq)
    if (tornFrom !== undefined) throw new Error(`session ${id} has an invalid physical tail at seq ${tornFrom}`)
    return preserved.at(-1)
  }

  private insertStatement(): StatementSync {
    return this.db.prepare(sql('insert-event'))
  }

  private insertRecord(insert: StatementSync, sessionKey: number, record: BoundRecord): void {
    insert.run(
      sessionKey,
      record.seq,
      record.type,
      record.time,
      record.data,
      record.sourceEventSeqs,
      record.surfaceOp,
      record.ignorable,
    )
  }

  private writeRow(storage: SessionStorageMetadata): number {
    const { meta, inheritedEventCount } = storage
    const inserted = this.db.prepare(sql('upsert-session')).get(
      meta.id,
      meta.version,
      meta.createdAt,
      meta.cwd ?? null,
      meta.parentSession ?? null,
      // The durable seed cut stays a nullable column: unseeded rows keep NULL
      // and seeded rows store the inherited event count.
      meta.isSeeded ? Number(inheritedEventCount) : null,
      meta.origin ?? null,
      meta.delegationDepth ?? null,
      meta.agentPreset ?? null,
      randomUUID(),
    ) as { id: number }
    return inserted.id
  }
}

function sqliteRevision(storeIdentity: string, row: SessionRow): SessionPersistenceRevision {
  return SessionPersistenceRevision(
    `${storeIdentity}:incarnation:${row.incarnation}:revision:${row.revision}`,
  )
}

async function createDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

async function validateParentDirectory(path: string): Promise<void> {
  const parent = await lstat(path)
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error(`session database parent "${path}" must be a real directory`)
  }
  const uid = process.getuid?.()
  /* v8 ignore start -- Windows exposes neither process.getuid nor meaningful
   * uid/mode bits; POSIX tests cover owner and mode rejection. */
  if (uid !== undefined && (parent.uid !== uid || (parent.mode & 0o022) !== 0)) {
    throw new Error(`session database parent "${path}" must be owned by the current user and not group/world-writable`)
  }
  /* v8 ignore stop */
}

async function validateDatabaseFile(path: string): Promise<void> {
  const file = await lstat(path)
  if (file.isSymbolicLink() || !file.isFile()) {
    throw new Error(`session database "${path}" must be a regular file, not a symbolic link`)
  }
  const uid = process.getuid?.()
  /* v8 ignore start -- Windows exposes neither process.getuid nor meaningful
   * uid/mode bits; POSIX tests cover owner and mode rejection. */
  if (uid !== undefined && (file.uid !== uid || (file.mode & 0o077) !== 0)) {
    throw new Error(`session database "${path}" must be owned by the current user and accessible only by that user`)
  }
  /* v8 ignore stop */
}

async function validateDatabaseFileIfPresent(path: string): Promise<void> {
  try {
    await validateDatabaseFile(path)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

let nodeSqlite: Promise<typeof import('node:sqlite')> | undefined

/** Load Node SQLite once so concurrent stores share one warning-filter lifetime. */
function loadNodeSqlite(): Promise<typeof import('node:sqlite')> {
  nodeSqlite ??= importNodeSqlite()
  return nodeSqlite
}

/** Import Node 22's SQLite dependency without its process-wide experimental warning. */
async function importNodeSqlite(): Promise<typeof import('node:sqlite')> {
  const emitWarning = Reflect.get(process, 'emitWarning')
  /* v8 ignore start -- Node 22 alone emits this warning; primary coverage runs on Node 24. */
  const filteredEmitWarning = (warning: string | Error, ...args: unknown[]): void => {
    const message = warning instanceof Error ? warning.message : warning
    const first = args[0]
    const type = warning instanceof Error
      ? warning.name
      : typeof first === 'string'
        ? first
        : typeof first === 'object' && first !== null && 'type' in first
          ? first.type
          : undefined
    if (message === 'SQLite is an experimental feature and might change at any time'
      && type === 'ExperimentalWarning') return
    Reflect.apply(emitWarning, process, [warning, ...args])
  }
  Reflect.set(process, 'emitWarning', filteredEmitWarning)
  try {
    return await import('node:sqlite')
  } finally {
    Reflect.set(process, 'emitWarning', emitWarning)
  }
  /* v8 ignore stop */
}
