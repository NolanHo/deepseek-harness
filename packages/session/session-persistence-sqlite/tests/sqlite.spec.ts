import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { MessageId, type MessageSource } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionLogOffset,
  SessionSeq,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import SessionPersistenceSqlite, {
  DEFAULT_BUSY_TIMEOUT_MS,
  DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
  SCHEMA_VERSION,
} from '@deepseek-ai/dsh-session-persistence-sqlite'
import {
  SessionHandleClosedError,
  SessionReadOnlyError,
  type SessionStorageMetadata,
} from '@deepseek-ai/dsh-session-persistence'
import {
  meta,
  oneTurnLog,
  runPersistenceContract,
  type ContractBackend,
} from '../../session-persistence/tests/contract.ts'
import type { StoredChunkEvent, StoredLogicalEvent } from '../src/codec.ts'
import {
  currentHeaderOf,
  decodeEventRow,
  decodeSessionRow,
  decodeStoreIdentity,
  openDatabase,
  storedPhysicalHeaderOf,
  validateSchemaForMutation,
  SESSION_PERSISTENCE_SQLITE_APPLICATION_ID,
  type SessionRow,
} from '../src/schema.ts'
import { SqliteStore } from '../src/store.ts'
import { sql } from '../src/sql.ts'
import { testSql } from './test-sql.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function freshDbPath(prefix = 'dsh-sqlite-'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(directory)
  return join(directory, 'sessions.db')
}

async function backendFailure(path: string): Promise<unknown> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  try {
    await ctx.plugin(SessionPersistenceSqlite, { path })
    await ctx.sessionPersistence.list()
    return undefined
  } catch (error: unknown) {
    return error
  } finally {
    await ctx.fiber.dispose()
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Mount one SQLite provider over `path`, as a separate process would see it. */
async function mountSqlite(path: string): Promise<{
  persistence: Context['sessionPersistence']
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(SessionPersistenceSqlite, { path })
  return { persistence: ctx.sessionPersistence, dispose: async () => { await fiber.dispose() } }
}

/** Wrap a contract header (unseeded, cut 0) for direct backend-hook calls. */
function storage(header: SessionHeader): SessionStorageMetadata {
  return { meta: header, inheritedEventCount: SessionLogOffset(0) }
}

function databaseWithJournalFailure(
  nextFailure: () => Error | undefined,
): typeof DatabaseSync {
  return class JournalFailureDatabase extends DatabaseSync {
    override prepare(source: string) {
      if (source !== sql('journal-mode-wal')) return super.prepare(source)
      const statement = super.prepare(sql('journal-mode-wal'))
      const get = statement.get.bind(statement)
      Object.defineProperty(statement, 'get', {
        value: () => {
          const failure = nextFailure()
          if (failure !== undefined) throw failure
          return get()
        },
      })
      return statement
    }
  }
}

/** One retired top-level delta event; only legacy databases store these. */
function chunk(seq: number, text = `token-${seq}`): StoredChunkEvent {
  return {
    type: 'assistant/chunk',
    seq: SessionSeq(seq),
    time: 1_000 + seq,
    data: {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text },
    },
  }
}

/** One closed legacy turn whose delta run the schema-20 codec packs into one row. */
function chunkLog(count: number): StoredLogicalEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: SessionSeq(1), time: 2, data: { turn: 1, step: 1 } },
    ...Array.from({ length: count }, (_, index) => chunk(index + 2)),
    { type: 'step/end', seq: SessionSeq(count + 2), time: count + 3, data: { turn: 1, step: 1 } },
    {
      type: 'turn/end',
      seq: SessionSeq(count + 3),
      time: count + 4,
      data: { turn: 1, reason: { kind: 'completed' } },
    },
  ]
}

function turnStart(seq: number, turn = 1): SessionEvent {
  return { type: 'turn/start', seq: SessionSeq(seq), time: seq + 1, data: { turn } }
}

function turnEnd(seq: number, turn = 1): SessionEvent {
  return {
    type: 'turn/end',
    seq: SessionSeq(seq),
    time: seq + 1,
    data: { turn, reason: { kind: 'completed' } },
  }
}

/** `count` interleaved turn boundaries: every event is one scalar physical row. */
function trafficLog(count: number): SessionEvent[] {
  return Array.from({ length: count / 2 }, (_, index) => [
    turnStart(index * 2, index + 1),
    turnEnd(index * 2 + 1, index + 1),
  ]).flat()
}

const LEGACY_ID = SessionId('v0-chunks')
const DESCRIPTOR_ID = SessionId('v0-descriptor')

/** Replacement source a compaction backend attaches to its checkpoint message. */
type CheckpointSource = Extract<MessageSource, { readonly kind: 'compact-checkpoint' }>

/** Seed the schema-19 fixture: one v0 session whose packed text run predates v3. */
async function writeLegacyV0Fixture(): Promise<string> {
  const path = await freshDbPath('dsh-sqlite-legacy-v0-')
  const seed = new DatabaseSync(path)
  seed.exec(testSql('create-schema-19-db'))
  seed.exec(testSql('insert-schema-19-session'))
  seed.exec(testSql('insert-schema-19-events'))
  seed.close()
  await chmod(path, 0o600)
  return path
}

/**
 * Seed the schema-19 fixture with one v0 session whose child descriptor carries
 * the version the deployed build wrote. The descriptor names the continuable
 * composition inputs of that version, which the v0-to-v1 edge admits instead of
 * refusing the Session its write access.
 */
async function writeLegacyV0DescriptorFixture(): Promise<string> {
  const path = await freshDbPath('dsh-sqlite-legacy-descriptor-')
  const seed = new DatabaseSync(path)
  seed.exec(testSql('create-schema-19-db'))
  seed.exec(testSql('insert-schema-19-descriptor-session'))
  seed.exec(testSql('insert-schema-19-descriptor-events'))
  seed.close()
  await chmod(path, 0o600)
  return path
}

/**
 * The exact current-format log the released v0-to-v4 chain restores from
 * {@link writeLegacyV0Fixture}: sequence numbers renumbered, a system message
 * synthesized for the open step, and the packed run folded into one attempt.
 */
