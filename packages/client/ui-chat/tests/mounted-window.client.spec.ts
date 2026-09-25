// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { GroupKey, NodeKey, RenderEntry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  MOUNTED_ROW_LIMIT, REVEAL_ROW_STEP, orderIndexOfAnchor, planMountedWindow, useMountedWindow,
  type MountedWindowInput,
} from '../src/client/chat/fork/mounted-window.ts'

afterEach(cleanup)

/** Resident keys `k0`…`k{count-1}`. */
function keys(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `k${index}`)
}

const node = (key: string): RenderEntry => ({ kind: 'node', key: key as NodeKey })
const group = (key: string): RenderEntry => ({ kind: 'group', key: key as GroupKey })

describe('mounted window plan', () => {
  it('bounds the mounted slice to the newest rows at the tail', () => {
    const order = keys(60)
    const plan = planMountedWindow(order.map(node), order, { kind: 'tail' }, false)
    expect(REVEAL_ROW_STEP * 2).toBe(MOUNTED_ROW_LIMIT)
    expect(plan.headKey).toBe('k10')
    expect(plan.keys.size).toBe(MOUNTED_ROW_LIMIT)
    expect(plan.entries[0]).toEqual(node('k10'))
    expect(plan.entries.at(-1)).toEqual(node('k59'))
    expect(plan.atTail).toBe(true)
    expect(plan.canReveal).toBe(true)
    expect(plan.signature).toBe(`k10:${MOUNTED_ROW_LIMIT}`)
  })

  it('mounts the head Turn control beside a window that starts below it', () => {
    const order = keys(60)
    // k0 is the Turn's control row and the tail window starts at k10.
    const plan = planMountedWindow(order.map(node), order, { kind: 'tail' }, false, [0])
    expect(plan.headKey).toBe('k10')
    expect(plan.entries[0]).toEqual(node('k0'))
    expect(plan.entries.at(-1)).toEqual(node('k59'))
    expect(plan.keys.size).toBe(MOUNTED_ROW_LIMIT + 1)
  })

  it('adds nothing when the head Turn control is inside the window', () => {
    const order = keys(60)
    const plan = planMountedWindow(order.map(node), order, { kind: 'tail' }, false, [20])
    expect(plan.keys.size).toBe(MOUNTED_ROW_LIMIT)
    expect(plan.entries[0]).toEqual(node('k10'))
  })

  it('mounts the head Turn control beside a frozen window', () => {
    const order = keys(80)
    // The frozen window (k40…) holds the later Turn's control; the head Turn's
    // own control below it mounts with the rows the frozen window holds.
    const plan = planMountedWindow(order.map(node), order, { kind: 'frozen', head: 'k40' }, false, [0, 45])
    expect(plan.headKey).toBe('k40')
    expect(plan.entries[0]).toEqual(node('k0'))
    expect(plan.keys.has('k45')).toBe(true)
  })

  it('falls back to the live tail when the frozen head left the order', () => {
    const order = keys(60)
    const plan = planMountedWindow(order.map(node), order, { kind: 'frozen', head: 'gone' }, false)
    expect(plan.headKey).toBe('k10')
    expect(plan.atTail).toBe(true)
  })

  it('mounts nothing before the resident order arrives', () => {
    const plan = planMountedWindow([], [], { kind: 'frozen', head: 'k0' }, false)
    expect(plan.entries).toEqual([])
    expect(plan.keys.size).toBe(0)
    expect(plan.headKey).toBeNull()
    expect(plan.atTail).toBe(true)
    expect(plan.canReveal).toBe(false)
    expect(plan.signature).toBe(':0')
  })

  it('mounts a group whose member run crosses the window', () => {
    const order = ['a', 'b', 'c', 'd', 'e']
    const entries = [node('a'), group('g'), node('e')]
    const plan = planMountedWindow(entries, order, { kind: 'frozen', head: 'c' }, false)
    expect(plan.entries).toEqual([group('g'), node('e')])
    expect(plan.canReveal).toBe(true)
  })

  it('drops a group whose member run sits above the window', () => {
    const order = ['a', 'b', 'c', 'd', 'e']
    const entries = [group('g'), node('c'), node('e')]
    const plan = planMountedWindow(entries, order, { kind: 'frozen', head: 'e' }, false)
    expect(plan.entries).toEqual([node('e')])
  })

  it('mounts a repeated response row with the group that owns it', () => {
    const order = ['a', 'r', 'c']
    // A reasoning group heads `[a, r]` and the reply entry repeats `r` as its own root.
    const entries = [group('g'), node('r'), node('c')]
    const plan = planMountedWindow(entries, order, { kind: 'frozen', head: 'c' }, false)
    expect(plan.entries).toEqual([node('c')])
    const withReply = planMountedWindow(entries, order, { kind: 'frozen', head: 'r' }, false)
    expect(withReply.entries).toEqual([group('g'), node('r'), node('c')])
    expect(withReply.keys.has('a')).toBe(false)
  })

  it('mounts a block of adjacent groups while any of its rows is inside the window', () => {
    const order = ['a', 'b', 'c', 'd']
    const entries = [group('g1'), group('g2'), node('d')]
    const plan = planMountedWindow(entries, order, { kind: 'frozen', head: 'd' }, false)
    expect(plan.entries).toEqual([group('g1'), group('g2'), node('d')])
    const outside = keys(60)
    const blocked = [group('g1'), group('g2'), node(outside[2] as string), ...outside.slice(3).map(node)]
    const bounded = planMountedWindow(blocked, outside, { kind: 'tail' }, false)
    expect(bounded.entries).not.toContainEqual(group('g1'))
  })

  it('adds nothing for an entry whose key a group already owns', () => {
    const plan = planMountedWindow([node('a'), group('g'), node('a')], ['a'], { kind: 'tail' }, false)
    expect(plan.entries).toEqual([node('a'), node('a')])
  })

  it('mounts a trailing group whose member run holds the window', () => {
    const plan = planMountedWindow([node('a'), group('g')], ['a', 'b', 'c'], { kind: 'frozen', head: 'a' }, false)
    expect(plan.entries).toEqual([node('a'), group('g')])
  })

  it('drops a group whose following root entry left the order', () => {
    // The run ends on the following entry's key, which no resident row carries.
    const plan = planMountedWindow([group('g'), node('gone')], ['a', 'b'], { kind: 'frozen', head: 'a' }, false)
    expect(plan.entries).toEqual([])
  })

  it('re-pairs from the head when the tail walk cannot close a member run', () => {
    const entries = [node('a'), group('g'), node('gone')]
    // The trailing group's follower is not resident, so the run rendered nothing
    // and the window mounts only the root entry it can place.
    expect(planMountedWindow(entries, ['a', 'b'], { kind: 'tail' }, false).entries).toEqual([node('a')])
    const stub = planMountedWindow(entries, ['a', 'b'], { kind: 'frozen', head: 'a' }, true)
    expect(stub.entries).toEqual([node('a')])
    expect(stub.keys.has('b')).toBe(true)
  })

  it('holds the resident tail slice beside a frozen window', () => {
    const order = keys(60)
    const entries = order.map(node)
    const plan = planMountedWindow(entries, order, { kind: 'frozen', head: 'k0' }, true)
    expect(plan.entries[0]).toEqual(node('k0'))
    expect(plan.entries.at(-1)).toEqual(node('k59'))
    expect(plan.keys.has('k59')).toBe(true)
    // The stub keeps live rows mounted; it is not part of the window's identity.
    expect(plan.signature).toBe(`k0:${MOUNTED_ROW_LIMIT}`)
    expect(plan.atTail).toBe(false)
  })

  it('reuses a frozen resolution until its resident key slice moves', () => {
    const entries = [node('head'), group('g'), node('tail')]
    const planned = (order: readonly string[]): readonly RenderEntry[] =>
      planMountedWindow(entries, order, { kind: 'frozen', head: 'head' }, false).entries
    expect(planned(['head', 'm0', 'm1', 'tail'])).toEqual([node('head'), group('g'), node('tail')])
    // The same head key and entries identity under different resident keys: the
    // cached pairing no longer describes this slice.
    expect(planned(['head', 'n0', 'n1', 'tail'])).toEqual([node('head'), group('g'), node('tail')])
    // A shorter resident order leaves the cached slice longer than the window.
    expect(planned(['head', 'n0', 'tail'])).toEqual([node('head'), group('g'), node('tail')])
  })

  it('does not cache a resolution whose member run had no resident end', () => {
    // `g1` heads a run that ends on `x`, which the order does not carry yet: the
    // run renders nothing, and only a key past the window can end it.
    const entries = [group('g1'), node('x')]
    const order = keys(60)
    const planned = (resident: readonly string[], source: readonly RenderEntry[]): readonly RenderEntry[] =>
      planMountedWindow(source, resident, { kind: 'frozen', head: 'k0' }, false).entries
    expect(planned(order, entries)).toEqual([])
    // `x` becomes resident past the unchanged window slice, which ends the run
    // over the mounted rows: the same pairing a fresh entries identity reports.
    const grown = [...order, 'x']
    expect(planned(grown, entries)).toEqual([group('g1')])
    expect(planned(grown, [group('g1'), node('x')])).toEqual([group('g1')])
  })

  it('visits only the window slice as the resident order grows', () => {
    let visits = 0
    // One root entry per resident row, plus the group whose members keep arriving:
    // the entries identity survives the append, so an append may cost only the
    // rows the window holds, not the whole root list.
    const entries = new Proxy([...keys(5_000).map(node), group('g')], {
      get(target, property, receiver): unknown {
        if (typeof property === 'string' && /^\d+$/.test(property)) visits += 1
        return Reflect.get(target, property, receiver)
      },
    }) as readonly RenderEntry[]
    const resident = (members: number): string[] => [...keys(5_000), ...keys(members).map(key => `m${key}`)]
    planMountedWindow(entries, resident(60), { kind: 'tail' }, false)
    planMountedWindow(entries, resident(60), { kind: 'frozen', head: 'k0' }, true)
    visits = 0
    for (const members of [160, 1_600, 16_000]) {
      const order = resident(members)
      expect(planMountedWindow(entries, order, { kind: 'tail' }, false).entries).toContainEqual(group('g'))
      expect(planMountedWindow(entries, order, { kind: 'frozen', head: 'k0' }, true).entries).toContainEqual(group('g'))
    }
    expect(visits).toBeLessThanOrEqual(4 * MOUNTED_ROW_LIMIT)
  })
})

