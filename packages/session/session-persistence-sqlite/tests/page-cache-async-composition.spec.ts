/**
 * Fork patch (FORK_SURFACE.md) composition coverage for
 * `@deepseek-ai/dsh-session-persistence-sqlite`: `cacheSizeKib` and `asyncCodec`
 * are independent `Config` fields that one deployment row sets together, so a
 * store carrying both must apply the page cache to its connection and select the
 * thread-pool decoder for stored logs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { DatabaseSync, DatabaseSyncOptions } from 'node:sqlite'
import { zstdDecompress, zstdDecompressSync } from 'node:zlib'
import { MessageId, freezeMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  SessionSeq,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import SessionPersistenceSqlite from '@deepseek-ai/dsh-session-persistence-sqlite'
import { sql } from '../src/sql.ts'
import { meta } from '../../session-persistence/tests/contract.ts'
import { testSql } from './test-sql.ts'

/**
 * Page cache every composed mount in this file configures. The magnitude pins
 * the wiring, not the deployment's 1 GiB suggestion, which SQLite would hold
 * as a page-cache reservation on every connection the spec opens.
 */
const CACHE_KIB = 64

/** Every connection the recording driver hands out, in creation order. */
const connections: { path: string; db: DatabaseSync }[] = []

/** While set, the recording driver drops the composed mount's page-cache pragma. */
let dropCacheSizePragma = false

vi.mock('node:sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:sqlite')>()
  class RecordingDatabaseSync extends actual.DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions) {
      super(path, ...(options === undefined ? [] : [options]))
      connections.push({ path, db: this })
    }

    override exec(statement: string): void {
      if (dropCacheSizePragma && statement === sql('cache-size', CACHE_KIB)) return
      // The base method by reference, not `super.exec`: the SQL resource
      // boundary (`sql-resource-boundary.spec.ts`) admits only resource-owned
      // statements as that argument.
      actual.DatabaseSync.prototype.exec.call(this, statement)
    }
  }
  return { ...actual, DatabaseSync: RecordingDatabaseSync }
})

/**
 * Wrap both zstd decoders so a stored-log read reveals which entry point it
 * used; every wrapper forwards to the real implementation.
 */
vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:zlib')>()
  return {
    ...actual,
    zstdDecompress: vi.fn(actual.zstdDecompress),
    zstdDecompressSync: vi.fn(actual.zstdDecompressSync),
  }
})

