/**
 * Statement-level coverage for historical child evidence: a V3 restore collects
 * a parent's direct children from the sessions and events tables, a V4 restore
 * never looks at them, one connection collects a parent's children once, and a
 * committed mutation drops that collection so a later child still reaches the
 * parent's catalog.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
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

import { DatabaseSync } from 'node:sqlite'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { DEFAULT_BUSY_TIMEOUT_MS } from '@deepseek-ai/dsh-session-persistence-sqlite'
import { sql } from '../src/sql.ts'
import { SqliteStore } from '../src/store.ts'
import { testSql } from './test-sql.ts'

const BACKFILL_PARENT = SessionId('v3-backfill-parent')

const dirs: string[] = []
afterEach(async () => {
  for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true })
  statements.length = 0
})

/** One fresh database path inside a directory this suite removes afterwards. */
async function freshDbPath(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(directory)
  return join(directory, 'sessions.db')
}

/** Seed the frozen schema-19 shell with the corpus whose parent lists none of its children. */
async function writeBackfillChildrenFixture(): Promise<string> {
  const path = await freshDbPath('dsh-sqlite-child-statements-')
  const seed = new DatabaseSync(path)
  seed.exec(testSql('create-schema-19-db'))
  seed.exec(testSql('insert-v3-backfill-children'))
  seed.close()
  await chmod(path, 0o600)
  return path
}

/** Seed the frozen schema-19 shell with the corpus whose parent is already current format. */
async function writeNativeFixture(): Promise<string> {
  const path = await freshDbPath('dsh-sqlite-child-native-')
  const seed = new DatabaseSync(path)
  seed.exec(testSql('create-schema-19-db'))
  seed.exec(testSql('insert-v4-native-session'))
  seed.close()
  await chmod(path, 0o600)
  return path
}

function openStore(path: string): SqliteStore {
  return new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
}

/** How many times a statement the store issued matches one resource. */
function statementCount(source: string): number {
  return statements.filter(statement => statement === source).length
}

describe('historical child evidence statements', () => {
  it('never collects children for a current-format row', async () => {
    const path = await writeNativeFixture()
    const store = openStore(path)

    statements.length = 0
    const restored = await store.loadStoredLog(SessionId('v4-native-parent'))
    if (restored === undefined) throw new Error('the native parent did not load')
    expect(restored.storedVersion).toBe(SESSION_FORMAT_VERSION)
    expect(restored.events.map(event => event.type))
      .toEqual(['turn/start', 'step/start', 'step/end', 'turn/end'])
    // A current-format row restores through the flat catalog, so this parent's
    // stored child row is never read.
    expect(statementCount(sql('select-child-sessions'))).toBe(0)
    expect(statementCount(sql('select-child-descriptor-count'))).toBe(0)
    expect(statementCount(sql('select-child-descriptor'))).toBe(0)
    await store.close()
  })

  it('collects a parent\'s children once and reuses them across reads', async () => {
    const path = await writeBackfillChildrenFixture()
    const store = openStore(path)

    statements.length = 0
    await store.loadStoredLog(BACKFILL_PARENT)
    await store.loadStoredLog(BACKFILL_PARENT)
    expect(statementCount(sql('select-child-sessions'))).toBe(1)
    // Five of the six children have a stored identity this store validates, and
    // only the four carrying exactly one own descriptor have a payload decoded.
    expect(statementCount(sql('select-child-descriptor-count'))).toBe(5)
    expect(statementCount(sql('select-child-descriptor'))).toBe(4)
    await store.close()
  })

  it('recollects after a committed mutation materializes a later child', async () => {
    const path = await writeBackfillChildrenFixture()
    const store = openStore(path)

    statements.length = 0
    await store.loadStoredLog(BACKFILL_PARENT)
    expect(statementCount(sql('select-child-sessions'))).toBe(1)

    const lateChild = SessionId('v3-late-child')
    await store.materializeHeader({
      meta: {
        version: SESSION_FORMAT_VERSION,
        id: lateChild,
        createdAt: 9000,
        isSeeded: false,
        parentSession: BACKFILL_PARENT,
        origin: 'subagent',
      },
      inheritedEventCount: SessionLogOffset(0),
    })
    const restored = await store.loadStoredLog(BACKFILL_PARENT)
    expect(statementCount(sql('select-child-sessions'))).toBe(2)
    expect(restored?.events.filter(event => event.type === 'subagent/catalog').map(event => event.data))
      .toContainEqual({ version: 1, childId: 'v3-late-child', childCreatedAt: 9000, mode: 'unknown' })
    await store.close()
  })
})
