/**
 * Fork patch (FORK_SURFACE.md) coverage for `@deepseek-ai/dsh-session-persistence-sqlite`:
 * `decodedLogCacheBytes` retains whole decoded logs behind a revision check the
 * store performs on every read. The specs below pin the invariants that make the
 * retention safe — never a hit without the revision just read, invalidation after
 * every local mutation and on close, only successful reads retained, unchanged
 * cancellation, and a hard byte ceiling with LRU eviction.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { MessageId, freezeMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  SessionLogOffset,
  SessionSeq,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import type { SessionStorageMetadata } from '@deepseek-ai/dsh-session-persistence'
import SessionPersistenceSqlite, { DEFAULT_BUSY_TIMEOUT_MS } from '@deepseek-ai/dsh-session-persistence-sqlite'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'
import { sql } from '../src/sql.ts'
import { SqliteStore } from '../src/store.ts'
import { decodedColumnText } from './decoded-text.ts'
import { testSql } from './test-sql.ts'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function freshDbPath(prefix = 'dsh-sqlite-decoded-log-cache-'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return join(directory, 'sessions.db')
}

/** One store over `path`; an omitted ceiling leaves the cache off, as the plugin default does. */
function openStore(path: string, decodedLogCacheBytes?: number): SqliteStore {
  return new SqliteStore({
    path,
    journalMode: 'wal',
    busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    ...decodedLogCacheBytes === undefined ? {} : { decodedLogCacheBytes },
  })
}

/** Wrap a contract header (unseeded, cut 0) for direct store calls. */
function storage(header: SessionHeader): SessionStorageMetadata {
  return { meta: header, inheritedEventCount: SessionLogOffset(0) }
}

/** One valid second turn, contiguous from seq 6, to append after {@link oneTurnLog}. */
function secondTurn(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(6), time: 7, data: { turn: 2 } },
    { type: 'user/message', seq: SessionSeq(7), time: 8, surfaceOp: 'append', data: freezeMessage({
      id: MessageId('second-turn-user'),
      role: 'user',
      content: [{ type: 'text', text: 'again' }],
      source: { kind: 'user' },
    }) },
    { type: 'step/start', seq: SessionSeq(8), time: 9, data: { turn: 2, step: 1 } },
    { type: 'step/end', seq: SessionSeq(9), time: 10, data: { turn: 2, step: 1 } },
    { type: 'turn/end', seq: SessionSeq(10), time: 11, data: { turn: 2, reason: { kind: 'completed' } } },
  ]
}

/**
 * The decoded JSON text bytes of one stored session, read from the database
 * rather than from the cache under test — the number the ceiling is charged.
 */
function storedTextBytes(path: string, id: SessionId): number {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const key = db.prepare(sql('select-session-key')).get(id) as { id: number }
    const rows = db.prepare(sql('select-events')).all(key.id) as { data: string | Uint8Array }[]
    return rows.reduce((total, row) => total + Buffer.byteLength(decodedColumnText(row.data)), 0)
  } finally {
    db.close()
  }
}

/** The same decoded text as {@link storedTextBytes}, measured in UTF-16 code units. */
function storedCodeUnits(path: string, id: SessionId): number {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const key = db.prepare(sql('select-session-key')).get(id) as { id: number }
    const rows = db.prepare(sql('select-events')).all(key.id) as { data: string | Uint8Array }[]
    return rows.reduce((total, row) => total + decodedColumnText(row.data).length, 0)
  } finally {
    db.close()
  }
}

/**
 * The name of the error one aborted call throws, or `resolved` when it does
 * not. `AbortSignal.throwIfAborted()` rethrows the signal's reason, so the
 * check reads `name` rather than assuming an `Error` instance.
 */
async function failureName(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
    return 'resolved'
  } catch (error: unknown) {
    return typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { readonly name: unknown }).name)
      : typeof error
  }
}

