/**
 * Statement-level coverage for bounded stored-suffix reads: the bound is a SQL
 * predicate on a physical row's first logical seq, so a bounded read touches
 * exactly the rows that may represent an event below it. A packed row whose
 * span straddles the bound is still read whole — its members are filtered per
 * logical event afterwards — and no row at or past the bound is read at all.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSyncOptions, StatementSync } from 'node:sqlite'

/** Every physical event query the store ran, with the rows it answered. */
const queries: {
  readonly source: string
  readonly args: readonly unknown[]
  readonly seqs: readonly number[]
}[] = []

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
      const statement = actual.DatabaseSync.prototype.prepare.call(this, source)
      if (!/\bfrom\s+events\b/iu.test(source)) return statement
      const all = statement.all.bind(statement)
      Object.defineProperty(statement, 'all', {
        value: (...args: Parameters<StatementSync['all']>) => {
          const rows = all(...args) as { readonly seq: number }[]
          queries.push({ source, args, seqs: rows.map(row => row.seq) })
          return rows
        },
      })
      return statement
    }
  }
  return { ...actual, DatabaseSync: RecordingDatabaseSync }
})

import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import { DEFAULT_BUSY_TIMEOUT_MS } from '@deepseek-ai/dsh-session-persistence-sqlite'
import { meta } from '../../session-persistence/tests/contract.ts'
import type { StoredLogicalEvent } from '../src/codec.ts'
import { sql } from '../src/sql.ts'
import { SqliteStore } from '../src/store.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true })
  queries.length = 0
})

/** One retired delta event; a run of these becomes one packed physical row. */
function chunk(seq: number): StoredLogicalEvent {
  return {
    type: 'assistant/chunk',
    seq: SessionSeq(seq),
    time: 1_000 + seq,
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: `t${String(seq)}` } },
  }
}

/** Scalar boundaries around a 1,030-delta run: one 1,024-member packed row and one 6-member row. */
function packedTurn(): StoredLogicalEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: SessionSeq(1), time: 2, data: { turn: 1, step: 1 } },
    ...Array.from({ length: 1_030 }, (_, index) => chunk(index + 2)),
    { type: 'step/end', seq: SessionSeq(1_032), time: 1_033, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: SessionSeq(1_033), time: 1_034, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/** `turns` closed turns, every event a scalar physical row. */
function turnLog(turns: number): StoredLogicalEvent[] {
  const events: StoredLogicalEvent[] = []
  for (let turn = 1; turn <= turns; turn++) {
    events.push({ type: 'turn/start', seq: SessionSeq(events.length), time: events.length, data: { turn } })
    events.push({
      type: 'turn/end',
      seq: SessionSeq(events.length),
      time: events.length,
      data: { turn, reason: { kind: 'completed' } },
    })
  }
  return events
}

describe('bounded stored suffix read statements', () => {
  it('reads only the physical rows whose first logical seq precedes the bound', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-sqlite-bound-sql-'))
    dirs.push(directory)
    const store = new SqliteStore({
      path: join(directory, 'sessions.db'),
      journalMode: 'wal',
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    })
    const header = meta('bound-statements')
    await store.appendBatch(
      { meta: header, inheritedEventCount: SessionLogOffset(0) },
      packedTurn(),
      false,
    )

    // The packed run straddles seq 700, so the read starts at the packed row's
    // own first seq and stops below the bound; the retired delta events it
    // would return are refused by the current vocabulary, which is why the
    // assertions below stop at the rows this read touched.
    queries.length = 0
    await store.loadStoredFrom(header.id, SessionLogOffset(700), 1_030).catch(() => undefined)
    const bounded = queries.at(-1)
    expect(bounded?.source).toBe(sql('select-events-from-through'))
    expect(bounded?.args.slice(1)).toEqual([2, 1_030])
    // The row at seq 2 spans members 2..1,025 and is read whole; the row at
    // 1,026 spans 1,026..1,031 and straddles the bound; nothing past it is read.
    expect(bounded?.seqs).toEqual([2, 1_026])

    queries.length = 0
    await store.loadStoredFrom(header.id, SessionLogOffset(700)).catch(() => undefined)
    const unbounded = queries.at(-1)
    expect(unbounded?.source).toBe(sql('select-events-from'))
    expect(unbounded?.args.slice(1)).toEqual([2])
    expect(unbounded?.seqs).toEqual([2, 1_026, 1_032, 1_033])
    await store.close()
  })

  it('reads the stored end inside the bound read\'s own transaction only', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-sqlite-bound-end-sql-'))
    dirs.push(directory)
    const store = new SqliteStore({
      path: join(directory, 'sessions.db'),
      journalMode: 'wal',
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    })
    const header = meta('bound-end-statements')
    const events: StoredLogicalEvent[] = turnLog(20)
    await store.appendBatch({ meta: header, inheritedEventCount: SessionLogOffset(0) }, events, false)
    const last = events.at(-1)?.seq ?? -1

    // A bounded read cannot see the stored rows' end, so it asks for it in the
    // same read transaction that selects its span — never in a second one, and
    // never outside a transaction, where the answer could describe a later log.
    statements.length = 0
    const bounded = await store.loadStoredFrom(header.id, SessionLogOffset(3), 30)
    expect(bounded?.storedEnd).toBe(last)
    const begin = statements.indexOf(sql('begin'))
    const maxSeq = statements.indexOf(sql('select-max-seq'))
    const commit = statements.indexOf(sql('commit'))
    expect(begin).toBeGreaterThanOrEqual(0)
    expect(maxSeq).toBeGreaterThan(begin)
    expect(maxSeq).toBeLessThan(commit)
    expect(statements.filter(source => source === sql('select-max-seq'))).toHaveLength(1)

    // The unbounded read keeps the released statement set: the whole validated
    // prefix already ends at the stored end, so no extra query runs.
    statements.length = 0
    const unbounded = await store.loadStoredFrom(header.id, SessionLogOffset(3))
    expect(unbounded?.storedEnd).toBe(last)
    expect(statements).toContain(sql('select-events-from'))
    expect(statements).not.toContain(sql('select-max-seq'))
    expect(statements).not.toContain(sql('select-events-from-through'))
    await store.close()
  })

  it('reports -1 as the stored end of an empty log', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-sqlite-bound-empty-'))
    dirs.push(directory)
    const store = new SqliteStore({
      path: join(directory, 'sessions.db'),
      journalMode: 'wal',
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    })
    const header = meta('bound-empty')
    await store.materializeHeader({ meta: header, inheritedEventCount: SessionLogOffset(0) })

    expect((await store.loadStoredFrom(header.id, SessionLogOffset(0), 10))?.storedEnd).toBe(-1)
    expect((await store.loadStoredFrom(header.id, SessionLogOffset(0)))?.storedEnd).toBe(-1)
    await store.close()
  })
})
