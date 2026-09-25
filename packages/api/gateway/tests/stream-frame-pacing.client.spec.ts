import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FRAME_PACING_FRAME_BUDGET,
  FRAME_PACING_TIME_BUDGET_MS,
  afterFrame,
} from '../src/client/fork/stream-frame-pacing.ts'
import {
  RemoteJournalStream,
  RemoteStream,
  type RemoteJournalChange,
  type RemoteJournalFrame,
  type RemoteStreamFactory,
  type RemoteStreamOptions,
} from '../src/client/index.ts'

/** `MessageChannel` whose posted message runs only when the test delivers it. */
class ControlledChannel {
  private listener: (() => void) | undefined
  readonly port1 = {
    start: (): void => {},
    addEventListener: (_type: string, listener: () => void): void => { this.listener = listener },
    close: (): void => { this.closedPorts += 1 },
  }
  readonly port2 = {
    postMessage: (): void => { this.posted += 1 },
    close: (): void => { this.closedPorts += 1 },
  }
  posted = 0
  closedPorts = 0

  constructor() { channels.push(this) }

  /** Run the pending port message, as the host would on its next macrotask. */
  deliver(): void { this.listener?.() }
}

const channels: ControlledChannel[] = []

beforeEach(() => { channels.length = 0 })

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Control the clock the pacing module reads, so budget arithmetic is exact. */
function frozenClock(): (ms: number) => void {
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  return (ms) => { now = ms }
}

/** Drain every pending microtask without giving the event loop a macrotask. */
async function drainMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
}

/** Give the consumer one macrotask turn, so its microtask chain reaches the next park. */
function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

describe('afterFrame', () => {
  it('records a whole frame budget without yielding', async () => {
    vi.stubGlobal('MessageChannel', ControlledChannel)
    frozenClock()
    const signal = new AbortController().signal

    for (let frame = 1; frame < FRAME_PACING_FRAME_BUDGET; frame += 1) await afterFrame(signal)

    expect(channels).toEqual([])
  })

  it('yields on the frame that spends the budget and resumes on the next macrotask', async () => {
    vi.stubGlobal('MessageChannel', ControlledChannel)
    frozenClock()
    const signal = new AbortController().signal
    for (let frame = 1; frame < FRAME_PACING_FRAME_BUDGET; frame += 1) await afterFrame(signal)

    let settled = false
    const pending = afterFrame(signal).then(() => { settled = true })
    expect(channels).toHaveLength(1)
    await drainMicrotasks()
    expect(settled).toBe(false)

    channels[0]?.deliver()
    await pending

    expect(settled).toBe(true)
    expect(channels[0]?.posted).toBe(1)
    expect(channels[0]?.closedPorts).toBe(2)
  })

  it('yields after the time budget when frames arrive faster than it', async () => {
    vi.stubGlobal('MessageChannel', ControlledChannel)
    const at = frozenClock()
    const signal = new AbortController().signal

    for (let elapsed = 0; elapsed < FRAME_PACING_TIME_BUDGET_MS; elapsed += 1) {
      at(elapsed)
      await afterFrame(signal)
    }
    expect(channels).toEqual([])

    at(FRAME_PACING_TIME_BUDGET_MS)
    const pending = afterFrame(signal)

    expect(channels).toHaveLength(1)
    expect(channels[0]?.posted).toBe(1)
    channels[0]?.deliver()
    await pending
  })

  it('restarts the batch after an idle gap instead of yielding for a fresh frame', async () => {
    vi.stubGlobal('MessageChannel', ControlledChannel)
    const at = frozenClock()
    const signal = new AbortController().signal
    await afterFrame(signal)

    at(FRAME_PACING_TIME_BUDGET_MS * 3)
    await afterFrame(signal)
    expect(channels).toEqual([])

    at(FRAME_PACING_TIME_BUDGET_MS * 3 + 2)
    await afterFrame(signal)
    expect(channels).toEqual([])

    at(FRAME_PACING_TIME_BUDGET_MS * 3 + 4)
    const pending = afterFrame(signal)

    expect(channels).toHaveLength(1)
    channels[0]?.deliver()
    await pending
  })

  it('schedules no macrotask once the stream is aborted', async () => {
    vi.stubGlobal('MessageChannel', ControlledChannel)
    frozenClock()
    const lifetime = new AbortController()
    for (let frame = 1; frame < FRAME_PACING_FRAME_BUDGET; frame += 1) await afterFrame(lifetime.signal)

    lifetime.abort()
    await afterFrame(lifetime.signal)

    expect(channels).toEqual([])
  })

  it('settles a pending yield when the stream is aborted', async () => {
    vi.stubGlobal('MessageChannel', ControlledChannel)
    frozenClock()
    const lifetime = new AbortController()
    for (let frame = 1; frame < FRAME_PACING_FRAME_BUDGET; frame += 1) await afterFrame(lifetime.signal)

    let settled = false
    const pending = afterFrame(lifetime.signal).then(() => { settled = true })
    expect(channels).toHaveLength(1)

    lifetime.abort()
    await pending

    expect(settled).toBe(true)
    expect(channels[0]?.closedPorts).toBe(2)
  })

  it('falls back to a timer on a host without MessageChannel', async () => {
    vi.stubGlobal('MessageChannel', undefined)
    frozenClock()
    const signal = new AbortController().signal
    for (let frame = 1; frame < FRAME_PACING_FRAME_BUDGET; frame += 1) await afterFrame(signal)

    let settled = false
    const pending = afterFrame(signal).then(() => { settled = true })
    await drainMicrotasks()

    expect(settled).toBe(false)
    await pending
    expect(settled).toBe(true)
  })

  it('settles a pending fallback timer when the stream is aborted', async () => {
    vi.stubGlobal('MessageChannel', undefined)
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    frozenClock()
    const lifetime = new AbortController()
    for (let frame = 1; frame < FRAME_PACING_FRAME_BUDGET; frame += 1) await afterFrame(lifetime.signal)

    const pending = afterFrame(lifetime.signal)
    lifetime.abort()
    await pending
  })
})

