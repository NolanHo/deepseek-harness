// Fork patch (FORK_SURFACE.md): the session-row `⋯` menu contribution point.
import { describe, expect, it, vi } from 'vitest'
import { createSessionRowMenu } from '../src/client/fork/session-row-menu.ts'
import type { SessionRowMenuContribution } from '../src/client/fork/session-row-menu.ts'

/** One registrant-owned contribution over a fixed leaf list. */
function contribution(id: string, onSelect: SessionRowMenuContribution['onSelect'] = () => {}): SessionRowMenuContribution {
  return {
    id,
    label: id,
    submenu: () => [{ id: `${id}-leaf`, label: `${id} leaf` }],
    onSelect,
  }
}

describe('session row menu registry', () => {
  it('publishes registrations in order and keeps one snapshot reference between changes', () => {
    const menu = createSessionRowMenu()
    const empty = menu.snapshot()
    expect(empty).toEqual([])
    // React's useSyncExternalStore requires the same reference until a change.
    expect(menu.snapshot()).toBe(empty)

    const notified = vi.fn()
    const unsubscribe = menu.subscribe(notified)
    const first = contribution('first')
    const disposeFirst = menu.register(first)
    expect(notified).toHaveBeenCalledOnce()
    const withFirst = menu.snapshot()
    expect(withFirst).toEqual([first])
    expect(menu.snapshot()).toBe(withFirst)

    const second = contribution('second')
    menu.register(second)
    expect(notified).toHaveBeenCalledTimes(2)
    expect(menu.snapshot()).toEqual([first, second])

    disposeFirst()
    expect(notified).toHaveBeenCalledTimes(3)
    expect(menu.snapshot()).toEqual([second])

    unsubscribe()
    menu.register(contribution('third'))
    expect(notified).toHaveBeenCalledTimes(3)
  })

  it('rejects a duplicated contribution id without touching the published rows', () => {
    const menu = createSessionRowMenu()
    const first = contribution('snooze')
    menu.register(first)
    expect(() => menu.register(contribution('snooze'))).toThrow('sessionRowMenu: duplicate contribution id "snooze"')
    expect(menu.snapshot()).toEqual([first])
  })

  it('removes only the registration a disposer owns', () => {
    const menu = createSessionRowMenu()
    const first = contribution('snooze')
    const disposeFirst = menu.register(first)
    disposeFirst()
    // Re-registration under the same id (a plugin fiber reloads) outlives the
    // old disposer, which must not delete the new contribution.
    const replacement = contribution('snooze')
    menu.register(replacement)
    disposeFirst()
    expect(menu.snapshot()).toEqual([replacement])
    // The second call removes it; a third is a no-op.
    const disposeReplacement = menu.register(contribution('other'))
    disposeReplacement()
    disposeReplacement()
    expect(menu.snapshot()).toEqual([replacement])
  })
})
