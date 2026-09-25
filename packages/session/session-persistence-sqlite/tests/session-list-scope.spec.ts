/**
 * Stored-session list selection at the SQLite backend: a `listed` enumeration
 * discards `origin = 'subagent'` rows in the SQL scan, so the excluded row is
 * never decoded, while `parentSessionId` selects exactly that Session's
 * children whatever their origin. A created-but-unmaterialized session never
 * reaches the scan and obeys the same selection in memory.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSyncOptions, StatementSync } from 'node:sqlite'

/** Every statement the store prepared or executed, in order. */
const statements: string[] = []

vi.mock('node:sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:sqlite')>()
  class RecordingDatabaseSync extends actual.DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions) {
      super(path, ...(options === undefined ? [] : [options]))
    }

    override exec(source: string): void {
      statements.push(source)
      actual.DatabaseSync.prototype.exec.call(this, source)
    }

    override prepare(source: string): StatementSync {
      statements.push(source)
      // The base method by reference, not `super.prepare`: the SQL resource
      // boundary admits only resource-owned statements as that argument.
      return actual.DatabaseSync.prototype.prepare.call(this, source)
    }
  }
  return { ...actual, DatabaseSync: RecordingDatabaseSync }
})

import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import SessionPersistenceSqlite, { DEFAULT_BUSY_TIMEOUT_MS } from '@deepseek-ai/dsh-session-persistence-sqlite'
import { sql } from '../src/sql.ts'
import { SqliteStore } from '../src/store.ts'

const ROOT = SessionId('scope-root')
const FORK_CHILD = SessionId('scope-fork-child')
const SUBAGENT_CHILD = SessionId('scope-subagent-child')
const PENDING_SUBAGENT_CHILD = SessionId('scope-pending-subagent-child')

const dirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  const mounted = contexts.splice(0)
  const directories = dirs.splice(0)
  statements.length = 0
  const results = await Promise.allSettled(mounted.map(ctx => ctx.fiber.dispose()))
  for (const directory of directories) await rm(directory, { recursive: true, force: true })
  const failures: unknown[] = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length > 0) throw new AggregateError(failures, 'sqlite list-scope fixture cleanup failed')
})

/** One fresh database path inside a directory this suite removes afterwards. */
async function freshDbPath(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(directory)
  return join(directory, 'sessions.db')
}

/** One current-format header; a fork child is seeded with the parent's lineage. */
function header(id: SessionId, createdAt: number, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id, createdAt, isSeeded: false, ...extra }
}

function subagentChild(id: SessionId, createdAt: number): SessionHeader {
  return header(id, createdAt, { parentSession: ROOT, origin: 'subagent', delegationDepth: 1 })
}

/** Stored session ids as a set, because a listing promises no order. */
function ids(snapshots: readonly { readonly header: SessionHeader }[]): Set<SessionId> {
  return new Set(snapshots.map(snapshot => snapshot.header.id))
}

/** How many times a statement the store issued matches one resource. */
function statementCount(source: string): number {
  return statements.filter(statement => statement === source).length
}

/** Seed one durable session row per header, without materializing a log. */
async function seedRows(path: string, rows: readonly SessionHeader[]): Promise<void> {
  const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
  for (const meta of rows) {
    await store.materializeHeader({ meta, inheritedEventCount: SessionLogOffset(0) })
  }
  await store.close()
}

describe('SQLite stored-session list selection', () => {
  it('selects listed rows in the scan and keeps fork children', async () => {
    const path = await freshDbPath('dsh-sqlite-list-listed-')
    await seedRows(path, [
      header(ROOT, 400),
      header(FORK_CHILD, 300, { isSeeded: true, parentSession: ROOT }),
      subagentChild(SUBAGENT_CHILD, 200),
    ])
    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })

    statements.length = 0
    const listed = await store.list(undefined, { scope: 'listed' })
    expect(ids(listed)).toEqual(new Set([ROOT, FORK_CHILD]))
    expect(statementCount(sql('select-listed-sessions'))).toBe(1)
    expect(statementCount(sql('select-sessions'))).toBe(0)

    statements.length = 0
    const all = await store.list()
    expect(ids(all)).toEqual(new Set([ROOT, FORK_CHILD, SUBAGENT_CHILD]))
    expect(statementCount(sql('select-sessions'))).toBe(1)
    expect(statementCount(sql('select-listed-sessions'))).toBe(0)
    await store.close()
  })

  it('selects exactly one parent\'s children in the scan, whatever their origin', async () => {
    const path = await freshDbPath('dsh-sqlite-list-children-')
    await seedRows(path, [
      header(ROOT, 400),
      header(FORK_CHILD, 300, { isSeeded: true, parentSession: ROOT }),
      subagentChild(SUBAGENT_CHILD, 200),
      header(SessionId('scope-unrelated'), 100),
    ])
    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })

    statements.length = 0
    const children = await store.list(undefined, { parentSessionId: ROOT })
    expect(ids(children)).toEqual(new Set([FORK_CHILD, SUBAGENT_CHILD]))
    expect(statementCount(sql('select-parented-sessions'))).toBe(1)
    expect(statementCount(sql('select-sessions'))).toBe(0)
    await store.close()
  })
})

describe('SQLite stored-session list selection at the provider', () => {
  it('applies one selection to durable rows and unmaterialized sessions', async () => {
    const path = await freshDbPath('dsh-sqlite-list-pending-')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceSqlite, { path })
    const persistence = ctx.sessionPersistence

    const durableRoot = await persistence.create(header(ROOT, 400))
    await durableRoot.flush()
    const durableSubagent = await persistence.create(subagentChild(SUBAGENT_CHILD, 300))
    await durableSubagent.flush()
    // Created but never flushed: this child never reaches the SQL scan.
    const pendingSubagent = await persistence.create(subagentChild(PENDING_SUBAGENT_CHILD, 200))

    expect(ids(await persistence.list({ scope: 'listed' }))).toEqual(new Set([ROOT]))
    expect(ids(await persistence.list({ parentSessionId: ROOT }))).toEqual(new Set([
      SUBAGENT_CHILD,
      PENDING_SUBAGENT_CHILD,
    ]))
    expect(ids(await persistence.list())).toEqual(new Set([
      ROOT,
      SUBAGENT_CHILD,
      PENDING_SUBAGENT_CHILD,
    ]))

    await pendingSubagent.close()
    await durableSubagent.close()
    await durableRoot.close()
  })
})
