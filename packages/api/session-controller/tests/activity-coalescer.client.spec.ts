import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivityCoalescer } from '../src/client/sessions/fork/coalesced-refresh.ts'

describe('ambient activity coalescing', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('applies a lone activity immediately and flushes nothing later', () => {
    const flush = vi.fn<(pending: ReadonlyMap<string, number>) => void>()
    const coalescer = new ActivityCoalescer(200, flush)
    coalescer.collect('session-a', 100)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledWith(new Map([['session-a', 100]]))
    vi.advanceTimersByTime(300)
    expect(flush).toHaveBeenCalledTimes(1)
    coalescer.dispose()
  })

  it('buffers a stream to one flush per window with each session latest-wins', () => {
    const flush = vi.fn<(pending: ReadonlyMap<string, number>) => void>()
    const coalescer = new ActivityCoalescer(200, flush)
    coalescer.collect('session-a', 1)
    for (let i = 0; i < 10; i++) {
      coalescer.collect('session-a', 100 + i)
      coalescer.collect('session-b', 200 + i)
    }
    // First of the window applied immediately; the stream stays buffered.
    expect(flush).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(199)
    expect(flush).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(flush).toHaveBeenCalledTimes(2)
    expect(flush).toHaveBeenLastCalledWith(new Map([
      ['session-a', 109],
      ['session-b', 209],
    ]))
    // After the window closes, the next event applies immediately again.
    coalescer.collect('session-c', 500)
    expect(flush).toHaveBeenCalledTimes(3)
    coalescer.dispose()
  })

  it('drops buffered activities on dispose without flushing', () => {
    const flush = vi.fn<(pending: ReadonlyMap<string, number>) => void>()
    const coalescer = new ActivityCoalescer(200, flush)
    coalescer.collect('session-a', 1)
    coalescer.collect('session-a', 2)
    coalescer.dispose()
    vi.advanceTimersByTime(500)
    expect(flush).toHaveBeenCalledTimes(1)
  })
})
