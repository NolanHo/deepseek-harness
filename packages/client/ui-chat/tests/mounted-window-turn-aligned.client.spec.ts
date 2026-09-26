// @vitest-environment jsdom
//
// Turn-aligned boundary for the fork-owned mounted transcript window.
//
// A history-loading boundary must land on a Turn start, so an assistant message
// is never exposed partially. The window head is that boundary: a head inside a
// Turn mounts the Turn's later rows without the rows above it (its
// `turn-process` control and its prompt), so the reader sees a Turn fragment
// whose start is not on screen.
//
// This suite pins the rule for the boundaries the client chooses while it grows
// the window over resident rows — the opening window derived from the saved
// reader row and each explicit reveal step — and pins the stated trade-off: a
// Turn start farther above the reader's row than `MOUNTED_ROW_LIMIT` rows cannot
// mount together with that row, so the step refuses and paging serves instead.
//
// The reader's own continuous gesture is one of those boundaries: a gesture the
// mounted head has stopped reveals the next Turn-aligned step, so the mounted
// flow never starts inside a Turn whose control row would then have to be mounted
// above it (that insertion moves the reading line with no scrollport write to
// absorb it).

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { NodeKey, RenderEntry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  MOUNTED_ROW_LIMIT, useMountedWindow,
  type MountedWindowInput, type MountedWindowPlan,
} from '../src/client/chat/fork/mounted-window.ts'

afterEach(cleanup)

const node = (key: string): RenderEntry => ({ kind: 'node', key: key as NodeKey })

/** Resident order of `stepsPerTurn` Turns: control, prompt, then steps. */
function transcript(stepsPerTurn: readonly number[]): {
  order: string[]
  controls: number[]
} {
  const order: string[] = []
  const controls: number[] = []
  stepsPerTurn.forEach((steps, index) => {
    const turn = index + 1
    controls.push(order.length)
    order.push(`t${turn}/control`, `t${turn}/user`)
    for (let step = 1; step <= steps; step++) order.push(`t${turn}/s${step}`)
  })
  return { order, controls }
}

/** Resident index the plan's head row holds, or -1 for an empty order. */
function headIndex(plan: MountedWindowPlan, order: readonly string[]): number {
  return plan.headKey === null ? -1 : order.indexOf(plan.headKey)
}

/** Last control at or above `head`, or -1 before the first Turn. */
function owningControl(controls: readonly number[], head: number): number {
  let found = -1
  for (const control of controls) if (control <= head) found = control
  return found
}

/**
 * Whether the window exposes a Turn from its middle: its head sits strictly
 * inside a Turn, so the rows above the head (the Turn's control, its prompt, and
 * its earlier steps) unmount while later rows of that same Turn mount.
 * @param plan - planned window.
 * @param controls - ascending resident indices of the Turn-process controls.
 * @param order - resident keys in transcript order.
 * @returns whether the head is a mid-Turn boundary.
 */
function midTurnHead(
  plan: MountedWindowPlan, controls: readonly number[], order: readonly string[],
): boolean {
  const head = headIndex(plan, order)
  const own = owningControl(controls, head)
  return head > 0 && own >= 0 && own !== head
}

/** One reader scroll at the mounted head: within one viewport, reader-owned. */
const atHead = { top: 0, height: 400, movedByReader: true }

function bind(initial: MountedWindowInput) {
  return renderHook((props: MountedWindowInput) => useMountedWindow(props), { initialProps: initial })
}

describe('opening window boundary', () => {
  it('opens at the Turn start that owns the derived head row', () => {
    // The reader holds t3/s2 (index 67) near the end of Turn 3, so the derived
    // head row (67 - 25 = 42) sits inside Turn 2, whose control is index 32.
    const { order, controls } = transcript([30, 30, 5])
    const { result } = bind({
      entries: order.map(node), order, controls, followingTail: false, anchorKey: 't3/s2', running: false,
    })

    expect(result.current.headKey).toBe('t2/control')
    expect(midTurnHead(result.current, controls, order)).toBe(false)
    // The head Turn mounts whole: its control and prompt are the rows above its
    // steps, and the reader's own row stays inside the window the snap moved.
    expect(result.current.keys.has('t2/control')).toBe(true)
    expect(result.current.keys.has('t2/user')).toBe(true)
    expect(result.current.keys.has('t3/s2')).toBe(true)
  })

  it('keeps the reader row when the Turn start cannot mount with it', () => {
    // One Turn of 120 steps: its control sits farther above the reader's row
    // (index 101) than the window budget, so the opening window keeps that row
    // and starts inside the Turn — the stated trade-off, not a snap.
    const { order, controls } = transcript([120])
    const { result } = bind({
      entries: order.map(node), order, controls, followingTail: false, anchorKey: 't1/s100', running: false,
    })

    expect(result.current.keys.has('t1/s100')).toBe(true)
    expect(result.current.headKey).toBe('t1/s71')
    expect(midTurnHead(result.current, controls, order)).toBe(true)
    expect(result.current.revealable).toBe(false)
  })
})

