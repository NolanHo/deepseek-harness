// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { anchorOrNearestVisible, restoreAnchorOnReflow, type ReflowAnchor } from '../src/client/chat/fork/scroll-anchor.ts'

function makeRow(key: string, hidden = false): HTMLElement {
  const row = document.createElement('div')
  row.dataset.chatAnchorKey = key
  if (hidden) row.hidden = true
  return row
}

/** Clamp scrollTop at zero the way browsers do. */
function clampScrollTop(element: HTMLElement): void {
  let top = 0
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => { top = Math.max(0, value) },
  })
}

/**
 * Stub scroll-coupled geometry: row top = base + index * 40 - scrollTop,
 * matching a real scrollport whose content moves with the scroll.
 */
function geometry(scrollport: HTMLElement, rows: HTMLElement[], base = 0): void {
  rows.forEach((row, index) => {
    row.getBoundingClientRect = () => ({
      top: base + index * 40 - scrollport.scrollTop, bottom: base + index * 40 - scrollport.scrollTop + 24,
      left: 0, right: 100, width: 100, height: 24, x: 0, y: base + index * 40 - scrollport.scrollTop,
      toJSON: () => ({}),
    })
  })
}

describe('anchorOrNearestVisible', () => {
  it('returns the anchor row itself while visible', () => {
    const list = document.createElement('div')
    const a = makeRow('a'); const b = makeRow('b'); const c = makeRow('c')
    list.append(a, b, c)
    expect(anchorOrNearestVisible(list, 'b')).toBe(b)
  })

  it('falls back to the nearest surviving visible row above a hidden anchor', () => {
    const list = document.createElement('div')
    const a = makeRow('a'); const b = makeRow('b', true); const c = makeRow('c')
    list.append(a, b, c)
    expect(anchorOrNearestVisible(list, 'b')).toBe(a)
  })

  it('returns null when nothing anchors anymore', () => {
    const list = document.createElement('div')
    const a = makeRow('a', true)
    list.append(a)
    expect(anchorOrNearestVisible(list, 'a')).toBeNull()
    expect(anchorOrNearestVisible(list, 'missing')).toBeNull()
  })
})

describe('restoreAnchorOnReflow', () => {
  it('keeps the reader row put when content above collapses', () => {
    const scrollport = document.createElement('div')
    const list = document.createElement('div')
    scrollport.append(list)
    clampScrollTop(scrollport)
    const a = makeRow('a'); const b = makeRow('b'); const c = makeRow('c')
    list.append(a, b, c)
    scrollport.getBoundingClientRect = () => (
      { top: 0, bottom: 300, left: 0, right: 100, width: 100, height: 300, x: 0, y: 0, toJSON: () => ({}) }
    )
    // At capture (scrollTop 100) the rows sit at flow tops -100/-60/-20: b's is -60.
    geometry(scrollport, [a, b, c], 0)
    scrollport.scrollTop = 100
    const anchor: ReflowAnchor = { key: 'b', top: -60 }
    // Row a collapses to height 0: every row moves up 40, so b's flow top is -100.
    geometry(scrollport, [a, b, c], -40)
    const anchorRef = { current: anchor }
    const ledger = { current: 100 }
    const next = restoreAnchorOnReflow(list, scrollport, anchor, anchorRef, ledger)
    // b moved up 40 in flow coordinates, so the scrollport compensates by scrolling up 40.
    expect(scrollport.scrollTop).toBe(60)
    expect(ledger.current).toBe(60)
    // The re-captured hold is measured after the write: the row is back at -60.
    expect(anchorRef.current).toEqual({ key: 'b', top: -60 })
    expect(next).toEqual({ key: 'b', top: -60 })
  })

  it('is idempotent across consecutive callbacks with unchanged geometry', () => {
    const scrollport = document.createElement('div')
    const list = document.createElement('div')
    scrollport.append(list)
    clampScrollTop(scrollport)
    const a = makeRow('a'); const b = makeRow('b')
    list.append(a, b)
    scrollport.getBoundingClientRect = () => (
      { top: 0, bottom: 300, left: 0, right: 100, width: 100, height: 300, x: 0, y: 0, toJSON: () => ({}) }
    )
    geometry(scrollport, [a, b], 0)
    scrollport.scrollTop = 100
    const anchor: ReflowAnchor = { key: 'b', top: -60 }
    geometry(scrollport, [a, b], -40)
    const anchorRef = { current: anchor }
    const ledger = { current: 100 }
    restoreAnchorOnReflow(list, scrollport, anchor, anchorRef, ledger)
    expect(scrollport.scrollTop).toBe(60)
    // A second callback for the same reflow must not undo the first write:
    // the post-write hold makes the pre-write delta zero.
    const again = restoreAnchorOnReflow(list, scrollport, anchorRef.current, anchorRef, ledger)
    expect(scrollport.scrollTop).toBe(60)
    expect(ledger.current).toBe(60)
    expect(anchorRef.current).toEqual({ key: 'b', top: -60 })
    expect(again).toEqual({ key: 'b', top: -60 })
  })

  it('falls back to the row above when the anchor itself folds away', () => {
    const scrollport = document.createElement('div')
    const list = document.createElement('div')
    scrollport.append(list)
    clampScrollTop(scrollport)
    const a = makeRow('a'); const b = makeRow('b', true); const c = makeRow('c')
    list.append(a, b, c)
    scrollport.getBoundingClientRect = () => (
      { top: 0, bottom: 300, left: 0, right: 100, width: 100, height: 300, x: 0, y: 0, toJSON: () => ({}) }
    )
    geometry(scrollport, [a, b, c], 0)
    const anchor: ReflowAnchor = { key: 'b', top: 40 }
    const anchorRef = { current: anchor }
    const ledger = { current: 0 }
    const next = restoreAnchorOnReflow(list, scrollport, anchor, anchorRef, ledger)
    // The clamped write lands at 0, so the surviving row's post-write top is 0.
    expect(scrollport.scrollTop).toBe(0)
    expect(ledger.current).toBe(0)
    expect(anchorRef.current).toEqual({ key: 'a', top: 0 })
    expect(next).toEqual({ key: 'a', top: 0 })
  })

  it('writes nothing when the anchor row has not moved', () => {
    const scrollport = document.createElement('div')
    const list = document.createElement('div')
    scrollport.append(list)
    clampScrollTop(scrollport)
    const a = makeRow('a'); const b = makeRow('b')
    list.append(a, b)
    scrollport.getBoundingClientRect = () => (
      { top: 0, bottom: 300, left: 0, right: 100, width: 100, height: 300, x: 0, y: 0, toJSON: () => ({}) }
    )
    geometry(scrollport, [a, b], 0)
    const anchor: ReflowAnchor = { key: 'a', top: 0 }
    const anchorRef = { current: anchor }
    const ledger = { current: 0 }
    restoreAnchorOnReflow(list, scrollport, anchor, anchorRef, ledger)
    expect(scrollport.scrollTop).toBe(0)
    expect(ledger.current).toBe(0)
    expect(anchorRef.current).toEqual({ key: 'a', top: 0 })
  })

  it('clears the hold when no row survives', () => {
    const scrollport = document.createElement('div')
    const list = document.createElement('div')
    scrollport.append(list)
    const anchor: ReflowAnchor = { key: 'gone', top: 0 }
    const anchorRef = { current: anchor }
    const ledger = { current: 0 }
    const next = restoreAnchorOnReflow(list, scrollport, anchor, anchorRef, ledger)
    expect(next).toBeNull()
    expect(anchorRef.current).toBeNull()
  })
})