describe('decoded log cache', () => {
  it('retains nothing when the ceiling is omitted', async () => {
    const path = await freshDbPath()
    const store = openStore(path)
    const header = meta('decoded-cache-default-off')
    await store.appendBatch(storage(header), oneTurnLog(), false)

    const first = await store.loadStoredLog(header.id)
    const second = await store.loadStoredLog(header.id)

    expect(first?.events).toHaveLength(6)
    expect(second).not.toBe(first)
    expect(second?.events).not.toBe(first?.events)
    expect(second?.events[0]).not.toBe(first?.events[0])

    // A header-only session decodes to zero bytes, which is still a retained
    // log while a ceiling is configured — and nothing at all without one.
    const empty = meta('decoded-cache-default-off-empty')
    await store.materializeHeader(storage(empty))
    const emptyFirst = await store.loadStoredLog(empty.id)
    const emptySecond = await store.loadStoredLog(empty.id)

    expect(emptyFirst?.events).toEqual([])
    expect(emptySecond?.events).not.toBe(emptyFirst?.events)
    await store.close()
  })

  it('answers a repeat read of an unchanged session with the same frozen log', async () => {
    const path = await freshDbPath()
    const store = openStore(path, 64 * 1024)
    const header = meta('decoded-cache-hit')
    await store.appendBatch(storage(header), oneTurnLog(), false)

    const miss = await store.loadStoredLog(header.id)
    const hit = await store.loadStoredLog(header.id)

    expect(hit).toBe(miss)
    expect(hit?.events).toBe(miss?.events)
    expect(hit?.meta).toEqual(miss?.meta)
    expect(hit?.inheritedEventCount).toBe(miss?.inheritedEventCount)
    expect(hit?.revision).toBe(miss?.revision)
    expect(hit?.storedVersion).toBe(miss?.storedVersion)
    expect(hit?.tornFrom).toBeUndefined()
    expect(Object.isFrozen(hit?.events)).toBe(true)
    expect(Object.isFrozen(hit?.events[0])).toBe(true)
    await store.close()
  })

  it('drops the retained log after a local append and serves the appended events', async () => {
    const path = await freshDbPath()
    const store = openStore(path, 64 * 1024)
    const header = meta('decoded-cache-local-append')
    await store.appendBatch(storage(header), oneTurnLog(), false)
    const before = await store.loadStoredLog(header.id)
    expect(await store.loadStoredLog(header.id)).toBe(before)

    await store.appendBatch(storage(header), secondTurn(), true)
    const after = await store.loadStoredLog(header.id)

    expect(after).not.toBe(before)
    expect(after?.events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(after?.events.at(-1)?.type).toBe('turn/end')
    await store.close()
  })

  it('misses when another connection bumps the revision or writes rows', async () => {
    const path = await freshDbPath()
    const store = openStore(path, 64 * 1024)
    const header = meta('decoded-cache-foreign-write')
    await store.appendBatch(storage(header), oneTurnLog(), false)
    const cached = await store.loadStoredLog(header.id)
    expect(await store.loadStoredLog(header.id)).toBe(cached)

    const foreign = new DatabaseSync(path)
    try {
      const key = foreign.prepare(sql('select-session-key')).get(header.id) as { id: number }
      // A revision bump that changes no row: only the revision check can miss here.
      foreign.prepare(sql('update-session-revision')).run(header.id)
      const bumped = await store.loadStoredLog(header.id)
      expect(bumped).not.toBe(cached)
      expect(bumped?.events).toHaveLength(6)
      expect(bumped?.revision).not.toBe(cached?.revision)
      // The store keeps retaining: the read it just made is the next read's hit.
      expect(await store.loadStoredLog(header.id)).toBe(bumped)

      // A row written by the other connection after that read must be visible.
      foreign.prepare(sql('insert-event'))
        .run(key.id, 6, 'turn/start', 7, JSON.stringify({ turn: 2 }), null, null, null)
      foreign.prepare(sql('update-session-revision')).run(header.id)
      const written = await store.loadStoredLog(header.id)
      expect(written).not.toBe(bumped)
      expect(written?.events).toHaveLength(7)
      expect(written?.events.at(-1)?.seq).toBe(6)
    } finally {
      foreign.close()
    }
    await store.close()
  })

  it('drops the retained log after a truncate', async () => {
    const path = await freshDbPath()
    const store = openStore(path, 64 * 1024)
    const header = meta('decoded-cache-truncate')
    await store.appendBatch(storage(header), oneTurnLog(), false)
    const before = await store.loadStoredLog(header.id)
    expect(await store.loadStoredLog(header.id)).toBe(before)

    await store.truncateLog(storage(header), 3)
    const after = await store.loadStoredLog(header.id)

    expect(after).not.toBe(before)
    expect(after?.events.map(event => event.seq)).toEqual([0, 1, 2])
    await store.close()
  })

  it('drops the retained log after a cut at the stored end', async () => {
    const path = await freshDbPath()
    const store = openStore(path, 64 * 1024)
    const header = meta('decoded-cache-truncate-noop')
    await store.appendBatch(storage(header), oneTurnLog(), false)
    const before = await store.loadStoredLog(header.id)
    expect(await store.loadStoredLog(header.id)).toBe(before)

    // A cut at the stored end discards nothing, and still commits a revision.
    await store.truncateLog(storage(header), oneTurnLog().length)
    const after = await store.loadStoredLog(header.id)

    expect(after).not.toBe(before)
    expect(after?.events).toHaveLength(oneTurnLog().length)
    expect(after?.revision).not.toBe(before?.revision)
    await store.close()
  })

  it('drops the retained log after a repair of a torn tail', async () => {
    const path = await freshDbPath()
    const store = openStore(path, 64 * 1024)
    const header = meta('decoded-cache-repair')
    await store.appendBatch(storage(header), oneTurnLog(), false)

    const corrupt = new DatabaseSync(path)
    corrupt.prepare(testSql('insert-corrupt-event')).run(header.id, 6, 'turn/start', 7, '{not json', null)
    corrupt.close()

    const torn = await store.loadStoredLog(header.id)
    expect(torn?.tornFrom).toBe(6)
    expect(await store.loadStoredLog(header.id)).toBe(torn)

    await store.commitRepair(storage(header), 6, [])
    const repaired = await store.loadStoredLog(header.id)

    expect(repaired).not.toBe(torn)
    expect(repaired?.tornFrom).toBeUndefined()
    expect(repaired?.events).toHaveLength(6)
    await store.close()
  })

  it('drops the retained log when a migration is published over it', async () => {
    const path = await freshDbPath()
    const store = openStore(path, 64 * 1024)
    const header = meta('decoded-cache-publish')
    await store.appendBatch(storage(header), oneTurnLog(), false)
    const before = await store.loadStoredLog(header.id)
    expect(await store.loadStoredLog(header.id)).toBe(before)

    await store.publishStoredLog(storage(header), oneTurnLog().slice(0, 3))
    const after = await store.loadStoredLog(header.id)

    expect(after).not.toBe(before)
    expect(after?.events.map(event => event.seq)).toEqual([0, 1, 2])
    await store.close()
  })

  it('drops the retained log when a header materialization commits', async () => {
    const path = await freshDbPath()
    const store = openStore(path, 64 * 1024)
    const header = meta('decoded-cache-materialize')
    await store.materializeHeader(storage(header))

    const empty = await store.loadStoredLog(header.id)
    expect(empty?.events).toHaveLength(0)
    expect(await store.loadStoredLog(header.id)).toBe(empty)

    await store.materializeHeader(storage(header))
    expect(await store.loadStoredLog(header.id)).not.toBe(empty)
    await store.close()
  })

  it('bounds retained bytes with LRU eviction and never retains an oversized log', async () => {
    const path = await freshDbPath()
    const first = meta('decoded-cache-lru-a')
    const second = meta('decoded-cache-lru-b')
    const writer = openStore(path)
    await writer.appendBatch(storage(first), oneTurnLog(), false)
    await writer.appendBatch(storage(second), oneTurnLog(), false)
    await writer.close()

    const bytes = storedTextBytes(path, first.id)
    expect(bytes).toBeGreaterThan(0)
    expect(storedTextBytes(path, second.id)).toBe(bytes)

    // Exactly one entry fits: the ceiling is inclusive and bounds the total.
    const exact = openStore(path, bytes)
    const a = await exact.loadStoredLog(first.id)
    expect(await exact.loadStoredLog(first.id)).toBe(a)
    const b = await exact.loadStoredLog(second.id)
    expect(await exact.loadStoredLog(second.id)).toBe(b)
    expect(await exact.loadStoredLog(first.id)).not.toBe(a)
    await exact.close()

    // One byte under the log's own size: it is never retained at all.
    const tooSmall = openStore(path, bytes - 1)
    const oversized = await tooSmall.loadStoredLog(first.id)
    expect(await tooSmall.loadStoredLog(first.id)).not.toBe(oversized)
    await tooSmall.close()
  })

  it('charges UTF-8 bytes, not UTF-16 code units, so a multibyte log cannot be under-sized', async () => {
    const path = await freshDbPath()
    const header = meta('decoded-cache-multibyte')
    const text = '你好世界🙂'.repeat(3)
    const log = oneTurnLog().map(event => event.type !== 'user/message'
      ? event
      : {
          ...event,
          data: freezeMessage({
            id: MessageId('one-turn-user'),
            role: 'user',
            content: [{ type: 'text', text }], source: { kind: 'user' },
          }),
        })
    const writer = openStore(path)
    await writer.appendBatch(storage(header), log, false)
    await writer.close()

    const utf8 = storedTextBytes(path, header.id)
    const codeUnits = storedCodeUnits(path, header.id)
    // Multibyte text makes the two measures diverge; a ceiling at the code-unit count
    // must refuse the log, which is only true while the charge is UTF-8 bytes.
    expect(codeUnits).toBeGreaterThan(0)
    expect(codeUnits).toBeLessThan(utf8)

    const atCodeUnits = openStore(path, codeUnits)
    const first = await atCodeUnits.loadStoredLog(header.id)
    expect(await atCodeUnits.loadStoredLog(header.id)).not.toBe(first)
    await atCodeUnits.close()

    const atBytes = openStore(path, utf8)
    const retained = await atBytes.loadStoredLog(header.id)
    expect(await atBytes.loadStoredLog(header.id)).toBe(retained)
    await atBytes.close()
  })

  it('retains nothing when a stored log cannot be read', async () => {
    const path = await freshDbPath()
    const store = openStore(path, 64 * 1024)
    const header = meta('decoded-cache-corrupt')
    await store.appendBatch(storage(header), oneTurnLog(), false)
    await store.appendBatch(storage(header), secondTurn(), true)

    // Damage one committed row in place: the log still ends with a turn/end,
    // so the scan classifies this as corruption rather than a removable tail.
    const raw = new DatabaseSync(path)
    const key = raw.prepare(sql('select-session-key')).get(header.id) as { id: number }
    raw.prepare(sql('delete-event-row')).run(key.id, 6)
    raw.prepare(testSql('insert-corrupt-event')).run(header.id, 6, 'turn/start', 7, '{not json', null)
    raw.close()

    await expect(store.loadStoredLog(header.id)).rejects.toThrow(/invalid committed physical row at seq 6/)
    await expect(store.loadStoredLog(header.id)).rejects.toThrow(/invalid committed physical row at seq 6/)
    await store.close()
  })

  it('observes an aborted signal on a cached read exactly as on an uncached one', async () => {
    const path = await freshDbPath()
    const store = openStore(path, 64 * 1024)
    const header = meta('decoded-cache-abort')
    await store.appendBatch(storage(header), oneTurnLog(), false)
    const cached = await store.loadStoredLog(header.id)

    const warm = new AbortController()
    warm.abort()
    expect(await failureName(() => store.loadStoredLog(header.id, warm.signal))).toBe('AbortError')
    expect(await store.loadStoredLog(header.id)).toBe(cached)

    const uncached = openStore(path, 64 * 1024)
    const cold = new AbortController()
    cold.abort()
    expect(await failureName(() => uncached.loadStoredLog(header.id, cold.signal))).toBe('AbortError')
    await uncached.close()
    await store.close()
  })

  it('retains nothing across close and a fresh store over the same file', async () => {
    const path = await freshDbPath()
    const header = meta('decoded-cache-close')
    const writer = openStore(path)
    await writer.appendBatch(storage(header), oneTurnLog(), false)
    await writer.close()

    const first = openStore(path, 64 * 1024)
    const cached = await first.loadStoredLog(header.id)
    expect(await first.loadStoredLog(header.id)).toBe(cached)
    await first.close()

    const reopened = openStore(path, 64 * 1024)
    const fresh = await reopened.loadStoredLog(header.id)
    expect(fresh).not.toBe(cached)
    expect(fresh?.events).toEqual(cached?.events)
    expect(await reopened.loadStoredLog(header.id)).toBe(fresh)
    await reopened.close()
  })
})

describe('decodedLogCacheBytes configuration', () => {
  it('defaults to 0 and accepts a size', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { path: await freshDbPath() })
    expect((ctx.sessionPersistence as SessionPersistenceSqlite).config.decodedLogCacheBytes).toBe(0)
    await fiber.dispose()

    const sized = new Context()
    await sized.plugin(SessionStore)
    const sizedFiber = await sized.plugin(SessionPersistenceSqlite, {
      path: await freshDbPath(),
      decodedLogCacheBytes: 4096,
    })
    expect((sized.sessionPersistence as SessionPersistenceSqlite).config.decodedLogCacheBytes).toBe(4096)
    await sizedFiber.dispose()
  })

  it('rejects a negative or fractional ceiling', async () => {
    for (const invalid of [-1, 1.5]) {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await expect(ctx.plugin(SessionPersistenceSqlite, {
        path: await freshDbPath(),
        decodedLogCacheBytes: invalid,
      })).rejects.toThrow(/decodedLogCacheBytes/)
      await ctx.fiber.dispose()
    }
  })
})
