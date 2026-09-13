import type { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { RewriteRemovalHold } from '../src/fork/rewrite-hold.ts'

const sid = (id: string): SessionId => id as SessionId

/** Hold wired to one scripted live-Agent answer. */
function holdHarness(live: boolean): {
  readonly hold: RewriteRemovalHold
  readonly removals: SessionId[]
  readonly setLive: (value: boolean) => void
} {
  let isLive = live
  const removals: SessionId[] = []
  const hold = new RewriteRemovalHold({
    isLive: () => isLive,
    announceRemoved: (sessionId) => { removals.push(sessionId) },
  })
  return { hold, removals, setLive: (value) => { isLive = value } }
}

describe('RewriteRemovalHold', () => {
  it('swallows the removal of a Session the rewrite rebuilt', () => {
    const harness = holdHarness(false)
    const session = sid('session-rebuilt')
    const release = harness.hold.hold(session)

    expect(harness.hold.defer(session)).toBe(true)
    harness.setLive(true)
    release()

    expect(harness.removals).toEqual([])
    // The hold is spent: a later real removal is announced by its own caller.
    expect(harness.hold.defer(session)).toBe(false)
  })

  it('announces the removal when the rewrite left no live Agent', () => {
    const harness = holdHarness(false)
    const session = sid('session-failed')
    const release = harness.hold.hold(session)

    expect(harness.hold.defer(session)).toBe(true)
    release()

    expect(harness.removals).toEqual([session])
  })

  it('passes through a disposal no rewrite holds', () => {
    const harness = holdHarness(false)

    expect(harness.hold.defer(sid('session-untouched'))).toBe(false)
    expect(harness.removals).toEqual([])
  })

  it('releases once, so a double release announces nothing twice', () => {
    const harness = holdHarness(false)
    const session = sid('session-twice')
    const release = harness.hold.hold(session)

    expect(harness.hold.defer(session)).toBe(true)
    release()
    release()

    expect(harness.removals).toEqual([session])
  })

  it('defers only the held Session', () => {
    const harness = holdHarness(false)
    const held = sid('session-held')
    const release = harness.hold.hold(held)

    expect(harness.hold.defer(sid('session-other'))).toBe(false)
    expect(harness.hold.defer(held)).toBe(true)
    harness.setLive(true)
    release()

    expect(harness.removals).toEqual([])
  })
})
