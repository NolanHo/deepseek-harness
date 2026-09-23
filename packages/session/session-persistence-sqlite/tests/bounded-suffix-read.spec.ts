/**
 * Bounded stored-suffix reads: a caller that already holds an exclusive upper
 * bound must get exactly the stored events in `[fromSeq, bound)`, dense and
 * complete whenever the log holds rows at or past the bound, at the cost of
 * reading only the physical rows whose first logical seq precedes it. A scan
 * that cannot prove the bound re-runs whole-log so the corruption and torn-tail
 * classification stays the released one.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MessageId } from '@deepseek-ai/dsh-llm'
import {
  SessionId,
  SessionLogOffset,
  SessionSeq,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import { DEFAULT_BUSY_TIMEOUT_MS } from '@deepseek-ai/dsh-session-persistence-sqlite'
import { meta } from '../../session-persistence/tests/contract.ts'
import type { StoredLogicalEvent } from '../src/codec.ts'
import { SqliteStore } from '../src/store.ts'
import { testSql } from './test-sql.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true })
})

interface Mounted {
  readonly store: SqliteStore
  readonly path: string
  readonly header: SessionHeader
}

async function mountLog(prefix: string, events: readonly StoredLogicalEvent[]): Promise<Mounted> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(directory)
  const path = join(directory, 'sessions.db')
  const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
  const header = meta(prefix)
  await store.appendBatch({ meta: header, inheritedEventCount: SessionLogOffset(0) }, events, false)
  return { store, path, header }
}

/** `turns` closed turns: every event is a scalar physical row. */
function turnLog(turns: number): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let turn = 1; turn <= turns; turn++) {
    events.push({ type: 'turn/start', seq: SessionSeq(events.length), time: events.length, data: { turn } })
    events.push({
      type: 'user/message',
      seq: SessionSeq(events.length),
      time: events.length,
      surfaceOp: 'append',
      data: {
        id: MessageId(`turn-${String(turn)}`),
        role: 'user',
        content: [{ type: 'text', text: `q${String(turn)}` }],
        source: { kind: 'user' },
      },
    })
    events.push({
      type: 'turn/end',
      seq: SessionSeq(events.length),
      time: events.length,
      data: { turn, reason: { kind: 'completed' } },
    })
  }
  return events
}

/** One retired delta event; the schema-20 codec packs a run of these into rows. */
function chunk(seq: number, text = `token-${String(seq)}`): StoredLogicalEvent {
  return {
    type: 'assistant/chunk',
    seq: SessionSeq(seq),
    time: 1_000 + seq,
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } },
  }
}

/**
 * One turn whose delta run exceeds `MAX_PACKED_ROW_MEMBERS`: the codec writes a
 * full packed row for the first 1,024 deltas and a second one for the rest, so
 * a bound inside the run lands inside a row's logical span.
 */