describe('reveal boundary', () => {
  it('reveals without exposing the Turn it lands inside', () => {
    const { order, controls } = transcript([30, 30, 5])
    const { result } = bind({
      entries: order.map(node), order, controls, followingTail: false, anchorKey: 't3/s2', running: false,
    })
    expect(midTurnHead(result.current, controls, order)).toBe(false)

    act(() => { result.current.reveal() })

    // Whatever the step did, the mounted window still starts on a Turn start:
    // no Turn fragment can open it.
    expect(midTurnHead(result.current, controls, order)).toBe(false)
    const own = owningControl(controls, headIndex(result.current, order))
    if (own >= 0) {
      expect(result.current.keys.has(order[own] as string)).toBe(true)
      expect(result.current.keys.has(order[own + 1] as string)).toBe(true)
    }
  })

  it('refuses a step whose Turn start cannot keep the reader row', () => {
    const { order, controls } = transcript([30, 30, 5])
    const { result } = bind({
      entries: order.map(node), order, controls, followingTail: false, anchorKey: 't3/s2', running: false,
    })
    expect(result.current.headKey).toBe('t2/control')

    // The requested step lands at index 18, whose Turn start is index 0: aligning
    // it would unmount the reader's row at index 67, so the gesture is a no-op
    // that keeps the aligned window and defers to the history page.
    act(() => { expect(result.current.reveal()).toBe(false) })
    expect(result.current.headKey).toBe('t2/control')
    expect(result.current.revealable).toBe(false)
  })

  it('steps to the previous Turn start from the reader scroll at the head', () => {
    const { order, controls } = transcript([30, 30, 5])
    const entries = order.map(node)
    const { result, rerender } = bind({
      entries, order, controls, followingTail: false, anchorKey: 't3/user', running: false,
    })
    // The opening window sits on Turn 2's start, with the reader's row inside it.
    expect(result.current.headKey).toBe('t2/control')
    // The reader's reading line has come back to the window head: the row their
    // sample re-reads is the row the step must keep.
    rerender({ entries, order, controls, followingTail: false, anchorKey: 't2/control', running: false })
    act(() => { expect(result.current.revealAtHead(atHead, false)).toBe(true) })

    // The step lands on the Turn start that owns the requested row and keeps the
    // reader's own row, which the slice it mounts still holds.
    expect(result.current.headKey).toBe('t1/control')
    expect(midTurnHead(result.current, controls, order)).toBe(false)
    expect(result.current.keys.has('t1/user')).toBe(true)
    expect(result.current.keys.has('t2/control')).toBe(true)
  })
})