function legacyMigratedLog(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: SessionSeq(1), time: 2, data: { turn: 1, step: 1 } },
    {
      type: 'system/message',
      seq: SessionSeq(2),
      time: 2,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: MessageId('v2-to-v3-system-a4b68aee9afae52ac153aee39e90ce2172e655a75e62be2b765d4f382095eb50'),
          role: 'system',
          source: { kind: 'system-prompt' },
          content: [],
        },
      },
    },
    {
      type: 'assistant/attempt',
      seq: SessionSeq(3),
      time: 5,
      data: {
        turn: 1,
        step: 1,
        stream: [{ type: 'text-chunks', time0: 3, index: 0, dt: [1, 1], texts: ['a', 'b', 'c'] }],
      },
    },
    { type: 'step/end', seq: SessionSeq(4), time: 6, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: SessionSeq(5), time: 7, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

interface PhysicalRow {
  readonly rowid: number
  readonly seq: number
  readonly type: string
  readonly time: number
  readonly data: string | Uint8Array
  readonly source_event_seqs: Uint8Array | null
  readonly surface_op: string | null
  readonly ignorable: number | null
}

async function measureWriteTraffic(
  path: string,
  events: readonly SessionEvent[],
): Promise<{
  readonly walBytes: number
  readonly idleWalBytes: number
  readonly rows: number
  readonly largest: number
  readonly inserted: number
  readonly changed: number
  readonly removed: number
}> {
  const sameValue = (left: string | Uint8Array | null, right: string | Uint8Array | null): boolean => (
    typeof left === 'string' || left === null
      ? left === right
      : right instanceof Uint8Array && Buffer.from(left).equals(Buffer.from(right))
  )
  const sameRow = (left: PhysicalRow, right: PhysicalRow): boolean => (
    left.rowid === right.rowid
      && left.seq === right.seq
      && left.type === right.type
      && left.time === right.time
      && sameValue(left.data, right.data)
      && sameValue(left.source_event_seqs, right.source_event_seqs)
      && left.surface_op === right.surface_op
      && left.ignorable === right.ignorable
  )
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionPersistenceSqlite, { path, writeBatchMaxDelayMs: 200 })
  try {
    const header = meta('traffic')
    const handle = await ctx.sessionPersistence.create(header)
    let previous = new Map<number, PhysicalRow>()
    let inserted = 0
    let changed = 0
    let removed = 0
    const probe = new DatabaseSync(path, { readOnly: true })
    try {
      const selectRows = probe.prepare(testSql('select-event-rows'))
      for (let offset = 0; offset < events.length; offset += 40) {
        await handle.append(events.slice(offset, offset + 40))
        const current = new Map((selectRows.all(header.id) as unknown as PhysicalRow[])
          .map(row => [row.seq, row]))
        for (const [seq, row] of current) {
          const old = previous.get(seq)
          if (old === undefined) inserted += 1
          else if (!sameRow(old, row)) changed += 1
        }
        for (const seq of previous.keys()) if (!current.has(seq)) removed += 1
        previous = current
      }
    } finally {
      probe.close()
    }
    const db = new DatabaseSync(path, { readOnly: true })
    const measured = db.prepare(testSql('measure-write-traffic')).get() as { rows: number; largest: number }
    db.close()
    const walBytes = (await stat(`${path}-wal`)).size
    await new Promise(resolve => setTimeout(resolve, 250))
    return {
      walBytes,
      idleWalBytes: (await stat(`${path}-wal`)).size,
      rows: measured.rows,
      largest: measured.largest,
      inserted,
      changed,
      removed,
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

runPersistenceContract('sqlite', async (): Promise<ContractBackend> => {
  const path = await freshDbPath('dsh-sqlite-contract-')
  const primary = await mountSqlite(path)
  return {
    ...primary,
    reopen: () => mountSqlite(path),
    corruptTail: async (id) => {
      const db = new DatabaseSync(path)
      const last = db.prepare(testSql('select-last-event'))
        .get(id) as { seq: number; type: string; data: string }
      const logicalLength = last.type === 'text-chunks'
        ? (JSON.parse(last.data) as { texts: string[] }).texts.length
        : 1
      const next = last.seq + logicalLength
      db.prepare(testSql('insert-corrupt-event'))
        .run(id, next, 'assistant/chunk', 99, '{not valid json', null)
      db.close()
    },
  }
})

describe('SessionPersistenceSqlite physical packing', () => {
  it('loads from cordis.yml and stores one row per V3 event through the assembled service', async () => {
    const path = await freshDbPath('dsh-sqlite-loader-')
    const configPath = join(path, '..', 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-persistence-sqlite'",
      '  config:',
      `    path: ${JSON.stringify(path)}`,
      '',
    ].join('\n'))

    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(join(path, '..')).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = {
      version: 'sqlite',
      async import(specifier: string) {
        if (specifier === '@deepseek-ai/dsh-session') return SessionStore
        if (specifier === '@deepseek-ai/dsh-session-persistence-sqlite') {
          return SessionPersistenceSqlite
        }
        throw new Error(`unexpected Loader import: ${specifier}`)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await ctx.loader.await()

    const header = meta('loader')
    const events = oneTurnLog()
    const handle = await ctx.sessionPersistence.create(header)
    await handle.append(events)
    expect((await handle.read()).events).toEqual(events)
    await handle.close()
    await ctx.fiber.dispose()

    const db = new DatabaseSync(path)
    expect(db.prepare(testSql('count-events')).get()).toEqual({ count: events.length })
    db.close()
  })

  it('packs each raw append once without rewriting earlier rows', async () => {
    const path = await freshDbPath()
    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = meta('packed')
    const events = chunkLog(100)
    await store.appendBatch(storage(header), events.slice(0, 3), false)
    await store.appendBatch(storage(header), events.slice(3, 4), true)
    const before = new DatabaseSync(path, { readOnly: true })
    const originalRows = before.prepare(testSql('select-event-rowids')).all()
    before.close()
    await store.appendBatch(storage(header), events.slice(4), true)
    await store.close()

    const db = new DatabaseSync(path)
    expect(db.prepare(testSql('select-user-version')).get()).toEqual({ user_version: SCHEMA_VERSION })
    expect(db.prepare(testSql('select-page-size')).get()).toEqual({ page_size: 65_536 })
    // Two turn boundaries and two scalar deltas from the first appends, one packed
    // row for the 98-delta tail, and the closing step and turn.
    expect(db.prepare(testSql('count-events')).get()).toEqual({ count: 7 })
    expect(db.prepare(testSql('count-packed-events')).get()).toEqual({ count: 1 })
    expect(db.prepare(testSql('count-physical-types')).all())
      .toEqual([{ type: 'text-chunks', count: 1 }])
    expect(db.prepare(testSql('select-event-rowids')).all().slice(0, originalRows.length))
      .toEqual(originalRows)
    db.close()
  })

  it('serves every restored suffix of a legacy packed log', async () => {
    const path = await writeLegacyV0Fixture()
    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const expected = legacyMigratedLog()

    for (const fromSeq of [0, 1, 2, 3, 4, 5, 6, 25]) {
      const suffix = await store.loadStoredFrom(LEGACY_ID, SessionLogOffset(fromSeq))
      expect(suffix?.events, `suffix from ${fromSeq}`)
        .toEqual(expected.filter(event => event.seq >= fromSeq))
    }
    expect((await store.loadStoredLog(LEGACY_ID))?.events).toEqual(expected)
    await store.close()

    // The service seek surface restores a historical session once and slices it.
    const mounted = await mountSqlite(path)
    try {
      for (const fromSeq of [0, 2, 5, 6]) {
        const suffix = await (mounted.persistence as SessionPersistenceSqlite).readFrom(LEGACY_ID, fromSeq)
        expect(suffix.events, `service suffix from ${fromSeq}`)
          .toEqual(expected.filter(event => event.seq >= fromSeq))
      }
    } finally {
      await mounted.dispose()
    }
  })

  it.runIf(process.platform !== 'win32')('bounds paced-stream WAL extent without rewriting committed rows', async () => {
    const events = trafficLog(1_000)
    const measured = await measureWriteTraffic(await freshDbPath('dsh-sqlite-traffic-'), events)

    expect(measured).toMatchObject({ rows: events.length, inserted: events.length, changed: 0, removed: 0 })
    expect(measured.inserted).toBe(measured.rows)
    // Every physical row holds one small scalar event: nothing accumulates.
    expect(measured.largest).toBeLessThan(1_000)
    expect(measured.idleWalBytes).toBe(measured.walBytes)
  })

  it('drops a torn legacy tail and refuses corruption inside the committed span', async () => {
    const expected = legacyMigratedLog()

    // Repair writes target the migrated schema, so the first read opens and
    // upgrades the fixture database before any raw corruption is injected.
    const path = await writeLegacyV0Fixture()
    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    expect((await store.loadStoredLog(LEGACY_ID))?.events).toEqual(expected)
    const torn = new DatabaseSync(path)
    torn.prepare(testSql('insert-corrupt-event'))
      .run(LEGACY_ID, 7, 'assistant/chunk', 8, '{not json', null)
    torn.close()
    expect((await store.loadStoredLog(LEGACY_ID))?.tornFrom).toBe(7)
    expect((await store.loadStoredFrom(LEGACY_ID, SessionLogOffset(2)))?.events)
      .toEqual(expected.filter(event => event.seq >= 2))
    await store.close()

    // A malformed row overlapping the packed span sits before the committed
    // turn end, so the log that hides the packed predecessor is refused whole.
    const overlapping = await writeLegacyV0Fixture()
    const strict = new SqliteStore({
      path: overlapping,
      journalMode: 'wal',
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    })
    expect((await strict.loadStoredLog(LEGACY_ID))?.events).toEqual(expected)
    const shadow = new DatabaseSync(overlapping)
    shadow.prepare(testSql('insert-corrupt-event'))
      .run(LEGACY_ID, 3, 'assistant/chunk', 4, '{not json', null)
    shadow.close()
    await expect(strict.loadStoredLog(LEGACY_ID)).rejects.toThrow(/invalid committed physical row at seq 3/)
    await expect(strict.loadStoredFrom(LEGACY_ID, SessionLogOffset(2)))
      .rejects.toThrow(/invalid committed physical row at seq 3/)
    await strict.close()

    // A packed row that cannot be decoded is committed corruption as well.
    const malformed = await writeLegacyV0Fixture()
    const corrupted = new SqliteStore({
      path: malformed,
      journalMode: 'wal',
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    })
    expect((await corrupted.loadStoredLog(LEGACY_ID))?.events).toEqual(expected)
    const broken = new DatabaseSync(malformed)
    broken.prepare(testSql('corrupt-schema-19-packed-event')).run(LEGACY_ID)
    broken.close()
    await expect(corrupted.loadStoredLog(LEGACY_ID)).rejects.toThrow(/invalid committed physical row at seq 2/)
    await corrupted.close()
  })

  it('locates the Nth append-origin user message by index and bounds it by beforeSeq', async () => {
    const path = await freshDbPath('dsh-sqlite-message-cut-')
    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = meta('message-cut')
    const user = (seq: number): SessionEvent => ({
      type: 'user/message',
      seq: SessionSeq(seq),
      time: seq,
      surfaceOp: 'append',
      data: { role: 'user', id: `u${seq}` as never, content: [{ type: 'text', text: `q${seq}` }], source: { kind: 'user' } },
    })
    const replace = (seq: number): SessionEvent => ({
      type: 'user/message',
      seq: SessionSeq(seq),
      time: seq,
      surfaceOp: { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(4) },
      sourceEventSeqs: [0, 1, 2, 3, 4].map(SessionSeq),
      data: { role: 'user', id: `r${seq}` as never, content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'compact-checkpoint', compactionId: 'compact' as CheckpointSource['compactionId'] } },
    })
    await store.appendBatch(storage(header), [
      chunk(0),
      user(1),
      chunk(2),
      replace(3),
      user(4),
      chunk(5),
      user(6),
      user(7),
    ], false)

    // Append-origin only: the replace copy never counts.
    expect(await store.userMessageCut(header.id, 1)).toBe(7)
    expect(await store.userMessageCut(header.id, 3)).toBe(4)
    expect(await store.userMessageCut(header.id, 99)).toBe(1)
    // loadOlder bound: strictly below the given seq.
    expect(await store.userMessageCut(header.id, 2, 7)).toBe(4)
    expect(await store.userMessageCut(header.id, 1, 4)).toBe(1)
    expect(await store.userMessageCut(header.id, 1, 1)).toBeUndefined()
    await store.close()
  })

  it('waits for a competing process within the configured busy timeout', async () => {
    const path = await freshDbPath('dsh-sqlite-busy-')
    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: 1_000 })
    const header = meta('busy')
    await store.appendBatch(storage(header), [turnStart(0)], false)

    const holder = spawn(process.execPath, ['--input-type=module', '-e', String.raw`
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN IMMEDIATE');
      process.stdout.write('locked\n');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 100);
    `, path], { stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = new Promise<number | null>((resolve, reject) => {
      holder.once('error', reject)
      holder.once('exit', resolve)
    })
    try {
      await once(holder.stdout, 'data')
      await expect(store.appendBatch(storage(header), [turnEnd(1)], true)).resolves.toBeUndefined()
      const code = await exited
      expect(code).toBe(0)
      expect((await store.loadStoredLog(header.id))?.events).toEqual([turnStart(0), turnEnd(1)])
    } finally {
      if (holder.exitCode === null) holder.kill()
      await store.close()
    }
  })

  it('rejects an older SQLite physical schema', async () => {
    const path = await freshDbPath('dsh-sqlite-old-schema-')
    const seed = await openDatabase(DatabaseSync, path, 'wal', DEFAULT_BUSY_TIMEOUT_MS)
    seed.exec(testSql('set-user-version-17'))
    seed.close()
    await chmod(path, 0o600)
    await expect(openDatabase(DatabaseSync, path, 'wal', DEFAULT_BUSY_TIMEOUT_MS))
      .rejects.toThrow(/schema version 17.*incompatible/)
  })

  it('reports a historical row unaddressable and its physical cut selecting nothing', async () => {
    // The deployed store holds mostly pre-format-change rows. Their log restores
    // into a re-based seq space while the events table (and therefore every cut
    // the index answers) stays in the stored physical space, so a window plan
    // reading `userMessageCut` first pays a full log read and gets nothing back.
    const path = await writeLegacyV0Fixture()
    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })

    expect(await store.seekable(LEGACY_ID)).toBe(false)

    const physical = new DatabaseSync(path)
    const physicalSeqs = (physical.prepare(testSql('select-event-rows')).all(LEGACY_ID) as unknown as PhysicalRow[])
      .map(row => row.seq)
    physical.close()
    const restored = await store.loadStoredLog(LEGACY_ID)
    // The two spaces really differ: the stored rows run past the restored end.
    expect(physicalSeqs).toEqual([0, 1, 2, 5, 6])
    expect(restored?.events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5])
    expect(Math.max(...physicalSeqs)).toBeGreaterThan(Math.max(...restored!.events.map(event => event.seq)))
    // A window read at the last physical seq is the production shape: 0 events.
    expect((await store.loadStoredFrom(LEGACY_ID, SessionLogOffset(6)))?.events).toEqual([])

    // Publishing the restored log rewrites the row to the current format, and
    // only then does the store answer that a window is addressable.
    const storageMetadata = { meta: restored!.meta, inheritedEventCount: restored!.inheritedEventCount }
    await store.publishStoredLog(storageMetadata, restored!.events)
    expect(await store.seekable(LEGACY_ID)).toBe(true)
    await store.close()

    const mounted = await mountSqlite(path)
    try {
      await expect((mounted.persistence as SessionPersistenceSqlite).seekable(LEGACY_ID)).resolves.toBe(true)
      await expect((mounted.persistence as SessionPersistenceSqlite).seekable(SessionId('absent')))
        .resolves.toBe(false)
    } finally {
      await mounted.dispose()
    }
  })

  it('migrates an established schema-19 database in place', async () => {
    const path = await writeLegacyV0Fixture()

    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const expected = legacyMigratedLog()
    const stored = await store.loadStoredLog(LEGACY_ID)
    expect(stored?.meta).toEqual({
      version: SESSION_FORMAT_VERSION,
      id: LEGACY_ID,
      createdAt: 1,
      isSeeded: false,
      delegationDepth: 0,
    })
    expect(stored?.inheritedEventCount).toBe(0)
    expect(stored?.storedVersion).toBe(0)
    expect(stored?.events).toEqual(expected)

    // Opening the database migrated the schema in place: the packed row kept
    // its sentinel in the new `ignorable` column before any publish ran.
    const upgraded = new DatabaseSync(path)
    expect(upgraded.prepare(testSql('select-user-version')).get()).toEqual({ user_version: SCHEMA_VERSION })
    expect((upgraded.prepare(testSql('select-event-rows')).all(LEGACY_ID) as unknown as PhysicalRow[])
      .map(row => ({ seq: row.seq, ignorable: row.ignorable }))).toEqual([
      { seq: 0, ignorable: null },
      { seq: 1, ignorable: null },
      { seq: 2, ignorable: 0 },
      { seq: 5, ignorable: null },
      { seq: 6, ignorable: null },
    ])
    upgraded.close()

    const storageMetadata = { meta: stored!.meta, inheritedEventCount: stored!.inheritedEventCount }
    await store.publishStoredLog(storageMetadata, stored!.events)
    await store.appendBatch(storageMetadata, [turnStart(6, 2)], true)
    const published = await store.loadStoredLog(LEGACY_ID)
    expect(published?.storedVersion).toBe(SESSION_FORMAT_VERSION)
    expect(published?.events).toEqual([...expected, turnStart(6, 2)])
    await store.close()

    const rewritten = new DatabaseSync(path)
    expect(rewritten.prepare(testSql('select-user-version')).get()).toEqual({ user_version: SCHEMA_VERSION })
    expect(rewritten.prepare(testSql('select-session-version')).get(LEGACY_ID))
      .toEqual({ version: SESSION_FORMAT_VERSION })
    expect((rewritten.prepare(testSql('select-event-rows')).all(LEGACY_ID) as unknown as PhysicalRow[])
      .map(row => row.ignorable)).toEqual([null, null, null, null, null, null, null])
    expect(rewritten.prepare(testSql('count-packed-events')).get()).toEqual({ count: 0 })
    rewritten.close()
  })

  it('keeps the page size of an established schema 20 database', async () => {
    const path = await freshDbPath('dsh-sqlite-page-size-')
    const seed = await openDatabase(DatabaseSync, path, 'delete', DEFAULT_BUSY_TIMEOUT_MS)
    seed.close()

    const resize = new DatabaseSync(path)
    resize.exec(testSql('set-page-size-4096'))
    resize.exec(testSql('vacuum'))
    expect(resize.prepare(testSql('select-page-size')).get()).toEqual({ page_size: 4_096 })
    resize.close()

    const reopened = await openDatabase(DatabaseSync, path, 'wal', DEFAULT_BUSY_TIMEOUT_MS)
    expect(reopened.prepare(testSql('select-page-size')).get()).toEqual({ page_size: 4_096 })
    reopened.close()
  })

  it('rejects a stale physical append without replacing the winning tail', async () => {
    const path = await freshDbPath('dsh-sqlite-stale-')
    const first = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const second = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = meta(SessionId('stale'))
    await first.appendBatch(storage(header), [turnStart(0)], false)
    await second.appendBatch(storage(header), [turnEnd(1)], true)
    await expect(first.appendBatch(storage(header), [turnEnd(1)], true)).rejects.toThrow(/stored next seq is 2/)
    expect((await first.loadStoredLog(header.id))?.events).toEqual([turnStart(0), turnEnd(1)])
    await first.close()
    await second.close()
  })

  it('rolls back lazy integer-key materialization after a rejected append', async () => {
    const store = new SqliteStore({
      path: await freshDbPath('dsh-sqlite-key-rollback-'),
      journalMode: 'wal',
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    })
    const header = meta(SessionId('key-rollback'))

    await expect(store.appendBatch(storage(header), [turnEnd(1)], false)).rejects.toThrow(/stored next seq is 0/)
    await expect(store.appendBatch(storage(header), [turnStart(0)], true)).rejects.toThrow(/metadata row is missing/)
    await expect(store.appendBatch(storage(header), [turnStart(0)], false)).resolves.toBeUndefined()
    expect((await store.loadStoredLog(header.id))?.events).toEqual([turnStart(0)])
    await store.close()
  })

  it('rejects a stale repair without deleting a newer winning tail', async () => {
    const path = await freshDbPath('dsh-sqlite-stale-repair-')
    const stale = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const winner = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = meta(SessionId('stale-repair'))
    await stale.appendBatch(storage(header), [turnStart(0)], false)
    const db = new DatabaseSync(path)
    db.prepare(testSql('insert-corrupt-event')).run(header.id, 1, 'assistant/chunk', 2, '{not json', null)
    db.close()
    expect((await stale.loadStoredLog(header.id))?.tornFrom).toBe(1)
    await winner.commitRepair(storage(header), 1, [])
    await winner.appendBatch(storage(header), [turnEnd(1)], true)
    await expect(stale.commitRepair(storage(header), 1, [])).rejects.toThrow(/repair is stale/)
    expect((await stale.loadStoredLog(header.id))?.events).toEqual([turnStart(0), turnEnd(1)])
    await stale.close()
    await winner.close()
  })
})