describe('mounted window anchor keys', () => {
  it('resolves rendered anchor keys to resident rows', () => {
    expect(orderIndexOfAnchor(['k0', 'k1'], 'k1')).toBe(1)
    expect(orderIndexOfAnchor(['k0', 'k1'], '["k1","reasoning"]')).toBe(1)
    expect(orderIndexOfAnchor(['k0', 'k1'], 'group:["process","k1","reasoning"]')).toBe(1)
    expect(orderIndexOfAnchor(['k0', 'k1'], 'group:["process","k1",null]')).toBe(1)
    // The group part sits after the member key: a key in its place names no member.
    expect(orderIndexOfAnchor(['k0', 'k1'], 'group:["process",null,"k1"]')).toBe(-1)
    expect(orderIndexOfAnchor(['k0', 'k1'], 'group:["process","missing","k1"]')).toBe(-1)
    expect(orderIndexOfAnchor(['k0', 'k1'], 'group:["process","missing",null]')).toBe(-1)
    expect(orderIndexOfAnchor(['k0', 'k1'], 'group:["broken')).toBe(-1)
    expect(orderIndexOfAnchor(['k0', 'k1'], '["missing","reasoning"]')).toBe(-1)
    expect(orderIndexOfAnchor(['k0', 'k1'], '["broken')).toBe(-1)
    expect(orderIndexOfAnchor(['k0', 'k1'], 'call:tool-1')).toBe(-1)
    expect(orderIndexOfAnchor(['k0', 'k1'], null)).toBe(-1)
  })
})