describe('turn-aligned boundary sweep', () => {
  /** Control layouts a sweep tests for orders of one length. */
  function layouts(length: number): number[][] {
    const layouts = [[], [0], [0, 10], [0, 25], [0, 20, 60], [0, length >> 1], [0, 20, 45, 90], [0, length - 20]]
    return layouts.map(controls => [...new Set(controls.filter(control => control >= 0 && control < length))])
  }

  it('holds the opening head on a Turn start, or states why it cannot', () => {
    for (const length of [1, 25, 49, 50, 51, 71, 121]) {
      const order = Array.from({ length }, (_, index) => `k${index}`)
      const entries = order.map(node)
      for (const controls of layouts(length)) {
        for (let readerRow = 0; readerRow < length; readerRow += 3) {
          const { result } = renderHook(
            (props: MountedWindowInput) => useMountedWindow(props),
            {
              initialProps: {
                entries, order, controls, followingTail: false, anchorKey: order[readerRow] as string,
                running: false,
              },
            },
          )
          const plan = result.current
          const state = `length=${length} controls=[${controls.join(',')}] row=${readerRow}`
          expect(plan.keys.has(order[readerRow] as string), `${state}: reader row unmounted`).toBe(true)
          if (midTurnHead(plan, controls, order)) {
            // The stated trade-off: the head Turn's start sits farther above the
            // reader's row than the window holds, so alignment cannot keep it.
            const own = owningControl(controls, headIndex(plan, order))
            expect(own, `${state}: mid-Turn head`).toBeLessThan(readerRow - MOUNTED_ROW_LIMIT + 1)
          }
          cleanup()
        }
      }
    }
  })

  it('lands every moving reveal step on a Turn start and keeps the row it steps for', () => {
    let moved = 0
    for (const length of [1, 25, 49, 50, 51, 71, 121]) {
      const order = Array.from({ length }, (_, index) => `k${index}`)
      const entries = order.map(node)
      for (const controls of layouts(length)) {
        for (let readerRow = 0; readerRow < length; readerRow += 7) {
          const { result } = renderHook(
            (props: MountedWindowInput) => useMountedWindow(props),
            {
              initialProps: {
                entries, order, controls, followingTail: false, anchorKey: order[readerRow] as string,
                running: false,
              },
            },
          )
          const state = `length=${length} controls=[${controls.join(',')}] row=${readerRow}`
          // The opening window may already sit mid-Turn under the stated
          // trade-off; every step that moves must leave an aligned head and keep
          // the reader's own row.
          for (let guard = 0; guard <= length; guard++) {
            const before = result.current
            const head = headIndex(before, order)
            let stepped = false
            act(() => { stepped = before.reveal() })
            if (!stepped) break
            moved += 1
            const plan = result.current
            expect(midTurnHead(plan, controls, order), `${state}: step ${guard}`).toBe(false)
            expect(plan.keys.has(order[readerRow] as string),
              `${state}: step ${guard} dropped the row it stepped for (head ${head} -> ${headIndex(plan, order)}, key ${plan.headKey})`).toBe(true)
            expect(headIndex(plan, order), `${state}: step ${guard} did not move up`).toBeLessThan(head)
          }
          cleanup()
        }
      }
    }
    // Guard against a sweep that proves nothing: reveals must have moved.
    expect(moved).toBeGreaterThan(0)
  })

  it('never exposes a Turn fragment from a reader gesture at the head', () => {
    // The gesture is a boundary too: whatever it steps to, the mounted window
    // still starts on a Turn start and keeps the row it steps for.
    let moved = 0
    for (const length of [25, 50, 71, 121]) {
      const order = Array.from({ length }, (_, index) => `k${index}`)
      const entries = order.map(node)
      for (const controls of layouts(length)) {
        for (let readerRow = 0; readerRow < length; readerRow += 7) {
          const { result } = renderHook(
            (props: MountedWindowInput) => useMountedWindow(props),
            {
              initialProps: {
                entries, order, controls, followingTail: false, anchorKey: order[readerRow] as string,
                running: false,
              },
            },
          )
          const state = `length=${length} controls=[${controls.join(',')}] row=${readerRow}`
          for (let guard = 0; guard <= length; guard++) {
            const before = result.current
            const head = headIndex(before, order)
            let stepped = false
            act(() => { stepped = before.revealAtHead(atHead, false) })
            if (!stepped) break
            moved += 1
            const plan = result.current
            const stepped2 = headIndex(plan, order)
            expect(midTurnHead(plan, controls, order), `${state}: step ${guard}`).toBe(false)
            expect(plan.keys.has(order[readerRow] as string),
              `${state}: step ${guard} dropped the row it stepped for (head ${head} -> ${stepped2}, key ${plan.headKey})`).toBe(true)
            expect(stepped2, `${state}: step ${guard} did not move up`).toBeLessThan(head)
          }
          cleanup()
        }
      }
    }
    expect(moved).toBeGreaterThan(0)
  })

  it('keeps an opening head that already sits on a Turn start', () => {
    // The derived head row is exactly a Turn start (reader row 60 - 25 = 35), so
    // no snap applies and the head stays on the control row.
    const order = Array.from({ length: 121 }, (_, index) => `k${index}`)
    const controls = [0, 10, 35]
    const { result } = bind({
      entries: order.map(node), order, controls, followingTail: false, anchorKey: 'k60', running: false,
    })
    expect(result.current.headKey).toBe('k35')
    expect(midTurnHead(result.current, controls, order)).toBe(false)
    expect(result.current.keys.has('k60')).toBe(true)
  })

  it('holds a single-Turn order at the row clamp when its start cannot mount', () => {
    // One Turn of 60 steps: its control is farther above the reader's row (index
    // 60) than the window holds, so the opening window keeps that row and the
    // reveal gesture defers to the history page.
    const { order, controls } = transcript([60])
    const { result } = bind({
      entries: order.map(node), order, controls, followingTail: false, anchorKey: 't1/s59', running: false,
    })
    expect(result.current.keys.has('t1/s59')).toBe(true)
    expect(midTurnHead(result.current, controls, order)).toBe(true)
    expect(owningControl(controls, headIndex(result.current, order)))
      .toBeLessThan(60 - MOUNTED_ROW_LIMIT + 1)
    expect(result.current.revealable).toBe(false)
    act(() => { expect(result.current.reveal()).toBe(false) })
    expect(result.current.keys.has('t1/s59')).toBe(true)
  })

  it('steps the reader gesture but not the explicit reveal for a row no key carries', () => {
    // The session's scroll memory holds an anchor with no resident row: the
    // window keeps the tail kind, the explicit reveal refuses because it would
    // unmount the newest rows, and the reader's own gesture still steps because it
    // has no reader row to keep — it lands on the Turn start owning the step.
    const { order, controls } = transcript([30, 30])
    const { result } = bind({
      entries: order.map(node), order, controls, followingTail: false, anchorKey: 'call:missing', running: false,
    })
    expect(result.current.atTail).toBe(true)
    expect(result.current.revealable).toBe(false)
    act(() => { expect(result.current.reveal()).toBe(false) })
    act(() => { expect(result.current.revealAtHead(atHead, false)).toBe(true) })
    expect(midTurnHead(result.current, controls, order)).toBe(false)
    expect(headIndex(result.current, order)).toBe(controls[0])
  })
})