describe('SessionPersistenceSqlite live write path', () => {
  it('routes published session events into the active write handle after the batching window', async () => {
    const path = await freshDbPath('dsh-sqlite-routed-')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceSqlite, { path })
    const session = ctx.sessions.create(SessionId('routed'))
    const handle = await ctx.sessionPersistence.create(session.header)
    vi.useFakeTimers()
    try {
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      // One tick short of the window: the routed batch is still buffered only.
      await vi.advanceTimersByTimeAsync(DEFAULT_WRITE_BATCH_MAX_DELAY_MS - 1)
      expect((await handle.read()).events).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
    } finally {
      vi.useRealTimers()
    }
    await vi.waitFor(async () => {
      expect((await handle.read()).events.map(event => event.seq)).toEqual([0, 1])
    })
    await handle.close()
    await ctx.fiber.dispose()
  })

  it('drains the routed batch immediately on session/flush and on the service barrier', async () => {
    const path = await freshDbPath('dsh-sqlite-live-flush-')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceSqlite, { path })
    const flushed = ctx.sessions.create(SessionId('live-flush'))
    const flushedHandle = await ctx.sessionPersistence.create(flushed.header)
    flushed.append('turn/start', { turn: 1 })
    await ctx.sessions.flush(flushed)
    expect((await flushedHandle.read()).events.map(event => event.seq)).toEqual([0])

    const swept = ctx.sessions.create(SessionId('live-sweep'))
    const sweptHandle = await ctx.sessionPersistence.create(swept.header)
    swept.append('turn/start', { turn: 1 })
    await ctx.sessionPersistence.flush()
    expect((await sweptHandle.read()).events.map(event => event.seq)).toEqual([0])
    await flushedHandle.close()
    await sweptHandle.close()
    await ctx.fiber.dispose()
  })

  it('persists nothing for a session without an active write handle', async () => {
    const path = await freshDbPath('dsh-sqlite-unrouted-')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceSqlite, { path })
    const session = ctx.sessions.create(SessionId('unrouted'))
    session.append('turn/start', { turn: 1 })
    await ctx.sessions.flush(session)
    await expect(ctx.sessionPersistence.stat(session.id)).resolves.toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('drains buffered events through backend teardown', async () => {
    const path = await freshDbPath('dsh-sqlite-teardown-drain-')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceSqlite, { path })
    const session = ctx.sessions.create(SessionId('teardown-drains'))
    const handle = await ctx.sessionPersistence.create(session.header)
    session.append('turn/start', { turn: 1 })

    // Root disposal closes the still-open handle, which drains before closing.
    await ctx.fiber.dispose()
    await expect(handle.append([])).rejects.toThrow(/closed handle/)

    const reopened = await mountSqlite(path)
    try {
      const reader = await reopened.persistence.open(SessionId('teardown-drains'), 'read')
      expect((await reader.read()).events.map(event => event.seq)).toEqual([0])
      await reader.close()
    } finally {
      await reopened.dispose()
    }
  })

  it('routes events to a second write handle opened after close', async () => {
    const path = await freshDbPath('dsh-sqlite-rebind-')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceSqlite, { path })
    const session = ctx.sessions.create(SessionId('rebind'))
    const first = await ctx.sessionPersistence.create(session.header)
    session.append('turn/start', { turn: 1 })
    await ctx.sessions.flush(session)
    await first.close()

    const second = await ctx.sessionPersistence.open(session.id, 'write')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessions.flush(session)
    expect((await second.read()).events.map(event => event.seq)).toEqual([0, 1])
    await second.close()
    await ctx.fiber.dispose()
  })
})

