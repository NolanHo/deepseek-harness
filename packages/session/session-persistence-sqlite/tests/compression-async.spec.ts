/**
 * Fork patch (FORK_SURFACE.md) coverage for `@deepseek-ai/dsh-session-persistence-sqlite`:
 * the `asyncCodec` thread-pool decoder must decide every stored row exactly as
 * the synchronous decoder does, and it must be the asynchronous zstd entry
 * point that performs the decompression.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { zstdCompressSync, zstdDecompress, zstdDecompressSync } from 'node:zlib'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  MAX_PACKED_DATA_BYTES,
  packChunkRuns,
  type StorageRecord,
  type StoredChunkEvent,
} from '../src/codec.ts'
import {
  bindRecord,
  scanRows,
  scanRowsOnThreadPool,
} from '../src/compression.ts'
import type { EventRow } from '../src/schema.ts'
import { decodedColumnText } from './decoded-text.ts'

/**
 * Wrap both zstd decoders so a test can observe which entry point a scan uses;
 * every wrapper forwards to the real implementation.
 */
vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:zlib')>()
  return {
    ...actual,
    zstdDecompress: vi.fn(actual.zstdDecompress),
    zstdDecompressSync: vi.fn(actual.zstdDecompressSync),
  }
})

/** One retired top-level delta event, the only shape schema-20 packs. */
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

/** The packer's declared input is the current vocabulary; these fixtures predate it. */
function packChunks(events: readonly StoredChunkEvent[]): StorageRecord[] {
  return packChunkRuns(events as unknown as readonly SessionEvent[])
}

function row(record: StorageRecord): EventRow {
  const bound = bindRecord(record)
  return {
    seq: bound.seq,
    type: bound.type,
    time: bound.time,
    data: bound.data,
    source_event_seqs: bound.sourceEventSeqs,
    surface_op: bound.surfaceOp,
    ignorable: bound.ignorable,
  }
}

/** Decoded JSON text length of one physical row, the scan's cache-size unit. */
function decodedBytes(physical: EventRow): number {
  return decodedColumnText(physical.data).length
}

/** One scalar event whose data column the shared dictionary compresses. */
function compressedScalar(seq: number): SessionEvent {
  return {
    type: 'assistant/message',
    seq: SessionSeq(seq),
    time: seq + 1,
    surfaceOp: 'append',
    data: { turn: 1, step: 1, text: `${seq}:`.concat('compressible payload '.repeat(400)) },
  } as unknown as SessionEvent
}

/** One small scalar event whose data column stays uncompressed text. */
function scalar(seq: number): SessionEvent {
  return { type: 'turn/start', seq: SessionSeq(seq), time: seq + 1, data: { turn: 1 } }
}

function turnEnd(seq: number): SessionEvent {
  return {
    type: 'turn/end',
    seq: SessionSeq(seq),
    time: seq + 1,
    data: { turn: 1, reason: { kind: 'completed' } },
  }
}

