import { afterEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MessageId,
  ToolCallId,
  freezeMessage,
  type AssistantStreamRecord,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, {
  SessionSeq,
  type SessionEvent,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionPersistenceSqlite from '@deepseek-ai/dsh-session-persistence-sqlite'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

type BackendName = 'jsonl-zstd' | 'sqlite'

interface MountedBackend {
  readonly persistence: SessionPersistence
  /**
   * Fork seek surface, present only on the SQLite backend: the current-format
   * suffix read behind the session controller's paged cold history.
   */
  readFrom?(id: SessionId, fromSeq: number): Promise<{ readonly events: readonly SessionEvent[] }>
  dispose(): Promise<void>
}

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function freshDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

async function mount(name: BackendName, root: string): Promise<MountedBackend> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  switch (name) {
    case 'jsonl-zstd': {
      const fiber = await ctx.plugin(SessionPersistenceJsonl, { root: join(root, 'jsonl') })
      return { persistence: ctx.sessionPersistence, dispose: async () => { await fiber.dispose() } }
    }
    case 'sqlite': {
      const fiber = await ctx.plugin(SessionPersistenceSqlite, { path: join(root, 'sessions.db') })
      const sqlite = ctx.sessionPersistence as SessionPersistenceSqlite
      return {
        persistence: ctx.sessionPersistence,
        readFrom: (id, fromSeq) => sqlite.readFrom(id, fromSeq),
        dispose: async () => { await fiber.dispose() },
      }
    }
  }
}

function userMessage(seq: number, turn: number, text: string): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time: seq + 1,
    surfaceOp: 'append',
    data: freezeMessage({
      id: MessageId(`turn-${turn}-user`),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }),
  }
}

/** One settling assistant message carrying its exact timed model stream. */
function assistantMessage(input: {
  readonly seq: number
  readonly time: number
  readonly turn: number
  readonly step: number
  readonly id: string
  readonly stream: AssistantStreamRecord[]
}): SessionEvent {
  return {
    type: 'assistant/message',
    seq: SessionSeq(input.seq),
    time: input.time,
    surfaceOp: 'append',
    data: {
      turn: input.turn,
      step: input.step,
      message: freezeMessage({
        id: MessageId(input.id),
        role: 'assistant',
        content: [{ type: 'text', text: 'settled' }],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'mock' },
        },
      }),
      stream: input.stream,
    },
  }
}

/**
 * The compact stream form the accumulator produces: a delta becomes a packed
 * run, every other chunk stays a raw timed chunk record.
 */
function compactRecord(chunk: StreamChunk, time: number): AssistantStreamRecord {
  switch (chunk.type) {
    case 'text-delta':
      return { type: 'text-chunks', time0: time, index: chunk.index, dt: [], texts: [chunk.text] }
    case 'reasoning-delta':
      return { type: 'reasoning-chunks', time0: time, index: chunk.index, dt: [], texts: [chunk.text] }
    case 'tool-call-delta':
      return {
        type: 'tool-call-chunks',
        time0: time,
        index: chunk.index,
        dt: [],
        id: chunk.id,
        ...chunk.name === undefined ? {} : { name: chunk.name },
        args: [chunk.argumentsDelta],
      }
    default:
      return { type: 'chunk', time, chunk }
  }
}

/** One multi-stream second turn continuing {@link oneTurnLog}. */
function secondTurn(stream: AssistantStreamRecord[]): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(6), time: 9, data: { turn: 2 } },
    userMessage(7, 2, 'again'),
    { type: 'step/start', seq: SessionSeq(8), time: 9, data: { turn: 2, step: 1 } },
    assistantMessage({ seq: 9, time: 10, turn: 2, step: 1, id: 'second-turn-assistant', stream }),
    { type: 'step/end', seq: SessionSeq(10), time: 11, data: { turn: 2, step: 1 } },
    { type: 'turn/end', seq: SessionSeq(11), time: 12, data: { turn: 2, reason: { kind: 'completed' } } },
  ]
}

/** Every stream record kind in one log, including two packed run kinds. */
function mixedStreamLog(): SessionEvent[] {
  return [
    ...oneTurnLog(),
    ...secondTurn([
      { type: 'chunk', time: 10, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
      { type: 'text-chunks', time0: 10, index: 0, dt: [0, 1], texts: ['multi', '-stream', '-text'] },
      { type: 'reasoning-chunks', time0: 10, index: 1, dt: [1], texts: ['why', 'not'] },
      {
        type: 'tool-call-chunks',
        time0: 10,
        index: 2,
        dt: [2, 0],
        id: ToolCallId('named-call'),
        name: 'write',
        args: ['{', '"a"', '}'],
      },
      {
        type: 'tool-call-chunks',
        time0: 10,
        index: 3,
        dt: [1, 1],
        id: ToolCallId('unnamed-call'),
        args: ['{', '"b"', '}'],
      },
      { type: 'chunk', time: 10, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'multi-stream-text' } } },
      { type: 'chunk', time: 10, chunk: { type: 'finish', reason: { kind: 'stop' } } },
    ]),
  ]
}

/** One randomized second turn built from arbitrary stream chunks. */
function randomStreamLog(entries: readonly { readonly chunk: StreamChunk; readonly time: number }[]): SessionEvent[] {
  return [
    ...oneTurnLog(),
    ...secondTurn(entries.map(entry => compactRecord(entry.chunk, entry.time))),
  ]
}