describe('SessionPersistenceSqlite schema ownership', () => {
  it('accepts every configured journal mode and SQLite memory mode result', async () => {
    const resources = {
      wal: 'journal-mode-wal',
      delete: 'journal-mode-delete',
      truncate: 'journal-mode-truncate',
      persist: 'journal-mode-persist',
    } as const
    for (const mode of ['wal', 'delete', 'truncate', 'persist'] as const) {
      ;(await openDatabase(DatabaseSync, ':memory:', mode, DEFAULT_BUSY_TIMEOUT_MS)).close()
      const path = await freshDbPath(`dsh-sqlite-journal-${mode}-`)
      const db = await openDatabase(DatabaseSync, path, mode, DEFAULT_BUSY_TIMEOUT_MS)
      expect(db.prepare(sql(resources[mode])).get()).toEqual({ journal_mode: mode })
      expect(db.prepare(sql('select-trusted-schema')).get()).toEqual({ trusted_schema: 0 })
      expect(db.prepare(sql('select-mmap-size')).get()).toEqual({ mmap_size: 0 })
      expect(db.prepare(sql('select-synchronous')).get()).toEqual({ synchronous: 2 })
      db.close()
    }
  })

  it('retries a busy journal-mode transition within its retry budget', async () => {
    const path = await freshDbPath('dsh-sqlite-journal-busy-')
    let attempts = 0
    const BusyOnceDatabase = databaseWithJournalFailure(() => {
      attempts += 1
      return attempts === 1
        ? Object.assign(new Error('database is locked'), {
          code: 'ERR_SQLITE_ERROR',
          errcode: 5,
          errstr: 'database is locked',
        })
        : undefined
    })

    const db = await openDatabase(BusyOnceDatabase, path, 'wal', 100)
    expect(attempts).toBe(2)
    expect(db.prepare(sql('journal-mode-wal')).get()).toEqual({ journal_mode: 'wal' })
    expect(db.prepare(sql('select-trusted-schema')).get()).toEqual({ trusted_schema: 0 })
    expect(db.prepare(sql('select-mmap-size')).get()).toEqual({ mmap_size: 0 })
    expect(db.prepare(sql('select-synchronous')).get()).toEqual({ synchronous: 2 })
    db.close()
  })

  it('does not retry journal failures outside the available busy budget', async () => {
    for (const { errcode, timeout } of [
      { errcode: 5, timeout: 0 },
      { errcode: 6, timeout: 100 },
    ]) {
      let attempts = 0
      const FailingDatabase = databaseWithJournalFailure(() => {
        attempts += 1
        return Object.assign(new Error(`SQLite error ${errcode}`), { errcode })
      })
      await expect(openDatabase(
        FailingDatabase,
        await freshDbPath(`dsh-sqlite-journal-failure-${errcode}-`),
        'wal',
        timeout,
      )).rejects.toThrow(`SQLite error ${errcode}`)
      expect(attempts).toBe(1)
    }
  })

  it('starts no journal retry after its open-relative cutoff', async () => {
    let attempts = 0
    const BusyDatabase = databaseWithJournalFailure(() => {
      attempts += 1
      return Object.assign(new Error('database is locked'), { errcode: 5 })
    })
    const clock = vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(50)
      .mockReturnValueOnce(100)
    try {
      await expect(openDatabase(
        BusyDatabase,
        await freshDbPath('dsh-sqlite-journal-cutoff-'),
        'wal',
        100,
      )).rejects.toThrow('database is locked')
    } finally {
      clock.mockRestore()
    }
    expect(attempts).toBe(1)
  })

  it('paces repeated busy journal-mode attempts', async () => {
    const attemptedAt: number[] = []
    const BusyTwiceDatabase = databaseWithJournalFailure(() => {
      attemptedAt.push(performance.now())
      return attemptedAt.length <= 2
        ? Object.assign(new Error('database is locked'), { errcode: 5 })
        : undefined
    })
    const db = await openDatabase(
      BusyTwiceDatabase,
      await freshDbPath('dsh-sqlite-journal-paced-'),
      'wal',
      DEFAULT_BUSY_TIMEOUT_MS,
    )
    db.close()

    expect(attemptedAt).toHaveLength(3)
    for (let index = 1; index < attemptedAt.length; index += 1) {
      const previous = attemptedAt[index - 1]
      const current = attemptedAt[index]
      if (previous === undefined || current === undefined) throw new Error('missing journal attempt timestamp')
      expect(current - previous).toBeGreaterThanOrEqual(5)
    }
  })

  it('rejects unversioned, incompatible, and foreign-application databases', async () => {
    const unversionedPath = await freshDbPath('dsh-sqlite-unversioned-')
    const unversioned = new DatabaseSync(unversionedPath)
    unversioned.exec(testSql('create-unrelated-table'))
    unversioned.close()
    await expect(openDatabase(DatabaseSync, unversionedPath, 'wal', DEFAULT_BUSY_TIMEOUT_MS)).rejects.toThrow(/unversioned schema/)

    const incompatiblePath = await freshDbPath('dsh-sqlite-incompatible-')
    const incompatible = new DatabaseSync(incompatiblePath)
    incompatible.exec(testSql('set-user-version-17'))
    incompatible.close()
    await expect(openDatabase(DatabaseSync, incompatiblePath, 'wal', DEFAULT_BUSY_TIMEOUT_MS)).rejects.toThrow(/incompatible with this build/)

    const foreignPath = await freshDbPath('dsh-sqlite-foreign-')
    const foreign = new DatabaseSync(foreignPath)
    foreign.exec(testSql('set-user-version-19'))
    foreign.exec(testSql('set-application-id-12345'))
    foreign.close()
    await expect(openDatabase(DatabaseSync, foreignPath, 'wal', DEFAULT_BUSY_TIMEOUT_MS)).rejects.toThrow(/has application id 12345/)
  })

  it('rejects changed columns and non-strict owned tables', async () => {
    const changedPath = await freshDbPath('dsh-sqlite-columns-')
    ;(await openDatabase(DatabaseSync, changedPath, 'wal', DEFAULT_BUSY_TIMEOUT_MS)).close()
    const changed = new DatabaseSync(changedPath)
    changed.exec(testSql('add-unexpected-column'))
    changed.close()
    await expect(openDatabase(DatabaseSync, changedPath, 'wal', DEFAULT_BUSY_TIMEOUT_MS)).rejects.toThrow(/required schema objects/)

    const nonStrictPath = await freshDbPath('dsh-sqlite-nonstrict-')
    ;(await openDatabase(DatabaseSync, nonStrictPath, 'wal', DEFAULT_BUSY_TIMEOUT_MS)).close()
    const nonStrict = new DatabaseSync(nonStrictPath)
    nonStrict.exec(testSql('replace-events-with-nonstrict-table'))
    nonStrict.close()
    await expect(openDatabase(DatabaseSync, nonStrictPath, 'wal', DEFAULT_BUSY_TIMEOUT_MS)).rejects.toThrow(/required schema objects/)

    const loosePath = await freshDbPath('dsh-sqlite-loose-')
    const loose = new DatabaseSync(loosePath)
    loose.exec(testSql('create-loose-schema'))
    loose.close()
    await expect(openDatabase(DatabaseSync, loosePath, 'wal', DEFAULT_BUSY_TIMEOUT_MS)).rejects.toThrow(/required schema objects/)
  })

  it('rejects schema ownership changes observed at mutation time', async () => {
    const changedVersion = await openDatabase(DatabaseSync, ':memory:', 'wal', DEFAULT_BUSY_TIMEOUT_MS)
    changedVersion.exec(testSql('set-user-version-17'))
    expect(() => { validateSchemaForMutation(DatabaseSync, changedVersion, ':memory:') })
      .toThrow(/schema changed before mutation/)
    changedVersion.close()

    const changedApplication = await openDatabase(DatabaseSync, ':memory:', 'wal', DEFAULT_BUSY_TIMEOUT_MS)
    changedApplication.exec(testSql('set-application-id-12345'))
    expect(() => { validateSchemaForMutation(DatabaseSync, changedApplication, ':memory:') })
      .toThrow(/application id changed before mutation/)
    changedApplication.close()
  })

  it('validates creation time and restores every optional header field', () => {
    const base: SessionRow = {
      id: 'stored-header',
      version: 0,
      created_at: 1,
      cwd: '/project',
      parent_session: 'parent',
      seed_length: 4,
      origin: 'subagent',
      incarnation: '00000000-0000-4000-8000-000000000000',
      revision: 1,
      delegation_depth: 2,
      agent_preset: 'minimal',
    }
    expect(storedPhysicalHeaderOf(decodeSessionRow(base))).toEqual({
      type: 'session',
      version: 0,
      id: 'stored-header',
      createdAt: 1,
      cwd: '/project',
      parentSession: 'parent',
      seedLength: 4,
      origin: 'subagent',
      delegationDepth: 2,
      agentPreset: 'minimal',
    })
    expect(() => decodeSessionRow({ ...base, created_at: -1 })).toThrow(/created_at/)
    expect(() => decodeSessionRow({ ...base, origin: 'external' })).toThrow(/origin/)
    expect(() => decodeSessionRow({ ...base, delegation_depth: -1 })).toThrow(/delegation_depth/)

    const current: SessionRow = { ...base, version: SESSION_FORMAT_VERSION }
    expect(currentHeaderOf(decodeSessionRow(current))).toEqual({
      version: SESSION_FORMAT_VERSION,
      id: SessionId('stored-header'),
      createdAt: 1,
      cwd: '/project',
      parentSession: SessionId('parent'),
      isSeeded: true,
      origin: 'subagent',
      delegationDepth: 2,
      agentPreset: 'minimal',
    })
    // Current-format rows carry the seed boolean; only v0/v1 rows carry the cut.
    expect(storedPhysicalHeaderOf(decodeSessionRow(current))).toEqual({
      type: 'session',
      version: SESSION_FORMAT_VERSION,
      id: 'stored-header',
      createdAt: 1,
      cwd: '/project',
      parentSession: 'parent',
      origin: 'subagent',
      delegationDepth: 2,
      agentPreset: 'minimal',
      isSeeded: true,
    })
    expect(() => currentHeaderOf(decodeSessionRow(base)))
      .toThrow(`is format v0, expected v${SESSION_FORMAT_VERSION}`)
  })

  it('rejects malformed SQLite row primitives generically', () => {
    const base: SessionRow = {
      id: 'stored-header',
      version: 0,
      created_at: 1,
      cwd: '/project',
      parent_session: null,
      seed_length: null,
      origin: null,
      incarnation: '00000000-0000-4000-8000-000000000000',
      revision: 1,
      delegation_depth: null,
      agent_preset: null,
    }
    for (const [value, message] of [
      [null, /object/],
      [{ ...base, id: 1 }, /id.*string/],
      [{ ...base, id: '' }, /id.*empty/],
      [{ ...base, version: '0' }, /version.*safe integer/],
      [{ ...base, cwd: 'relative' }, /cwd.*absolute/],
      [{ ...base, cwd: 1 }, /cwd.*string or null/],
      [{ ...base, incarnation: 'invalid' }, /incarnation.*UUID/],
      [{ ...base, seed_length: '1' }, /seed_length.*safe integer or null/],
      [{ ...base, agent_preset: 1 }, /agent_preset.*string or null/],
    ] as const) {
      expect(() => decodeSessionRow(value)).toThrow(message)
    }

    const eventRow = {
      seq: 0, type: 'turn/start', time: 1, data: '{}',
      source_event_seqs: null, surface_op: null, ignorable: null,
    }
    for (const [value, message] of [
      [null, /object/],
      [{ ...eventRow, seq: '0' }, /seq.*safe integer/],
      [{ ...eventRow, type: '' }, /type.*empty/],
      [{ ...eventRow, time: '1' }, /time.*safe integer/],
      [{ ...eventRow, data: 1 }, /data.*string or blob/],
      [{ ...eventRow, source_event_seqs: 1 }, /source_event_seqs.*blob or null/],
      [{ ...eventRow, ignorable: 2 }, /ignorable.*0, 1, or null/],
    ] as const) {
      expect(() => decodeEventRow(value)).toThrow(message)
    }
    expect(() => decodeStoreIdentity({ store_id: 'invalid' })).toThrow(/store_id.*UUID/)
  })

  it('rejects invalid durable metadata before exposing a session header', async () => {
    const path = await freshDbPath('dsh-sqlite-metadata-')
    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = meta('invalid-metadata')
    await store.appendBatch(storage(header), [turnStart(0)], false)
    const db = new DatabaseSync(path)
    db.prepare(testSql('update-invalid-session-metadata')).run(header.id)
    db.close()
    await expect(store.list()).rejects.toThrow(/seed_length|origin|delegation_depth/)
    await expect(store.loadStoredLog(header.id)).rejects.toThrow(/seed_length|origin|delegation_depth/)
    await store.close()
  })

  it('uses the shared persistence application identity', () => {
    expect(SESSION_PERSISTENCE_SQLITE_APPLICATION_ID).toBe(0x44534850)
  })
})

