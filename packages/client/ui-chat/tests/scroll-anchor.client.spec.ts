// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { anchorOrNearestVisible, restoreAnchorOnReflow, type ReflowAnchor } from '../src/client/chat/fork/scroll-anchor.ts'

function makeRow(key: string, hidden = false): HTMLElement {
  const row = document.createElement('div')
  row.dataset.chatAnchorKey = key
  if (hidden) row.hidden = true
  return row
}

/** Stub flowTop geometry: row top = base + index * 40. */
function geometry(rows: HTMLElement[], base = 0): void {
  rows.forEach((row, index) => {
    row.getBoundingClientRect = () => ({
      top: base + index * 40, bottom: base + index * 40 + 24, left: 0, right: 100,
      width: 100, height: 24, x: 0, y: base + index * 40, toJSON: () => ({}),
    }) as DOMRect
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
    const a = makeRow('a'); const b = makeRow('b'); const c = makeRow('c')
    list.append(a, b, c)
    // At capture the rows sit at absolute tops 100/140/180: b's flow top is 40.
    scrollport.getBoundingClientRect = () => (
      { top: 100, bottom: 400, left: 0, right: 100, width: 100, height: 300, x: 0, y: 100, toJSON: () => ({}) }
    ) as DOMRect
    geometry([a, b, c], 100)
    const anchor: ReflowAnchor = { key: 'b', top: 40 }
    // Row a collapses to height 0: every row moves up 40, so b's flow top is 0.
    geometry([a, b, c], 60)
    const anchorRef = { current: anchor }
    const ledger = { current: 100 }
    scrollport.scrollTop = 100
    const next = restoreAnchorOnReflow(list, scrollport, anchor, anchorRef, ledger)
    // b moved up 40 in flow coordinates, so the scrollport compensates by scrolling up 40.
    expect(scrollport.scrollTop).toBe(60)
    expect(ledger.current).toBe(60)
    expect(anchorRef.current).toEqual({ key: 'b', top: 0 })
    expect(next).toEqual({ key: 'b', top: 0 })
  })

  it('falls back to the row above when the anchor itself folds away', () => {
    const scrollport = document.createElement('div')
    const list = document.createElement('div')
    scrollport.append(list)
    const a = makeRow('a'); const b = makeRow('b', true); const c = makeRow('c')
    list.append(a, b, c)
    scrollport.getBoundingClientRect = () => (
      { top: 0, bottom: 300, left: 0, right: 100, width: 100, height: 300, x: 0, y: 0, toJSON: () => ({}) }
    ) as DOMRect
    geometry([a, b, c])
    const anchor: ReflowAnchor = { key: 'b', top: 40 }
    const anchorRef = { current: anchor }
    const ledger = { current: 0 }
    const next = restoreAnchorOnReflow(list, scrollport, anchor, anchorRef, ledger)
    expect(anchorRef.current).toEqual({ key: 'a', top: 0 })
    expect(next).toEqual({ key: 'a', top: 0 })
  })

  it('writes nothing when the anchor row has not moved', () => {
    const scrollport = document.createElement('div')
    const list = document.createElement('div')
    scrollport.append(list)
    const a = makeRow('a'); const b = makeRow('b')
    list.append(a, b)
    scrollport.getBoundingClientRect = () => (
      { top: 0, bottom: 300, left: 0, right: 100, width: 100, height: 300, x: 0, y: 0, toJSON: () => ({}) }
    ) as DOMRect
    geometry([a, b])
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