function batches(events: readonly SessionEvent[], sizes: readonly number[]): SessionEvent[][] {
  const result: SessionEvent[][] = []
  let offset = 0
  let index = 0
  while (offset < events.length) {
    const size = sizes[index % sizes.length] as number
    result.push(events.slice(offset, offset + size))
    offset += size
    index += 1
  }
  return result
}

async function verifyBackend(
  name: BackendName,
  root: string,
  events: readonly SessionEvent[],
  sizes: readonly number[],
): Promise<void> {
  const header = { ...meta('differential', '/work'), delegationDepth: 0 }
  let mounted = await mount(name, root)
  try {
    const handle = await mounted.persistence.create(header)
    for (const batch of batches(events, sizes)) {
      await handle.append(batch)
    }
    expect((await handle.read()).events, name).toEqual(events)
    await handle.flush()
    await handle.close()

    const snapshot = await mounted.persistence.stat(header.id)
    expect(snapshot?.header, name).toMatchObject(header)
    expect((await mounted.persistence.list()).map(entry => entry.header.id), name).toContain(header.id)
    // Revisions are backend-owned tokens: stable across reads here, never
    // comparable with another backend's token.
    const listed = (await mounted.persistence.list()).find(entry => entry.header.id === header.id)
    expect((await mounted.persistence.stat(header.id))?.revision, name).toBe(snapshot?.revision)
    expect(listed?.revision, name).toBe(snapshot?.revision)

    if (name === 'sqlite') {
      for (let fromSeq = 0; fromSeq <= events.length + 1; fromSeq += 1) {
        const suffix = await mounted.readFrom?.(header.id, fromSeq)
        expect(suffix?.events, `${name} seq ${fromSeq}`).toEqual(events.slice(fromSeq))
      }
    }
  } finally {
    await mounted.dispose()
  }

  mounted = await mount(name, root)
  try {
    const reader = await mounted.persistence.open(header.id, 'read')
    expect((await reader.read()).events, `${name} reopen`).toEqual(events)
    await reader.close()
    expect((await mounted.persistence.stat(header.id))?.header, `${name} reopen`).toMatchObject(header)
  } finally {
    await mounted.dispose()
  }
}

const streamChunkArbitrary: fc.Arbitrary<StreamChunk> = fc.oneof(
  fc.record({ type: fc.constant<'text-delta'>('text-delta'), index: fc.nat(2), text: fc.string() }),
  fc.record({ type: fc.constant<'reasoning-delta'>('reasoning-delta'), index: fc.nat(2), text: fc.string() }),
  fc.record({
    type: fc.constant<'tool-call-delta'>('tool-call-delta'),
    index: fc.nat(2),
    id: fc.constantFrom(ToolCallId('call-1'), ToolCallId('call-2')),
    argumentsDelta: fc.string(),
  }),
  fc.record({
    type: fc.constant<'tool-call-delta'>('tool-call-delta'),
    index: fc.nat(2),
    id: fc.constantFrom(ToolCallId('call-1'), ToolCallId('call-2')),
    name: fc.constantFrom('read', 'write'),
    argumentsDelta: fc.string(),
  }),
  fc.record({
    type: fc.constant<'block-start'>('block-start'),
    index: fc.nat(2),
    blockType: fc.constant<'text'>('text'),
  }),
  fc.record({ type: fc.constant<'finish'>('finish'), reason: fc.constant({ kind: 'stop' as const }) }),
)

const randomWorkload = fc.record({
  entries: fc.array(fc.record({
    chunk: streamChunkArbitrary,
    time: fc.oneof(
      { weight: 4, arbitrary: fc.integer({ min: 0, max: 10_000 }) },
      { weight: 1, arbitrary: fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }) },
    ),
  }), { maxLength: 30 }),
  batchSizes: fc.array(fc.integer({ min: 1, max: 8 }), { minLength: 1, maxLength: 8 }),
}).map(({ entries, batchSizes }) => ({
  events: JSON.parse(JSON.stringify(randomStreamLog(entries))) as SessionEvent[],
  batchSizes,
}))

const randomizedDifferentialTimeoutMs = process.platform === 'win32' ? 120_000 : 60_000

describe('SQLite cross-backend differential behavior', () => {
  it('matches JSONL/Zstandard for every stream record kind, suffix, partition, and reopen', async () => {
    const events = mixedStreamLog()
    for (const [partitionIndex, sizes] of [[events.length], [1], [2, 1, 5, 3]].entries()) {
      const directory = await freshDirectory(`dsh-sqlite-matrix-${partitionIndex}-`)
      for (const name of ['jsonl-zstd', 'sqlite'] as const) {
        await verifyBackend(name, join(directory, name), events, sizes)
      }
    }
  }, 30_000)

  it('matches JSONL/Zstandard across randomized logical logs and append partitions', async () => {
    await fc.assert(fc.asyncProperty(randomWorkload, async ({ events, batchSizes }) => {
      const directory = await freshDirectory('dsh-sqlite-property-')
      for (const name of ['jsonl-zstd', 'sqlite'] as const) {
        await verifyBackend(name, join(directory, name), events, batchSizes)
      }
    }), { numRuns: 100, seed: 0x5A17E })
  }, randomizedDifferentialTimeoutMs)
})
