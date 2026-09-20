import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { DatabaseSync, DatabaseSyncOptions } from 'node:sqlite'

/** Every connection the recording driver hands out, in creation order. */
const connections: { path: string; db: DatabaseSync }[] = []

vi.mock('node:sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:sqlite')>()
  class RecordingDatabaseSync extends actual.DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions) {
      super(path, ...(options === undefined ? [] : [options]))
      connections.push({ path, db: this })
    }
  }
  return { ...actual, DatabaseSync: RecordingDatabaseSync }
})

import SessionStore from '@deepseek-ai/dsh-session'
import SessionPersistenceSqlite from '@deepseek-ai/dsh-session-persistence-sqlite'
import { testSql } from './test-sql.ts'

const directories: string[] = []
afterEach(async () => {
  connections.splice(0)
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function freshDbPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-sqlite-page-cache-'))
  directories.push(directory)
  return join(directory, 'sessions.db')
}

/** Mount one provider, force its lazy open, and report its connection's page cache. */
async function mountedCacheSize(path: string, cacheSizeKib?: number): Promise<number> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(SessionPersistenceSqlite, {
    path,
    ...cacheSizeKib === undefined ? {} : { cacheSizeKib },
  })
  try {
    await ctx.sessionPersistence.list()
    const opened = connections.filter(entry => entry.path === resolve(path))
    expect(opened).toHaveLength(1)
    return (opened[0]!.db.prepare(testSql('select-cache-size')).get() as { cache_size: number }).cache_size
  } finally {
    await fiber.dispose()
  }
}

describe('SQLite page cache configuration', () => {
  it('applies the configured page cache in KiB to the connection it opens', async () => {
    expect(await mountedCacheSize(await freshDbPath(), 1_048_576)).toBe(-1_048_576)
  })

  it('keeps the SQLite default 2,000 KiB page cache when the field is omitted', async () => {
    expect(await mountedCacheSize(await freshDbPath())).toBe(-2_000)
  })

  it('applies each connection its own configured size, zero included', async () => {
    expect(await mountedCacheSize(await freshDbPath(), 0)).toBe(0)
    expect(await mountedCacheSize(await freshDbPath(), 64)).toBe(-64)
    expect(await mountedCacheSize(await freshDbPath(), 2_147_483_647)).toBe(-2_147_483_647)
  })

  it('rejects a negative, fractional, or out-of-range page cache at mount', async () => {
    for (const cacheSizeKib of [-1, 1.5, 2_147_483_648]) {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      const mounted = ctx.plugin(SessionPersistenceSqlite, { path: ':memory:', cacheSizeKib })
      await expect(mounted.then(() => 'mounted')).rejects.toThrow(/cacheSizeKib/u)
      await ctx.fiber.dispose()
    }
  })
})
