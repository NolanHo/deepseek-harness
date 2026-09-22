/**
 * Fork patch (FORK_SURFACE.md) coverage for `@deepseek-ai/dsh-session-persistence-sqlite`:
 * statement-level and snapshot coverage for the retained-log read. A hit answers
 * from the retained log without reading event rows, and object-level properties —
 * identity, frozen state, content — are identical whether a hit discards the rows
 * it read or never reads them, so only the recorded statements distinguish the
 * two; a foreign commit inside the read transaction pins which snapshot answers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSyncOptions, StatementSync } from 'node:sqlite'

/** Every statement this file's store prepares, in call order. */
const prepared: string[] = []
/** Every statement it executes directly (transaction control), in call order. */
const executed: string[] = []
/** The real class, so a test can open a connection the recorder does not wrap. */
let realDatabaseSync: typeof import('node:sqlite')['DatabaseSync']
/** Runs once before the next event-row statement is prepared. */
let beforeEventQuery: (() => void) | undefined

vi.mock('node:sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:sqlite')>()
  realDatabaseSync = actual.DatabaseSync
  class RecordingDatabaseSync extends actual.DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions) {
      super(path, ...(options === undefined ? [] : [options]))
    }

    override exec(statement: string): void {
      executed.push(statement)
      // The base method by reference, not `super.exec`: the SQL resource
      // boundary admits only resource-owned statements as that argument.
      actual.DatabaseSync.prototype.exec.call(this, statement)
    }

    override prepare(source: string): StatementSync {
      prepared.push(source)
      if (beforeEventQuery !== undefined && /\bfrom\s+events\b/iu.test(source)) {
        const run = beforeEventQuery
        beforeEventQuery = undefined
        run()
      }
      return actual.DatabaseSync.prototype.prepare.call(this, source)
    }
  }
  return { ...actual, DatabaseSync: RecordingDatabaseSync }
})

import { SessionLogOffset, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionStorageMetadata } from '@deepseek-ai/dsh-session-persistence'
import { DEFAULT_BUSY_TIMEOUT_MS } from '@deepseek-ai/dsh-session-persistence-sqlite'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'
import { sql } from '../src/sql.ts'
import { SqliteStore } from '../src/store.ts'
import { testSql } from './test-sql.ts'

const directories: string[] = []
afterEach(async () => {
  prepared.length = 0
  executed.length = 0
  beforeEventQuery = undefined
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function freshDbPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-sqlite-hit-no-read-'))
  directories.push(directory)
  return join(directory, 'sessions.db')
}

/** Wrap a contract header (unseeded, cut 0) for direct store calls. */
function storage(header: SessionHeader): SessionStorageMetadata {
  return { meta: header, inheritedEventCount: SessionLogOffset(0) }
}

/** Prepared statements that name the events table, in any query spelling. */
function eventRowStatements(): string[] {
  return prepared.filter(source => /\bfrom\s+events\b/iu.test(source))
}

/** One store over `path` with retention on, as the deployment runs it. */
function openStore(path: string): SqliteStore {
  return new SqliteStore({
    path,
    journalMode: 'wal',
    busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    decodedLogCacheBytes: 64 * 1024,
  })
}

describe('decoded log cache hit path', () => {
  it('answers a hit without reading event rows', async () => {
    const path = await freshDbPath()
    const writer = openStore(path)
    const header = meta('hit-no-event-read')
    await writer.appendBatch(storage(header), oneTurnLog(), false)
    await writer.close()

    const reader = openStore(path)
    // Open the connection outside the measured windows: connection setup runs
    // its own pragmas, which are not part of a read's statement cost.
    await reader.hasSession(header.id)
    prepared.length = 0
    executed.length = 0
    const cold = await reader.loadStoredLog(header.id)
    // The cold read must read the session row, its integer key, and the events:
    // this liveness check fails loudly if the recording driver stops
    // intercepting instead of passing.
    expect(prepared).toContain(sql('select-session'))
    expect(eventRowStatements()).toEqual([sql('select-events')])
    expect(prepared.filter(source => source === sql('select-session-key'))).toHaveLength(1)
    expect(executed).toEqual([sql('begin'), sql('commit')])

    prepared.length = 0
    executed.length = 0
    const hit = await reader.loadStoredLog(header.id)
    expect(hit).toBe(cold)
    // A hit reads the session row, no event rows, and no integer key: one
    // transaction and one snapshot, decided before the event query.
    expect(prepared).toContain(sql('select-session'))
    expect(eventRowStatements()).toEqual([])
    expect(prepared.filter(source => source === sql('select-session-key'))).toEqual([])
    expect(executed).toEqual([sql('begin'), sql('commit')])
    await reader.close()
  })

  it('answers from the snapshot its transaction read while another connection commits', async () => {
    const path = await freshDbPath()
    const writer = openStore(path)
    const header = meta('hit-snapshot', '/before')
    await writer.appendBatch(storage(header), oneTurnLog(), false)
    await writer.close()

    const reader = openStore(path)
    await reader.hasSession(header.id)
    prepared.length = 0
    executed.length = 0
    beforeEventQuery = () => {
      const foreign = new realDatabaseSync(path)
      try {
        foreign.prepare(testSql('update-session-cwd')).run('/after', header.id)
        foreign.prepare(sql('update-session-revision')).run(header.id)
      } finally {
        foreign.close()
      }
    }
    const raced = await reader.loadStoredLog(header.id)

    // The foreign write commits after this transaction's snapshot, so the read
    // answers the snapshot it read; the next read must see the new state rather
    // than a blend of both revisions.
    expect(raced?.meta.cwd).toBe('/before')
    const after = await reader.loadStoredLog(header.id)
    expect(after).not.toBe(raced)
    expect(after?.meta.cwd).toBe('/after')
    await reader.close()
  })
})
