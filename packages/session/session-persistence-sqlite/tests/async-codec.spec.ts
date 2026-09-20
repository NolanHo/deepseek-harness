/**
 * Fork patch (FORK_SURFACE.md) coverage for `@deepseek-ai/dsh-session-persistence-sqlite`:
 * the `asyncCodec` switch is a default-off, schema-validated `Config` field that
 * selects the thread-pool decoder, must change no stored byte, and must keep
 * both settings reading each other's logs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
import { meta } from '../../session-persistence/tests/contract.ts'
import { testSql } from './test-sql.ts'

/**
 * Wrap both zstd decoders so a test can observe which entry point a stored-log
 * read uses; every wrapper forwards to the real implementation.
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
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function freshDbPath(prefix = 'dsh-sqlite-async-codec-'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return join(directory, 'sessions.db')
}

interface MountedSqlite {
  readonly persistence: SessionPersistence
  dispose(): Promise<void>
}

async function mountSqlite(path: string, asyncCodec?: boolean): Promise<MountedSqlite> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(SessionPersistenceSqlite, asyncCodec === undefined ? { path } : { path, asyncCodec })
  return { persistence: ctx.sessionPersistence, dispose: async () => { await fiber.dispose() } }
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
        id: MessageId('async-codec-user'),
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
          id: MessageId('async-codec-assistant'),
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
  const mounted = await mountSqlite(path, asyncCodec)
  try {
    const handle = await mounted.persistence.create(header)
    await handle.append(events)
    await handle.flush()
    await handle.close()
  } finally {
    await mounted.dispose()
  }
}

async function readLog(path: string, asyncCodec: boolean | undefined, id: SessionId): Promise<readonly SessionEvent[]> {
  const mounted = await mountSqlite(path, asyncCodec)
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

function column(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return `text:${value}`
  if (value instanceof Uint8Array) return `blob:${Buffer.from(value).toString('hex')}`
  if (typeof value === 'number' || typeof value === 'bigint') return `number:${value}`
  throw new TypeError(`unexpected stored column type ${typeof value}`)
}

/** Every stored physical column of one database, flattened for byte comparison. */
function storedRows(path: string): string[][] {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare(testSql('select-event-columns')).all()
      .map(record => Object.values(record as Record<string, unknown>).map(column))
  } finally {
    db.close()
  }
}

const header = { ...meta('async-codec', '/work'), delegationDepth: 0 }

describe('asyncCodec configuration', () => {
  beforeEach(() => {
    vi.mocked(zstdDecompress).mockClear()
    vi.mocked(zstdDecompressSync).mockClear()
  })

  it('defaults off and rejects a value the schema does not declare', async () => {
    const path = await freshDbPath()
    const mounted = await mountSqlite(path)
    try {
      expect((mounted.persistence as SessionPersistenceSqlite).config.asyncCodec).toBe(false)
    } finally {
      await mounted.dispose()
    }

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await expect(ctx.plugin(SessionPersistenceSqlite, {
      path: await freshDbPath(),
      asyncCodec: 'yes' as unknown as boolean,
    })).rejects.toThrow(/asyncCodec/)
    await ctx.fiber.dispose()
  })

  it('writes byte-identical physical rows with the codec on and off', async () => {
    const off = await freshDbPath('dsh-sqlite-codec-off-')
    const on = await freshDbPath('dsh-sqlite-codec-on-')
    await writeLog(off, false, header, compressibleLog())
    await writeLog(on, true, header, compressibleLog())

    const offRows = storedRows(off)
    expect(offRows.some(row => row[3]?.startsWith('blob:') === true)).toBe(true)
    expect(storedRows(on)).toEqual(offRows)
  })

  it('reads the same events whichever codec wrote the log', async () => {
    const off = await freshDbPath('dsh-sqlite-codec-off-')
    const on = await freshDbPath('dsh-sqlite-codec-on-')
    const events = compressibleLog()
    await writeLog(off, false, header, events)
    await writeLog(on, true, header, events)

    expect(await readLog(off, undefined, header.id)).toEqual(events)
    expect(await readLog(on, undefined, header.id)).toEqual(events)
    expect(await readLog(off, true, header.id)).toEqual(events)
    expect(await readLog(on, false, header.id)).toEqual(events)
  })

  it('decompresses stored rows on the thread pool only when configured', async () => {
    const path = await freshDbPath('dsh-sqlite-codec-spy-')
    const events = compressibleLog()
    await writeLog(path, false, header, events)

    expect(await readLog(path, true, header.id)).toEqual(events)
    expect(vi.mocked(zstdDecompress)).toHaveBeenCalled()
    expect(vi.mocked(zstdDecompressSync)).not.toHaveBeenCalled()

    vi.mocked(zstdDecompress).mockClear()
    expect(await readLog(path, false, header.id)).toEqual(events)
    expect(vi.mocked(zstdDecompressSync)).toHaveBeenCalled()
    expect(vi.mocked(zstdDecompress)).not.toHaveBeenCalled()
  })
})