describe('SessionPersistenceSqlite edge behavior', () => {
  it('materializes an explicitly durable empty live session', async () => {
    const path = await freshDbPath('dsh-sqlite-empty-')
    const header = meta('empty', '/workspace')
    const mounted = await mountSqlite(path)
    try {
      const handle = await mounted.persistence.create(header)
      await handle.flush()
      await handle.close()

      expect((await mounted.persistence.list()).map(snapshot => snapshot.header.id)).toContain(header.id)
      const reader = await mounted.persistence.open(header.id, 'read')
      expect((await reader.read()).events).toEqual([])
      await reader.close()
    } finally {
      await mounted.dispose()
    }

    const reopened = await mountSqlite(path)
    try {
      expect((await reopened.persistence.list()).map(snapshot => snapshot.header.id)).toContain(header.id)
      expect((await reopened.persistence.stat(header.id))?.header).toMatchObject(header)
      const reader = await reopened.persistence.open(header.id, 'read')
      expect((await reader.read()).events).toEqual([])
      await reader.close()
    } finally {
      await reopened.dispose()
    }
  })

  it('keeps a fresh database unopened until the first persistence operation', async () => {
    const path = await freshDbPath('dsh-sqlite-lazy-')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceSqlite, { path })
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    const emitWarning = Reflect.get(process, 'emitWarning')
    expect(await ctx.sessionPersistence.list()).toEqual([])
    expect(Reflect.get(process, 'emitWarning')).toBe(emitWarning)
    expect(typeof (await stat(path)).size).toBe('number')
    await ctx.fiber.dispose()
  })

  it('disposes after path validation without opening the database', async () => {
    const path = await freshDbPath('dsh-sqlite-unused-')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceSqlite, { path })
    await ctx.fiber.dispose()
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })

    const untouchedPath = await freshDbPath('dsh-sqlite-never-validated-')
    const untouched = new SqliteStore({
      path: untouchedPath,
      journalMode: 'wal',
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    })
    await untouched.close()
    await expect(stat(untouchedPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('constructs the provider directly and serves the handle API with constructor defaults', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    let persistence!: SessionPersistenceSqlite
    await ctx.plugin(Object.assign((inner: Context) => {
      persistence = new SessionPersistenceSqlite(inner, { path: ':memory:' })
    }, { inject: ['sessions'] }))

    const header = meta('direct-provider')
    const events = oneTurnLog()
    const handle = await persistence.create(header)
    await handle.append(events)
    expect((await handle.read()).events).toEqual(events)
    expect((await persistence.stat(header.id))?.header).toMatchObject(header)
    await handle.close()
    await ctx.fiber.dispose()
  })

  it('keeps empty mutations inert and rolls back a repair without metadata', async () => {
    const store = new SqliteStore({
      path: ':memory:',
      journalMode: 'wal',
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    })
    const header = meta('empty-store')
    await store.appendBatch(storage(header), [], false)
    await store.commitRepair(storage(header), undefined, [])
    expect(await store.hasSession(header.id)).toBe(false)
    await expect(store.commitRepair(storage(header), 0, [])).rejects.toThrow(/metadata row is missing/)
    await store.close()
  })

  it('rejects omitted torn markers and stale closer positions', async () => {
    const path = await freshDbPath('dsh-sqlite-repair-validation-')
    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = meta('repair-validation')
    await store.appendBatch(storage(header), [turnStart(0)], false)
    const db = new DatabaseSync(path)
    db.prepare(testSql('insert-corrupt-event')).run(header.id, 1, 'assistant/chunk', 2, '{not json', 0)
    db.close()
    await expect(store.commitRepair(storage(header), undefined, [turnEnd(1)])).rejects.toThrow(/omitted current torn tail/)
    await store.commitRepair(storage(header), 1, [])
    await expect(store.commitRepair(storage(header), undefined, [turnEnd(2)])).rejects.toThrow(/closer starts at seq 2/)

    const cleared = new DatabaseSync(path)
    cleared.prepare(testSql('delete-session-events')).run(header.id)
    cleared.close()
    await store.commitRepair(storage(header), undefined, [turnStart(0)])
    expect((await store.loadStoredLog(header.id))?.events).toEqual([turnStart(0)])
    await store.close()
  })

  it('rejects malformed physical tail rows before appending', async () => {
    const path = await freshDbPath('dsh-sqlite-tail-')
    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = meta('invalid-tail')
    await store.appendBatch(storage(header), [turnStart(0)], false)
    const db = new DatabaseSync(path)
    db.prepare(testSql('insert-corrupt-event'))
      .run(header.id, 1, 'assistant/chunk', 2, '{not json', null)
    db.close()

    await expect(store.appendBatch(storage(header), [turnEnd(2)], true)).rejects.toThrow(/invalid physical tail/)
    await store.close()
  })

  it('publishes a historical session on write open', async () => {
    const path = await writeLegacyV0Fixture()
    const expected = legacyMigratedLog()
    const mounted = await mountSqlite(path)
    try {
      const writer = await mounted.persistence.open(LEGACY_ID, 'write')
      expect((await writer.read()).events).toEqual(expected)
      await writer.close()
    } finally {
      await mounted.dispose()
    }

    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    expect((await store.loadStoredLog(LEGACY_ID))?.storedVersion).toBe(SESSION_FORMAT_VERSION)
    await store.close()

    const published = new DatabaseSync(path)
    expect(published.prepare(testSql('select-session-version')).get(LEGACY_ID))
      .toEqual({ version: SESSION_FORMAT_VERSION })
    expect((published.prepare(testSql('select-event-rows')).all(LEGACY_ID) as unknown as PhysicalRow[])
      .every(row => row.ignorable === null)).toBe(true)
    expect(published.prepare(testSql('count-packed-events')).get()).toEqual({ count: 0 })
    published.close()

    // A write open that appends nothing still leaves the published log intact
    // for the next process to read.
    const reopened = await mountSqlite(path)
    try {
      const reader = await reopened.persistence.open(LEGACY_ID, 'read')
      expect((await reader.read()).events).toEqual(expected)
      await reader.close()
    } finally {
      await reopened.dispose()
    }
  })

  it('publishes a historical session whose child descriptor carries the installed version', async () => {
    const path = await writeLegacyV0DescriptorFixture()
    const mounted = await mountSqlite(path)
    try {
      const writer = await mounted.persistence.open(DESCRIPTOR_ID, 'write')
      const descriptor = (await writer.read()).events
        .find(event => event.type === 'subagent/descriptor')
      expect(descriptor?.data).toMatchObject({
        mode: 'continuable',
        provider: 'in-process',
        label: 'child',
        cwd: '/work/child',
        skillFilter: { allow: ['review'] },
      })
      await writer.close()
    } finally {
      await mounted.dispose()
    }

    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    expect((await store.loadStoredLog(DESCRIPTOR_ID))?.storedVersion).toBe(SESSION_FORMAT_VERSION)
    await store.close()
  })

  it('rejects missing and empty store identities', async () => {
    for (const mode of ['missing', 'empty'] as const) {
      const path = await freshDbPath(`dsh-sqlite-identity-${mode}-`)
      const db = await openDatabase(DatabaseSync, path, 'wal', DEFAULT_BUSY_TIMEOUT_MS)
      if (mode === 'missing') db.exec(testSql('delete-persistence-state'))
      else db.exec(testSql('empty-store-id'))
      db.close()
      await chmod(path, 0o600)

      expect(errorMessage(await backendFailure(path))).toMatch(/no valid store identity/)
    }
  })

  it('rejects invalid paths during service initialization', async () => {
    const path = await freshDbPath('dsh-sqlite-invalid-path-')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await expect(ctx.plugin(SessionPersistenceSqlite, { path: `${path}\0` })).rejects.toMatchObject({
      code: 'ERR_INVALID_ARG_VALUE',
    })
    await ctx.fiber.dispose()
  })

  it('rejects non-files and symbolic links', async () => {
    const directoryPath = await freshDbPath('dsh-sqlite-directory-')
    await mkdir(directoryPath)
    expect(errorMessage(await backendFailure(directoryPath)))
      .toMatch(/must be a regular file/)

    const linkPath = await freshDbPath('dsh-sqlite-link-')
    const target = join(linkPath, '..', 'target.db')
    await writeFile(target, '')
    await symlink(target, linkPath)
    expect(errorMessage(await backendFailure(linkPath)))
      .toMatch(/not a symbolic link/)

    const parentLinkPath = await freshDbPath('dsh-sqlite-parent-link-')
    const realParent = join(parentLinkPath, '..', 'real-parent')
    const linkedParent = join(parentLinkPath, '..', 'linked-parent')
    await mkdir(realParent, { mode: 0o700 })
    await symlink(realParent, linkedParent)
    expect(errorMessage(await backendFailure(join(linkedParent, 'sessions.db'))))
      .toMatch(/must be a real directory/)
  })

  it.runIf(
    process.getuid !== undefined && process.getuid() !== 0,
  )('rejects permissive files and writable parents', async () => {
    const permissivePath = await freshDbPath('dsh-sqlite-permissive-')
    await writeFile(permissivePath, '')
    await chmod(permissivePath, 0o644)
    expect(errorMessage(await backendFailure(permissivePath)))
      .toMatch(/accessible only by that user/)

    const writableParentPath = await freshDbPath('dsh-sqlite-parent-')
    await chmod(join(writableParentPath, '..'), 0o770)
    expect(errorMessage(await backendFailure(writableParentPath)))
      .toMatch(/not group\/world-writable/)
  })

  it('surfaces database creation failures after path validation', async () => {
    const path = await freshDbPath('dsh-sqlite-create-failure-')
    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    await store.validatePath()
    const parent = join(path, '..')
    await rm(parent, { recursive: true })
    await writeFile(parent, 'not a directory')
    await expect(store.open()).rejects.toThrow(/ENOENT|ENOTDIR/)
    await store.close()
  })
})