interface Entry {
  readonly seq: number
}

interface Page {
  readonly entries: readonly Entry[]
}

interface PageRequest {
  readonly limit?: number
}

type JournalFrame = RemoteJournalFrame<Entry, number, Page>
type JournalChange = RemoteJournalChange<Page, Entry>

const AVAILABLE_CONNECTION = {
  generation: {
    getSnapshot: () => ({ id: 1, host: { home: '/home/fixture' } }),
    subscribe: () => () => {},
  },
}

const STREAM_FACTORY: RemoteStreamFactory = {
  $stream<Item>(options: RemoteStreamOptions<Item>): RemoteStream<Item> {
    return new RemoteStream(AVAILABLE_CONNECTION, options)
  },
}

/** Journal whose one follow generation yields a queued burst, then stays open. */
class BurstJournal extends RemoteJournalStream<Page, Entry, number, PageRequest> {
  constructor(
    private readonly frames: readonly JournalFrame[],
    changes: JournalChange[],
    failed: (error: unknown) => void,
    onChange: (published: number) => void,
  ) {
    super(STREAM_FACTORY, {
      name: 'burst journal',
      emptyCursor: -1,
      entries: value => value.entries,
      hasMore: () => false,
      first: entry => entry.seq,
      last: entry => entry.seq,
      compare: (left, right) => left - right,
      follows: (left, right) => right === left + 1,
      publish: (change) => {
        changes.push(change)
        onChange(publishedCount(changes))
      },
      failed,
    })
  }

  /** @inheritdoc */
  protected override async * follow(
    _request: PageRequest,
    signal: AbortSignal,
  ): AsyncIterable<JournalFrame> {
    for (const frame of this.frames) yield frame
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => { resolve() }, { once: true })
      if (signal.aborted) resolve()
    })
  }

  /** @inheritdoc */
  protected override readPage(): Promise<Page> {
    return Promise.reject(new Error('burst journal readPage is not expected'))
  }

  /** @inheritdoc */
  protected override repairRequest(request: PageRequest): PageRequest {
    return request
  }
}

