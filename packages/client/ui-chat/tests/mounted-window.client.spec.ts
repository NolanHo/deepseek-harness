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
})

describe('mounted window anchor keys', () => {
  it('resolves rendered anchor keys to resident rows', () => {
    expect(orderIndexOfAnchor(['k0', 'k1'], 'k1')).toBe(1)
    expect(orderIndexOfAnchor(['k0', 'k1'], '["k1","reasoning"]')).toBe(1)
    expect(orderIndexOfAnchor(['k0', 'k1'], 'group:["process","k1"]')).toBe(-1)
    expect(orderIndexOfAnchor(['k0', 'k1'], '["missing","reasoning"]')).toBe(-1)
    expect(orderIndexOfAnchor(['k0', 'k1'], '["broken')).toBe(-1)
    expect(orderIndexOfAnchor(['k0', 'k1'], null)).toBe(-1)
  })
})

describe('mounted window hook', () => {
  function input(overrides: Partial<MountedWindowInput> = {}): MountedWindowInput {
    const order = overrides.order ?? keys(60)
    return {
      entries: order.map(node), order, followingTail: true, anchorKey: null, running: false,
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

  it('starts at the live tail and reveals toward older resident rows', () => {
    const { result } = bind(input())
    expect(result.current.atTail).toBe(true)
    expect(result.current.canReveal).toBe(true)
    expect(result.current.entries).toHaveLength(MOUNTED_ROW_LIMIT)
    act(() => { expect(result.current.reveal()).toBe(true) })
    expect(result.current.headKey).toBe('k0')
    expect(result.current.atTail).toBe(false)
    expect(result.current.canReveal).toBe(false)
    expect(result.current.tailMounted).toBe(false)
    act(() => { expect(result.current.reveal()).toBe(false) })
    act(() => { result.current.release() })
    expect(result.current.atTail).toBe(true)
    expect(result.current.tailMounted).toBe(true)
  })

  it('adopts the session reader row and holds the reader row across a prepend', () => {
    const order = keys(60)
    const { result, rerender } = bind(input({ order, followingTail: false, anchorKey: 'k20' }))
    expect(result.current.atTail).toBe(false)
    expect(result.current.headKey).toBe('k0')
    expect(result.current.keys.has('k20')).toBe(true)
    // The frozen head key keeps its row when older pages prepend above it.
    const prepended = [...keys(10).map(key => `old${key}`), ...order]
    rerender(input({ order: prepended, followingTail: false, anchorKey: 'k20' }))
    expect(result.current.headKey).toBe('k0')
    expect(result.current.keys.has('k20')).toBe(true)
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
    act(() => { expect(result.current.reveal()).toBe(false) })
  })

  it('holds the resident tail beside a frozen window while a Turn streams', () => {
    const order = keys(60)
    const { result } = bind(input({ order, followingTail: false, anchorKey: 'k0', running: true }))
    expect(result.current.atTail).toBe(false)
    expect(result.current.tailMounted).toBe(true)
    expect(result.current.entries.at(-1)).toEqual(node('k59'))
  })
})