function packedTurn(count: number): StoredLogicalEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: SessionSeq(1), time: 2, data: { turn: 1, step: 1 } },
    ...Array.from({ length: count }, (_, index) => chunk(index + 2)),
    { type: 'step/end', seq: SessionSeq(count + 2), time: count + 3, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: SessionSeq(count + 3), time: count + 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/** Make one stored row undecodable in place, as a torn tail or damage does. */
function corruptAt(mounted: Mounted, seq: number): void {
  const raw = new DatabaseSync(mounted.path)
  raw.prepare(testSql('corrupt-event-data')).run('{not json', mounted.header.id, seq)
  raw.close()
}

function seqs(events: readonly SessionEvent[]): number[] {
  return events.map(event => event.seq)
}

describe('bounded stored suffix reads', () => {
  it('returns exactly the stored events in [fromSeq, bound)', async () => {
    const events = turnLog(40)
    const { store, header } = await mountLog('dsh-sqlite-bound-', events)
    for (const fromSeq of [0, 1, 7, 40, 119]) {
      const unbounded = await store.loadStoredFrom(header.id, SessionLogOffset(fromSeq))
      for (const bound of [fromSeq, fromSeq + 1, 60, 61, 119, 120, 500]) {
        const bounded = await store.loadStoredFrom(header.id, SessionLogOffset(fromSeq), bound)
        const expected = (unbounded?.events ?? []).filter(event => event.seq < bound)
        expect(bounded?.events, `from ${fromSeq} to ${bound}`).toEqual(expected)
        // The page must be dense up to its bound whenever the log reaches it.
        if (bound > fromSeq && events.some(event => event.seq >= bound)) {
          expect(seqs(bounded?.events ?? []), `dense ${fromSeq}..${bound}`)
            .toEqual(Array.from({ length: bound - fromSeq }, (_, index) => fromSeq + index))
        }
      }
    }
    await store.close()
  })

  it('answers a bound at or past the stored end exactly like the unbounded read', async () => {
    const events = turnLog(3)
    const { store, header, path } = await mountLog('dsh-sqlite-bound-end-', events)
    // A torn physical tail: an undecodable row after the last committed turn end.
    await store.appendBatch({ meta: header, inheritedEventCount: SessionLogOffset(0) }, [
      { type: 'turn/start', seq: SessionSeq(events.length), time: 99, data: { turn: 4 } },
    ], true)
    const mounted = { store, path, header }
    corruptAt(mounted, events.length)

    for (const fromSeq of [0, 2, 9]) {
      const unbounded = await store.loadStoredFrom(header.id, SessionLogOffset(fromSeq))
      for (const bound of [events.length, events.length + 1, 500]) {
        const bounded = await store.loadStoredFrom(header.id, SessionLogOffset(fromSeq), bound)
        expect(bounded?.events, `from ${fromSeq} to ${bound}`).toEqual(unbounded?.events)
      }
    }
    await store.close()
  })

  it('reads a packed row straddling the bound whole and filters it per logical event', async () => {
    const events = packedTurn(1_030)
    const { store, header } = await mountLog('dsh-sqlite-bound-packed-', events)
    const end = events.length - 1
    expect(end).toBe(1_033)

    // A bound inside the first packed row's span (seqs 2..1_025): the row is
    // read whole and only its members below the bound may survive.
    expect((await store.loadStoredFrom(header.id, SessionLogOffset(700), 700))?.events).toEqual([])
    // One seq past that point keeps exactly the member at seq 700. The read
    // refuses it by seq — `assistant/chunk` left the event vocabulary, so the
    // surviving member below the bound is observable only through that refusal.
    await expect(store.loadStoredFrom(header.id, SessionLogOffset(700), 701))
      .rejects.toThrow(/event type "assistant\/chunk" \(seq 700\)/)

    // A bound at the last row's own seq excludes it without reading it, while
    // the two packed rows below the bound decode and filter against fromSeq.
    expect((await store.loadStoredFrom(header.id, SessionLogOffset(1_032)))?.events.map(event => event.seq))
      .toEqual([1_032, 1_033])
    expect((await store.loadStoredFrom(header.id, SessionLogOffset(1_032), 1_033))?.events.map(event => event.seq))
      .toEqual([1_032])
    await store.close()
  })

  it('falls back to the whole-log scan when a torn row sits below the bound', async () => {
    const events = turnLog(3)
    const { store, header, path } = await mountLog('dsh-sqlite-bound-torn-', events)
    const mounted = { store, path, header }
    // Damage inside the committed span, with a committed turn end after it: the
    // whole-log scan classifies it as corruption, a scan bounded below that turn
    // end can only see a removable tail.
    corruptAt(mounted, 4)

    await expect(store.loadStoredFrom(header.id, SessionLogOffset(0)))
      .rejects.toThrow(/invalid committed physical row at seq 4/)
    await expect(store.loadStoredFrom(header.id, SessionLogOffset(0), 6))
      .rejects.toThrow(/invalid committed physical row at seq 4/)
    // A bound below the damaged row never reads it.
    expect((await store.loadStoredFrom(header.id, SessionLogOffset(0), 4))?.events.map(event => event.seq))
      .toEqual([0, 1, 2, 3])
    await store.close()
  })

  it('filters the bound in the historical arm the same way', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-sqlite-bound-legacy-'))
    dirs.push(directory)
    const path = join(directory, 'sessions.db')
    const seed = new DatabaseSync(path)
    seed.exec(testSql('create-schema-19-db'))
    seed.exec(testSql('insert-schema-19-session'))
    seed.exec(testSql('insert-schema-19-events'))
    seed.close()
    await chmod(path, 0o600)
    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const id = SessionId('v0-chunks')
    // The fixture's schema-19 packed row spans stored seqs 2..4, so this arm
    // restores the whole log — a packed predecessor cannot be addressed by the
    // cuts an index answers — and filters the restored, re-based events.
    const unbounded = await store.loadStoredFrom(id, SessionLogOffset(2))
    const first = unbounded?.events[0]?.seq ?? 0
    expect((unbounded?.events.length ?? 0)).toBeGreaterThan(2)

    for (const bound of [first + 1, first + 2, first + 3, 100]) {
      const bounded = await store.loadStoredFrom(id, SessionLogOffset(2), bound)
      expect(bounded?.events, `legacy bound ${bound}`).toEqual(unbounded?.events.filter(event => event.seq < bound))
      expect(bounded?.storedEnd, `legacy end ${bound}`).toBe(unbounded?.storedEnd)
    }
    expect((await store.loadStoredFrom(id, SessionLogOffset(2), first))?.events).toEqual([])
    await store.close()
  })

  it('reports -1 as the stored end of a legacy log that holds no events', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-sqlite-bound-legacy-empty-'))
    dirs.push(directory)
    const path = join(directory, 'sessions.db')
    const seed = new DatabaseSync(path)
    seed.exec(testSql('create-schema-19-db'))
    seed.exec(testSql('insert-schema-19-session'))
    seed.close()
    await chmod(path, 0o600)
    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const id = SessionId('v0-chunks')

    expect((await store.loadStoredFrom(id, SessionLogOffset(0)))?.storedEnd).toBe(-1)
    expect((await store.loadStoredFrom(id, SessionLogOffset(0), 10))?.storedEnd).toBe(-1)
    await store.close()
  })
})