/** Capture a scan's value or its thrown message so both codecs compare uniformly. */
async function outcome(scan: () => unknown): Promise<unknown> {
  try {
    return { value: await scan() }
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

const packedRun = Array.from({ length: 40 }, (_, index) => chunk(index + 2))

describe('thread-pool row scan', () => {
  beforeEach(() => {
    vi.mocked(zstdDecompress).mockClear()
    vi.mocked(zstdDecompressSync).mockClear()
  })

  it('decodes a mixed physical log exactly as the synchronous scan does', async () => {
    const logical: SessionEvent[] = [
      scalar(0),
      compressedScalar(1),
      ...packedRun as unknown as SessionEvent[],
      chunk(42) as unknown as SessionEvent,
      turnEnd(43),
    ]
    const rows = [
      row(scalar(0)),
      row(compressedScalar(1)),
      ...packChunks(packedRun).map(row),
      row(chunk(42)),
      row(turnEnd(43)),
    ]
    expect(rows.some(candidate => candidate.data instanceof Uint8Array)).toBe(true)
    expect(rows.some(candidate => typeof candidate.data === 'string')).toBe(true)

    const pooled = await scanRowsOnThreadPool(rows)
    expect(pooled).toEqual(scanRows(rows))
    expect(pooled.preserved).toEqual(logical)
  })

  it('agrees on a torn tail, committed corruption, and malformed rows', async () => {
    const start = row(scalar(0))
    const skipped = row(scalar(2))
    const end = row(turnEnd(3))
    const malformed: EventRow = { ...start, data: Buffer.from('not zstd') }

    for (const rows of [[start, skipped], [start, skipped, end], [malformed]]) {
      expect(await outcome(() => scanRowsOnThreadPool(rows))).toEqual(await outcome(() => scanRows(rows)))
    }
  })

  it('passes the packed-row bound into the pool decode and classifies an oversized frame as the synchronous scan does', async () => {
    const start = row(scalar(0))
    const oversized: EventRow = {
      seq: 4,
      type: 'text-chunks',
      time: 1,
      data: zstdCompressSync(JSON.stringify({
        turn: 1,
        step: 1,
        index: 0,
        dt: [0, 0],
        texts: ['x'.repeat(MAX_PACKED_DATA_BYTES), 'b', 'c'],
      })),
      source_event_seqs: null,
      surface_op: null,
      ignorable: 0,
    }

    const pooled = await outcome(() => scanRowsOnThreadPool([start, oversized]))
    expect(pooled).toEqual(await outcome(() => scanRows([start, oversized])))
    // The oversized frame is an invalid removable tail, exactly as it is synchronously.
    expect(pooled).toEqual({
      value: {
        preserved: [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }],
        tornFrom: 4,
        // The frame's own decode failed, so only the scalar row's text counts.
        decodedBytes: decodedBytes(start),
      },
    })
    const pooledOptions = vi.mocked(zstdDecompress).mock.calls
      .map(call => call[1] as { readonly dictionary?: unknown; readonly maxOutputLength?: unknown })
    expect(pooledOptions).toHaveLength(1)
    expect(pooledOptions[0]?.maxOutputLength).toBe(MAX_PACKED_DATA_BYTES)
    expect(pooledOptions[0]?.dictionary).toBeInstanceOf(Buffer)
  })

  it('honors a scan base exactly as the synchronous scan does', async () => {
    const rows = [row(scalar(0)), row(compressedScalar(1)), row(turnEnd(2))]
    for (const base of [0, 1, 5]) {
      expect(await outcome(() => scanRowsOnThreadPool(rows, base)))
        .toEqual(await outcome(() => scanRows(rows, base)))
    }
    expect(await outcome(() => scanRowsOnThreadPool([], 7))).toEqual(await outcome(() => scanRows([], 7)))
  })

  it('decompresses on the thread pool, while the synchronous scan does not', async () => {
    const rows = [row(compressedScalar(0)), row(compressedScalar(1))]
    expect(rows.every(candidate => candidate.data instanceof Uint8Array)).toBe(true)

    await scanRowsOnThreadPool(rows)
    expect(vi.mocked(zstdDecompress)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(zstdDecompressSync)).not.toHaveBeenCalled()

    vi.mocked(zstdDecompress).mockClear()
    scanRows(rows)
    // Two rows, decoded once by the turn-end pass and again by the forward pass.
    expect(vi.mocked(zstdDecompressSync)).toHaveBeenCalledTimes(4)
    expect(vi.mocked(zstdDecompress)).not.toHaveBeenCalled()
  })

  it('leaves an undecodable column to the scan that owns row classification', async () => {
    const rows = [row(scalar(0)), { ...row(scalar(1)), data: Buffer.from('not zstd') }]
    expect(await scanRowsOnThreadPool(rows)).toEqual(scanRows(rows))
    expect(vi.mocked(zstdDecompress)).toHaveBeenCalledTimes(1)
    // The untouched column reaches the scan's own decode, which classifies the row.
    expect(vi.mocked(zstdDecompressSync)).toHaveBeenCalled()
  })
})