/** Count the entries the journal published across every change kind. */
function publishedCount(changes: readonly JournalChange[]): number {
  let total = 0
  for (const change of changes) {
    if (change.type === 'append') total += 1
    else total += change.entries.length
  }
  return total
}

/** List the published entry sequence numbers in publication order. */
function entrySeqs(changes: readonly JournalChange[]): number[] {
  const seqs: number[] = []
  for (const change of changes) {
    if (change.type === 'append') seqs.push(change.entry.seq)
    else seqs.push(...change.entries.map(entry => entry.seq))
  }
  return seqs
}

function burstFixture(
  count: number,
  onChange: (published: number) => void = () => {},
): {
  readonly journal: RemoteJournalStream<Page, Entry, number, PageRequest>
  readonly changes: JournalChange[]
  readonly failed: ReturnType<typeof vi.fn>
} {
  const frames: JournalFrame[] = [{
    type: 'opened',
    cursor: 0,
    page: { entries: [{ seq: 0 }] },
  }]
  for (let seq = 1; seq < count; seq += 1) frames.push({ type: 'entry', entry: { seq } })
  const changes: JournalChange[] = []
  const failed = vi.fn()
  return {
    journal: new BurstJournal(frames, changes, failed, onChange),
    changes,
    failed,
  }
}

describe('RemoteJournalStream frame pacing', () => {
  it('parks the consumer between bounded batches while a queued burst drains', async () => {
    vi.stubGlobal('MessageChannel', ControlledChannel)
    const total = FRAME_PACING_FRAME_BUDGET * 3
    const fixture = burstFixture(total)

    await fixture.journal.open({})
    await nextTurn()

    expect(channels).toHaveLength(1)
    const firstBatch = publishedCount(fixture.changes)
    expect(firstBatch).toBeGreaterThan(0)
    expect(firstBatch).toBeLessThanOrEqual(FRAME_PACING_FRAME_BUDGET)
    expect(firstBatch).toBeLessThan(total)

    await drainMicrotasks()
    expect(publishedCount(fixture.changes)).toBe(firstBatch)

    let delivered = 0
    while (publishedCount(fixture.changes) < total) {
      const channel = channels[delivered]
      expect(channel).toBeDefined()
      channel?.deliver()
      delivered += 1
      await nextTurn()
    }

    expect(delivered).toBeGreaterThan(1)
    expect(entrySeqs(fixture.changes)).toEqual([...Array(total).keys()])
    expect(fixture.failed).not.toHaveBeenCalled()
    await fixture.journal.dispose()
  })

  it('settles a pending dispose without waiting for the parked turn', async () => {
    vi.stubGlobal('MessageChannel', ControlledChannel)
    const total = FRAME_PACING_FRAME_BUDGET * 4
    const fixture = burstFixture(total)

    await fixture.journal.open({})
    await nextTurn()

    expect(channels).toHaveLength(1)
    const drained = publishedCount(fixture.changes)
    await fixture.journal.dispose()

    expect(drained).toBeLessThan(total)
    expect(publishedCount(fixture.changes)).toBe(drained)
    expect(channels[0]?.closedPorts).toBe(2)
    expect(fixture.failed).not.toHaveBeenCalled()
  })

  it('returns to the event loop while a large burst drains', async () => {
    const total = 1_000
    const observed: number[] = []
    let published = 0
    let observationArmed = false
    const fixture = burstFixture(total, (count) => {
      published = count
      if (observationArmed) return
      observationArmed = true
      setTimeout(() => { observed.push(published) }, 0)
    })

    await fixture.journal.open({})
    await vi.waitFor(() => { expect(published).toBe(total) }, { interval: 5, timeout: 10_000 })

    expect(observed.length).toBeGreaterThan(0)
    expect(observed[0]).toBeGreaterThan(0)
    expect(observed[0]).toBeLessThan(total)
    expect(entrySeqs(fixture.changes)).toEqual([...Array(total).keys()])
    expect(fixture.failed).not.toHaveBeenCalled()
    await fixture.journal.dispose()
  })
})