const directories: string[] = []
afterEach(async () => {
  connections.splice(0)
  dropCacheSizePragma = false
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

beforeEach(() => {
  vi.mocked(zstdDecompress).mockClear()
  vi.mocked(zstdDecompressSync).mockClear()
})

async function freshDbPath(prefix = 'dsh-sqlite-compose-'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return join(directory, 'sessions.db')
}

interface MountedSqlite {
  readonly persistence: SessionPersistence
  dispose(): Promise<void>
}

/** Provider configuration this file mounts: the composed pair, one half, or neither. */
interface MountConfig {
  readonly cacheSizeKib?: number
  readonly asyncCodec?: boolean
}

async function mountSqlite(path: string, config: MountConfig): Promise<MountedSqlite> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(SessionPersistenceSqlite, { path, ...config })
  return { persistence: ctx.sessionPersistence, dispose: async () => { await fiber.dispose() } }
}

/** One mount carrying the page cache beside the codec choice this file composes. */
function composedMount(path: string, asyncCodec: boolean): Promise<MountedSqlite> {
  return mountSqlite(path, { cacheSizeKib: CACHE_KIB, asyncCodec })
}

/** One closed turn whose repetitive payloads compress under the schema dictionary. */
function compressibleLog(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: SessionSeq(1),
      time: 2,
      surfaceOp: 'append',
      data: freezeMessage({
        id: MessageId('composition-user'),
        role: 'user',
        content: [{ type: 'text', text: 'compressible user payload '.repeat(512) }],
        source: { kind: 'user' },
      }),
    },
    { type: 'step/start', seq: SessionSeq(2), time: 3, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      seq: SessionSeq(3),
      time: 4,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: freezeMessage({
          id: MessageId('composition-assistant'),
          role: 'assistant',
          content: [{ type: 'text', text: 'compressible assistant payload '.repeat(512) }],
          source: { kind: 'model', ...{ provider: 'mock', model: 'mock' } },
        }),
        stream: [],
      },
    },
    { type: 'step/end', seq: SessionSeq(4), time: 5, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: SessionSeq(5), time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

async function writeLog(
  path: string,
  asyncCodec: boolean,
  header: SessionHeader,
  events: readonly SessionEvent[],
): Promise<void> {
  const mounted = await composedMount(path, asyncCodec)
  try {
    const handle = await mounted.persistence.create(header)
    await handle.append(events)
    await handle.flush()
    await handle.close()
  } finally {
    await mounted.dispose()
  }
}

async function readLog(path: string, asyncCodec: boolean, id: SessionId): Promise<readonly SessionEvent[]> {
  const mounted = await composedMount(path, asyncCodec)
  try {
    const handle = await mounted.persistence.open(id, 'read')
    try {
      return (await handle.read()).events
    } finally {
      await handle.close()
    }
  } finally {
    await mounted.dispose()
  }
}

/** The page cache the live connection over `path` retained, read through its own handle. */
function retainedCacheSize(path: string): number {
  const opened = connections.filter(entry => entry.path === resolve(path))
  expect(opened).toHaveLength(1)
  return (opened[0]!.db.prepare(testSql('select-cache-size')).get() as { cache_size: number }).cache_size
}

const header = { ...meta('page-cache-async-composition', '/work'), delegationDepth: 0 }

describe('page cache and async codec composition', () => {
  it('accepts both fields together and still rejects a bad value in either', async () => {
    const mounted = await mountSqlite(':memory:', { cacheSizeKib: CACHE_KIB, asyncCodec: true })
    try {
      expect((mounted.persistence as SessionPersistenceSqlite).config.cacheSizeKib).toBe(CACHE_KIB)
      expect((mounted.persistence as SessionPersistenceSqlite).config.asyncCodec).toBe(true)
    } finally {
      await mounted.dispose()
    }

    const badCache = new Context()
    await badCache.plugin(SessionStore)
    await expect(badCache.plugin(SessionPersistenceSqlite, {
      path: ':memory:',
      cacheSizeKib: -1,
      asyncCodec: true,
    })).rejects.toThrow(/cacheSizeKib/u)
    await badCache.fiber.dispose()

    const badCodec = new Context()
    await badCodec.plugin(SessionStore)
    await expect(badCodec.plugin(SessionPersistenceSqlite, {
      path: ':memory:',
      cacheSizeKib: CACHE_KIB,
      asyncCodec: 'yes' as unknown as boolean,
    })).rejects.toThrow(/asyncCodec/u)
    await badCodec.fiber.dispose()
  })

  it('opens the connection with the configured page cache when both fields are set', async () => {
    const path = await freshDbPath()
    const events = compressibleLog()
    await writeLog(path, true, header, events)
    connections.splice(0)

    const mounted = await composedMount(path, true)
    try {
      const handle = await mounted.persistence.open(header.id, 'read')
      try {
        expect((await handle.read()).events).toEqual(events)
        expect(retainedCacheSize(path)).toBe(-CACHE_KIB)
      } finally {
        await handle.close()
      }
    } finally {
      await mounted.dispose()
    }
  })

  it("keeps SQLite's page-cache default when only the async codec is configured", async () => {
    const path = await freshDbPath()
    const mounted = await mountSqlite(path, { asyncCodec: true })
    try {
      await mounted.persistence.list()
      expect(retainedCacheSize(path)).toBe(-2_000)
    } finally {
      await mounted.dispose()
    }
  })

  it('reads the stored log through the thread-pool decoder when both fields are set', async () => {
    const path = await freshDbPath()
    const events = compressibleLog()
    await writeLog(path, false, header, events)
    vi.mocked(zstdDecompress).mockClear()
    vi.mocked(zstdDecompressSync).mockClear()

    expect(await readLog(path, true, header.id)).toEqual(events)
    expect(vi.mocked(zstdDecompress)).toHaveBeenCalled()
    expect(vi.mocked(zstdDecompressSync)).not.toHaveBeenCalled()

    vi.mocked(zstdDecompress).mockClear()
    expect(await readLog(path, false, header.id)).toEqual(events)
    expect(vi.mocked(zstdDecompressSync)).toHaveBeenCalled()
    expect(vi.mocked(zstdDecompress)).not.toHaveBeenCalled()
  })

  it('round-trips one stored log between the two codec settings with the page cache configured', async () => {
    const events = compressibleLog()
    const writtenOn = await freshDbPath()
    const writtenOff = await freshDbPath()

    await writeLog(writtenOn, true, header, events)
    await writeLog(writtenOff, false, header, events)

    expect(await readLog(writtenOn, false, header.id)).toEqual(events)
    expect(await readLog(writtenOff, true, header.id)).toEqual(events)
  })

  it('rejects the first use when the connection did not retain the configured page cache', async () => {
    const path = await freshDbPath()
    const mounted = await composedMount(path, true)
    dropCacheSizePragma = true
    try {
      await expect(mounted.persistence.list()).rejects
        .toThrow(/retained cache_size=-2000, expected -64 KiB/u)
    } finally {
      dropCacheSizePragma = false
      await mounted.dispose()
    }
  })
})