describe('mounted window hook', () => {
  function input(overrides: Partial<MountedWindowInput> = {}): MountedWindowInput {
    const order = overrides.order ?? keys(60)
    return {
      entries: order.map(node), order, controls: [], followingTail: true, anchorKey: null, running: false,
      ...overrides,
    }
  }

  function bind(initial: MountedWindowInput) {
    return renderHook((props: MountedWindowInput) => useMountedWindow(props), { initialProps: initial })
  }

  it('mounts nothing before the resident order arrives', () => {
    const { result } = bind(input({ entries: [], order: [] }))
    expect(result.current.entries).toEqual([])
    expect(result.current.tailMounted).toBe(true)
  })

  it('mounts the head Turn control beside the window it governs', () => {
    const { result } = bind(input({ controls: [0] }))
    expect(result.current.entries[0]).toEqual(node('k0'))
    expect(result.current.keys.size).toBe(MOUNTED_ROW_LIMIT + 1)
  })

  it('starts at the live tail, which a reveal leaves alone without a reader row', () => {
    const { result, rerender } = bind(input())
    expect(result.current.atTail).toBe(true)
    expect(result.current.canReveal).toBe(true)
    expect(result.current.entries).toHaveLength(MOUNTED_ROW_LIMIT)
    // A following reader owns no row inside the window: moving the head would
    // unmount the newest rows the reading policy still reports as followed, so
    // the click pages resident history in instead.
    expect(result.current.revealable).toBe(false)
    act(() => { expect(result.current.reveal()).toBe(false) })
    expect(result.current.atTail).toBe(true)
    expect(result.current.tailMounted).toBe(true)
    expect(result.current.entries).toHaveLength(MOUNTED_ROW_LIMIT)
    rerender(input({ followingTail: false, anchorKey: 'k20' }))
    expect(result.current.atTail).toBe(false)
    expect(result.current.keys.has('k20')).toBe(true)
    // Releasing pairs with the reading policy clearing the saved row, which is
    // what lets the window stay at the tail.
    act(() => { result.current.release() })
    rerender(input({ followingTail: true, anchorKey: null }))
    expect(result.current.atTail).toBe(true)
    expect(result.current.tailMounted).toBe(true)
  })

  it('reveals older rows while the saved reader row stays mounted', () => {
    const order = keys(130)
    const { result } = bind(input({ order, followingTail: false, anchorKey: 'k70' }))
    expect(result.current.headKey).toBe('k45')
    expect(result.current.canReveal).toBe(true)
    expect(result.current.revealable).toBe(true)
    act(() => { expect(result.current.reveal()).toBe(true) })
    expect(result.current.headKey).toBe('k21')
    expect(result.current.keys.has('k70')).toBe(true)
    expect(result.current.keys.has('k20')).toBe(false)
    // The clamp stops the head once the reader row would leave the window.
    act(() => { expect(result.current.reveal()).toBe(false) })
    expect(result.current.headKey).toBe('k21')
    expect(result.current.canReveal).toBe(true)
    expect(result.current.revealable).toBe(false)
  })

  it('adopts the session reader row and holds the reader row across a prepend', () => {
    const order = keys(60)
    const { result, rerender } = bind(input({ order, followingTail: false, anchorKey: 'k20' }))
    expect(result.current.atTail).toBe(false)
    expect(result.current.headKey).toBe('k0')
    expect(result.current.keys.has('k20')).toBe(true)
    // The window keeps its distance above the reader row when older pages
    // prepend, which shifts every resident index under it.
    const prepended = [...keys(10).map(key => `old${key}`), ...order]
    rerender(input({ order: prepended, followingTail: false, anchorKey: 'k20' }))
    expect(result.current.headKey).toBe('oldk5')
    expect(result.current.keys.has('k20')).toBe(true)
    expect(result.current.entries).toHaveLength(MOUNTED_ROW_LIMIT)
  })

  it('freezes on a saved group anchor and keeps the row it names mounted', () => {
    const order = keys(60)
    const anchorKey = `group:${JSON.stringify(['process', 'k20', 'reasoning'])}`
    const { result } = bind(input({ order, followingTail: false, anchorKey }))
    expect(result.current.atTail).toBe(false)
    expect(result.current.keys.has('k20')).toBe(true)
    expect(result.current.entries).toHaveLength(MOUNTED_ROW_LIMIT)
  })

  it('keeps the tail at the resident floor for a saved anchor no row carries', () => {
    const order = keys(60)
    const { result } = bind(input({ order, followingTail: false, anchorKey: 'call:tool-1' }))
    expect(result.current.atTail).toBe(true)
    expect(result.current.entries).toHaveLength(MOUNTED_ROW_LIMIT)
  })

  it('keeps the tail when the saved reader row is inside the tail window', () => {
    const { result } = bind(input({ followingTail: false, anchorKey: 'k55' }))
    expect(result.current.atTail).toBe(true)
  })

  it('freezes once the reader row sits below a tail window', () => {
    const order = keys(60)
    const { result, rerender } = bind(input({ order }))
    expect(result.current.atTail).toBe(true)
    rerender(input({ order, followingTail: false, anchorKey: 'k0' }))
    expect(result.current.atTail).toBe(false)
    expect(result.current.headKey).toBe('k0')
    // A reader row inside the tail slice keeps the live tail mounted.
    rerender(input({ order, followingTail: true, anchorKey: null }))
    rerender(input({ order, followingTail: false, anchorKey: 'k55' }))
    expect(result.current.atTail).toBe(true)
  })

  it('mounts a resident row for a jump and reports whether the window moved', () => {
    const { result } = bind(input())
    act(() => { expect(result.current.hold('k0')).toBe(true) })
    expect(result.current.headKey).toBe('k0')
    act(() => { expect(result.current.hold('k0')).toBe(false) })
    act(() => { expect(result.current.hold('missing')).toBe(false) })
    act(() => { expect(result.current.hold(null)).toBe(false) })
    expect(result.current.atTail).toBe(false)
  })

  it('stops revealing when the reader row pins the window head', () => {
    const order = keys(100)
    const props = input({ order, followingTail: false, anchorKey: null })
    const { result, rerender } = bind(props)
    act(() => { expect(result.current.hold('k30')).toBe(true) })
    expect(result.current.headKey).toBe('k5')
    rerender({ ...props, anchorKey: 'k95' })
    expect(result.current.revealable).toBe(false)
    act(() => { expect(result.current.reveal()).toBe(false) })
  })

  it('returns a jump-moved window to the tail when the reader owns it again', () => {
    const order = keys(200)
    const { result, rerender } = bind(input({ order, followingTail: false, anchorKey: 'k0' }))
    act(() => { expect(result.current.hold('k100')).toBe(true) })
    expect(result.current.headKey).toBe('k75')
    expect(result.current.atTail).toBe(false)
    rerender(input({ order, followingTail: true, anchorKey: null }))
    expect(result.current.atTail).toBe(true)
    expect(result.current.tailMounted).toBe(true)
  })

  it('holds the resident tail beside a frozen window while a Turn streams', () => {
    const order = keys(60)
    const { result } = bind(input({ order, followingTail: false, anchorKey: 'k0', running: true }))
    expect(result.current.atTail).toBe(false)
    expect(result.current.tailMounted).toBe(true)
    expect(result.current.entries.at(-1)).toEqual(node('k59'))
  })
})