describe('SessionPersistenceSqlite truncate', () => {
  function stepStart(seq: number): SessionEvent {
    return { type: 'step/start', seq: SessionSeq(seq), time: seq + 1, data: { turn: 1, step: 1 } }
  }

  function stepEnd(seq: number): SessionEvent {
    return { type: 'step/end', seq: SessionSeq(seq), time: seq + 1, data: { turn: 1, step: 1 } }
  }

  it('cuts to zero, resumes appends at seq 0, and moves the revision durably', async () => {
    const path = await freshDbPath('dsh-sqlite-truncate-zero-')
    const mounted = await mountSqlite(path)
    try {
      const header = meta('truncate-zero')
      const handle = await mounted.persistence.create(header)
      await handle.append(oneTurnLog())
      const before = await mounted.persistence.stat(header.id)
      await handle.truncate!(SessionLogOffset(0))
      expect((await handle.read()).events).toEqual([])
      expect((await handle.read(0)).events).toEqual([])
      const after = await mounted.persistence.stat(header.id)
      expect(after?.revision).not.toBe(before?.revision)

      await handle.append([turnStart(0)])
      expect((await handle.read()).events).toEqual([turnStart(0)])
      await handle.close()

      const reopened = await mountSqlite(path)
      try {
        const reader = await reopened.persistence.open(header.id, 'read')
        expect((await reader.read()).events).toEqual([turnStart(0)])
        await reader.close()
      } finally {
        await reopened.dispose()
      }
    } finally {
      await mounted.dispose()
    }
  })

  it('cuts mid-log at a row boundary: the suffix goes, reads past the cut are empty, appends resume exactly at the cut', async () => {
    const path = await freshDbPath('dsh-sqlite-truncate-middle-')
    const mounted = await mountSqlite(path)
    try {
      const header = meta('truncate-middle')
      const log = oneTurnLog()
      const handle = await mounted.persistence.create(header)
      await handle.append(log)
      const before = await mounted.persistence.stat(header.id)
      await handle.truncate!(SessionLogOffset(3))
      expect((await handle.read()).events).toEqual(log.slice(0, 3))
      expect((await handle.read(3)).events).toEqual([])
      expect((await handle.read(99)).events).toEqual([])
      expect((await mounted.persistence.stat(header.id))?.revision).not.toBe(before?.revision)

      // The next append must start exactly at the cut: the wrong seq rejects
      // and the right seq is accepted durably.
      await expect(handle.append([turnStart(4, 2)])).rejects.toThrow(/expected 3/)
      await handle.append([turnStart(3, 2)])
      expect((await handle.read()).events.map(event => event.seq)).toEqual([0, 1, 2, 3])
      await handle.close()
    } finally {
      await mounted.dispose()
    }
  })

  it('a cut at or past the stored end is a no-op that leaves the log and revision alone', async () => {
    const path = await freshDbPath('dsh-sqlite-truncate-end-')
    const mounted = await mountSqlite(path)
    try {
      const header = meta('truncate-end')
      const log = oneTurnLog()
      const handle = await mounted.persistence.create(header)
      await handle.append(log)
      const before = await mounted.persistence.stat(header.id)

      await handle.truncate!(SessionLogOffset(log.length))
      expect((await handle.read()).events).toEqual(log)
      expect((await mounted.persistence.stat(header.id))?.revision).toBe(before?.revision)

      await handle.truncate!(SessionLogOffset(1_000))
      expect((await handle.read()).events).toEqual(log)
      expect((await mounted.persistence.stat(header.id))?.revision).toBe(before?.revision)

      // The next append still continues the stored end, not the no-op cut.
      await handle.append([turnStart(log.length, 2)])
      expect((await handle.read()).events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6])
      await handle.close()
    } finally {
      await mounted.dispose()
    }
  })

  it('lands a landing batch in the truncation transaction and resumes right after it', async () => {
    const path = await freshDbPath('dsh-sqlite-truncate-landing-')
    const mounted = await mountSqlite(path)
    try {
      const header = meta('truncate-landing')
      const handle = await mounted.persistence.create(header)
      await handle.append(oneTurnLog())
      const before = await mounted.persistence.stat(header.id)
      const landing = stepStart(3)
      await handle.truncate!(SessionLogOffset(3), { append: [landing] })
      // The cut and the landing batch are one committed step: both visible,
      // one revision move, and the next append continues after the batch.
      expect((await handle.read()).events).toEqual([...oneTurnLog().slice(0, 3), landing])
      const after = await mounted.persistence.stat(header.id)
      expect(after?.revision).not.toBe(before?.revision)
      await handle.append([turnEnd(4)])
      expect((await handle.read()).events.slice(3)).toEqual([landing, turnEnd(4)])
      await handle.close()
    } finally {
      await mounted.dispose()
    }
  })

  it('refuses a landing batch that does not start at the cut, leaving the log untouched', async () => {
    const path = await freshDbPath('dsh-sqlite-truncate-landing-offcut-')
    const mounted = await mountSqlite(path)
    try {
      const header = meta('truncate-landing-offcut')
      const handle = await mounted.persistence.create(header)
      await handle.append(oneTurnLog())
      const before = await handle.read()
      await expect(handle.truncate!(SessionLogOffset(3), { append: [stepStart(4)] }))
        .rejects.toThrow(/must start at the cut 3/)
      expect((await handle.read()).events).toEqual(before.events)
      await handle.close()
    } finally {
      await mounted.dispose()
    }
  })

  it('a read handle refuses truncate with SessionReadOnlyError and mutates nothing', async () => {
    const path = await freshDbPath('dsh-sqlite-truncate-read-only-')
    const mounted = await mountSqlite(path)
    try {
      const header = meta('truncate-read-only')
      const writer = await mounted.persistence.create(header)
      await writer.append(oneTurnLog())
      await writer.close()

      const reader = await mounted.persistence.open(header.id, 'read')
      await expect(reader.truncate?.(SessionLogOffset(0))).rejects.toBeInstanceOf(SessionReadOnlyError)
      expect((await reader.read()).events).toEqual(oneTurnLog())
      await reader.close()
    } finally {
      await mounted.dispose()
    }
  })

  it('a closed handle refuses truncate and rejects non-integer offsets', async () => {
    const path = await freshDbPath('dsh-sqlite-truncate-closed-')
    const mounted = await mountSqlite(path)
    try {
      const header = meta('truncate-closed')
      const handle = await mounted.persistence.create(header)
      await handle.append(oneTurnLog())
      await expect(handle.truncate!(-1 as SessionLogOffset)).rejects.toThrow(/non-negative safe integer/)
      await expect(handle.truncate!(1.5 as SessionLogOffset)).rejects.toThrow(/non-negative safe integer/)
      await handle.close()
      await expect(handle.truncate!(SessionLogOffset(0))).rejects.toBeInstanceOf(SessionHandleClosedError)
    } finally {
      await mounted.dispose()
    }
  })

  it('refuses a cut that enters the fork-inherited prefix', async () => {
    const path = await freshDbPath('dsh-sqlite-truncate-seeded-')
    const mounted = await mountSqlite(path)
    try {
      const header: SessionHeader = {
        version: SESSION_FORMAT_VERSION,
        id: SessionId('truncate-seeded'),
        createdAt: 1_000,
        isSeeded: true,
      }
      const handle = await mounted.persistence.create(header, {
        inheritedEventCount: SessionLogOffset(3),
      })
      await expect(handle.truncate!(SessionLogOffset(0)))
        .rejects.toThrow(/fork-inherited prefix \(3\)/)
      await expect(handle.truncate!(SessionLogOffset(2)))
        .rejects.toThrow(/fork-inherited prefix \(3\)/)
      // The cut at the inherited boundary discards nothing (empty log).
      await handle.truncate!(SessionLogOffset(3))
      await handle.close()
    } finally {
      await mounted.dispose()
    }
  })

  it('rewrites a synthetic packed row spanning the cut instead of dropping members below it', async () => {
    for (const toSeq of [4, 5]) {
      const path = await freshDbPath(`dsh-sqlite-truncate-packed-${toSeq}-`)
      const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
      const header = meta(`truncate-packed-${toSeq}`)
      await store.appendBatch(storage(header), [turnStart(0), stepStart(1)], false)
      // One synthetic packed row representing seqs 2..6 (5 members); plain-JSON
      // data bypasses the encoder's compression entirely.
      const raw = new DatabaseSync(path)
      raw.prepare(testSql('insert-packed-event')).run(header.id, 2, 1_000, JSON.stringify({
        turn: 1,
        step: 1,
        index: 0,
        dt: [1, 1, 1, 1],
        texts: ['a', 'b', 'c', 'd', 'e'],
      }))
      raw.close()
      await store.appendBatch(storage(header), [stepEnd(7), turnEnd(8)], true)

      const revision = (await store.stat(header.id))?.revision
      await store.truncateLog(storage(header), toSeq)
      expect((await store.stat(header.id))?.revision).not.toBe(revision)

      // Only the members below the cut survive. A remainder of 2 members is
      // below MIN_PACKED_ROW_MEMBERS, so it becomes scalar rows; a remainder
      // of 3 re-packs as one packed row.
      const probe = new DatabaseSync(path, { readOnly: true })
      const rows = (probe.prepare(testSql('select-event-rows')).all(header.id) as unknown as PhysicalRow[])
        .map(row => ({ seq: row.seq, type: row.type, ignorable: row.ignorable }))
      probe.close()
      const kept = toSeq - 2
      expect(rows.slice(0, 2)).toEqual([
        { seq: 0, type: 'turn/start', ignorable: null },
        { seq: 1, type: 'step/start', ignorable: null },
      ])
      expect(rows.slice(2)).toEqual(kept >= 3
        ? [{ seq: 2, type: 'text-chunks', ignorable: 0 }]
        : [
          { seq: 2, type: 'assistant/chunk', ignorable: null },
          { seq: 3, type: 'assistant/chunk', ignorable: null },
        ])

      // The next append lands exactly at the cut.
      await store.appendBatch(storage(header), [stepEnd(toSeq), turnEnd(toSeq + 1)], true)
      await store.close()
    }
  })

  it('publishes a legacy packed log on write open, then cuts the published rows cleanly', async () => {
    const path = await writeLegacyV0Fixture()
    const mounted = await mountSqlite(path)
    try {
      const writer = await mounted.persistence.open(LEGACY_ID, 'write')
      const full = (await writer.read()).events
      await writer.truncate!(SessionLogOffset(3))
      expect((await writer.read()).events).toEqual(full.slice(0, 3))
      await writer.append([turnStart(3, 2)])
      expect((await writer.read()).events.map(event => event.seq)).toEqual([0, 1, 2, 3])
      await writer.close()
    } finally {
      await mounted.dispose()
    }
  })

  it('other handles observe the intentional shrink once the revision moved, and still refuse an unrecorded shrink', async () => {
    const path = await freshDbPath('dsh-sqlite-truncate-shrink-guard-')
    const mounted = await mountSqlite(path)
    try {
      const header = meta('truncate-shrink-guard')
      const log = oneTurnLog()
      const writer = await mounted.persistence.create(header)
      await writer.append(log)
      const reader = await mounted.persistence.open(header.id, 'read')
      expect((await reader.read()).events).toEqual(log)

      // An intentional truncate moves the revision, so the concurrent reader
      // serves the shorter committed log instead of misreporting damage.
      await writer.truncate!(SessionLogOffset(3))
      expect((await reader.read()).events).toEqual(log.slice(0, 3))
      await writer.append([turnStart(3, 2)])
      expect((await reader.read()).events.map(event => event.seq)).toEqual([0, 1, 2, 3])

      // A shrink without any recorded mutation (raw row deletion) still
      // refuses as damage.
      const raw = new DatabaseSync(path)
      raw.prepare(testSql('delete-session-events')).run(header.id)
      raw.close()
      await expect(reader.read()).rejects.toThrow(/stored log shrank below a previously observed prefix/)
      await reader.close()
      await writer.close()
    } finally {
      await mounted.dispose()
    }
  })

  it('truncates a :memory: database and resumes appends at the cut', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceSqlite, { path: ':memory:' })
    try {
      const header = meta('memory-truncate')
      const handle = await ctx.sessionPersistence.create(header)
      await handle.append(oneTurnLog())
      await handle.truncate!(SessionLogOffset(2))
      expect((await handle.read()).events).toEqual(oneTurnLog().slice(0, 2))
      await handle.append([turnStart(2, 2)])
      expect((await handle.read()).events.map(event => event.seq)).toEqual([0, 1, 2])
      await handle.close()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
