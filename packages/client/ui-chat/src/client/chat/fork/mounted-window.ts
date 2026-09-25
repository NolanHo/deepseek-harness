// Fork-owned mounted transcript window (see FORK_SURFACE.md): ChatView mounts a
// bounded slice of the resident order and reveals older rows in steps, so the
// per-frame DOM work stops growing with the conversation.

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RenderEntry } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Root rows one mounted window holds. */
export const MOUNTED_ROW_LIMIT = 50

/** Resident rows one reveal gesture adds above the window. */
export const REVEAL_ROW_STEP = 25

/**
 * Window identity. `tail` follows the newest resident rows; `frozen` pins the
 * window to a row key, which survives a prepend that shifts every index.
 */
export type MountWindow = { readonly kind: 'tail' } | { readonly kind: 'frozen'; readonly head: string }

/** One planned window: the entries to mount and the rows they may render. */
export interface MountedWindowPlan {
  /** Root entries to mount, in transcript order. */
  readonly entries: readonly RenderEntry[]
  /** Order keys the mounted entries may render; a group mounts only these members. */
  readonly keys: ReadonlySet<string>
  /** Order key at the window head, or null for an empty order. */
  readonly headKey: string | null
  /** Whether the window reaches the newest resident row. */
  readonly atTail: boolean
  /** Whether older resident rows remain above the window head. */
  readonly canReveal: boolean
  /** Plan identity that moves with the head and the mounted key count. */
  readonly signature: string
}

/** Inputs the mounted window reacts to. */
export interface MountedWindowInput {
  /** Root rendering entries over the whole loaded window. */
  readonly entries: readonly RenderEntry[]
  /** Resident Node keys in transcript order. */
  readonly order: readonly string[]
  /** Whether the reader owns the live tail, so no saved row holds the window back. */
  readonly followingTail: boolean
  /** Reader row key from the session's scroll memory, null while at the tail. */
  readonly anchorKey: string | null
  /** Whether a Turn is streaming, so the resident tail stays mounted while frozen. */
  readonly running: boolean
}

/** The mounted window, its facts, and the transitions the view drives. */
export interface MountedWindowState extends MountedWindowPlan {
  /** Whether the mounted entries reach the resident tail entry. */
  readonly tailMounted: boolean
  /**
   * Bring a resident row into the window so a jump can land on it.
   * @param key - order key or rendered anchor key of the target row.
   * @returns whether the window moved; false when the row is mounted already.
   */
  readonly hold: (key: string | null) => boolean
  /**
   * Reveal one step of older resident rows.
   * @returns whether the head moved; false at the oldest row the reader can reveal.
   */
  readonly reveal: () => boolean
  /** Release the frozen window back to the live tail. */
  readonly release: () => void
}

/** Index of the oldest row the live tail mounts. */
function tailHead(order: readonly string[]): number {
  return Math.max(0, order.length - MOUNTED_ROW_LIMIT)
}

/** Head index of a window; a head key that left the order falls back to the tail. */
function headIndexOf(window: MountWindow, order: readonly string[]): number {
  if (window.kind === 'tail') return tailHead(order)
  const index = order.indexOf(window.head)
  return index < 0 ? tailHead(order) : index
}

/**
 * Window starting at one index, as the live tail when that start reaches the end.
 * @param order - resident Node keys in transcript order.
 * @param head - requested head index.
 * @returns the normalized window identity.
 */
function windowAt(order: readonly string[], head: number): MountWindow {
  const start = Math.max(0, Math.min(head, tailHead(order)))
  // A start below the tail head is inside the order, so that row key exists.
  return start >= tailHead(order) ? { kind: 'tail' } : { kind: 'frozen', head: order[start] as string }
}

/**
 * Clamp a head so the row at `rowIndex` stays inside the window. A head above
 * that row trims the reader's held row, and `fork/scroll-anchor.ts` then finds
 * no anchor row, so the reflow hold and the saved position are dropped.
 * @param head - requested head index.
 * @param rowIndex - reader row index, or -1 when the reader owns no row.
 * @returns the head index to plan with.
 */
function headKeepingRow(head: number, rowIndex: number): number {
  if (rowIndex < 0) return head
  return Math.max(Math.min(head, rowIndex), rowIndex - MOUNTED_ROW_LIMIT + 1, 0)
}

/** Node key of a group-member part anchor (`["<key>","<part>"]`), else null. */
function memberNodeKey(anchorKey: string): string | null {
  if (!anchorKey.startsWith('["')) return null
  try {
    // Only a member-part pair opens with a quoted first element, so a key that
    // parses here is that pair and its first element is the Node key.
    return (JSON.parse(anchorKey) as [string, ...unknown[]])[0]
  } catch {
    // A key that opens like the pair but does not parse names no Node.
    return null
  }
}

/**
 * Resolve a rendered anchor key to its resident order index. A group member's
 * part anchor is the JSON pair `ChatNodeSeat` renders, so its Node key is the row.
 * @param order - resident Node keys in transcript order.
 * @param key - rendered `data-chat-anchor-key`; null when the reader owns none.
 * @returns its index in `order`, or -1 when no resident row carries it.
 */
export function orderIndexOfAnchor(order: readonly string[], key: string | null): number {
  if (key === null) return -1
  const direct = order.indexOf(key)
  if (direct >= 0) return direct
  const node = memberNodeKey(key)
  return node === null ? -1 : order.indexOf(node)
}

/**
 * Plan the mounted slice of the resident order. The window is
 * `MOUNTED_ROW_LIMIT` resident keys from its head, and an entry is mounted when
 * any key it renders is inside that slice: a `group` entry renders its members
 * as rows of its own, so the bound counts keys, not entries. `stub` also holds
 * the newest slice, which keeps a live Turn's rows and the opening echo spliced
 * while the reader is frozen above them.
 * @param entries - root rendering entries over the whole loaded window.
 * @param order - resident Node keys in transcript order.
 * @param window - requested window identity.
 * @param stub - whether the resident tail slice stays mounted beside the window.
 * @returns the mounted entries, the keys they may render, and the window's facts.
 */
export function planMountedWindow(
  entries: readonly RenderEntry[],
  order: readonly string[],
  window: MountWindow,
  stub: boolean,
): MountedWindowPlan {
  const head = headIndexOf(window, order)
  const windowKeys = new Set(order.slice(head, head + MOUNTED_ROW_LIMIT))
  const keys = stub ? new Set([...windowKeys, ...order.slice(tailHead(order))]) : windowKeys
  const mounted: RenderEntry[] = []
  // One owner walk: every order key belongs to the entry that renders it, and a
  // group owns the member run it heads. Interior members have no entry of their
  // own, which is why an entries-only cap cannot bound the DOM.
  let cursor = 0
  for (let index = 0; index < entries.length;) {
    const entry = entries[index] as RenderEntry
    if (entry.kind === 'node') {
      if (keys.has(entry.key)) mounted.push(entry)
      if (order[cursor] === entry.key) cursor += 1
      index += 1
      continue
    }
    // A group heads the member run up to the next root entry's key, inclusive:
    // an assistant step carrying both reasoning and a reply renders as a group
    // member and as its own root entry. Consecutive groups share one run whose
    // internal boundaries no entry names, so that block mounts whole while any
    // of its keys is; a group with no mounted member renders nothing.
    let next = index + 1
    while (next < entries.length && (entries[next] as RenderEntry).kind === 'group') next++
    const following = entries[next]
    const found = following === undefined ? -1 : order.indexOf(following.key, cursor)
    const end = following === undefined ? order.length : found < 0 ? cursor : found + 1
    for (let at = cursor; at < end; at++) {
      if (!keys.has(order[at] as string)) continue
      for (; index < next; index++) mounted.push(entries[index] as RenderEntry)
      break
    }
    cursor = end
    index = next
  }
  const headKey = order[head] ?? null
  return {
    entries: mounted,
    keys,
    headKey,
    atTail: head + MOUNTED_ROW_LIMIT >= order.length,
    canReveal: head > 0,
    signature: `${headKey ?? ''}:${windowKeys.size}`,
  }
}

/**
 * Own the mounted transcript window for one Chat view. The window is view-local
 * state: it creates no service, store, or published value.
 * @param input - resident entries, order, reading policy, and session liveness.
 * @returns the mounted slice and the transitions the view drives.
 */
export function useMountedWindow(input: MountedWindowInput): MountedWindowState {
  const { entries, order, followingTail, anchorKey, running } = input
  const [state, setState] = useState<MountWindow>({ kind: 'tail' })
  const orderRef = useRef(order)
  orderRef.current = order
  const readerRow = useMemo(() => orderIndexOfAnchor(order, anchorKey), [order, anchorKey])

  // Opening a session off the floor: adopt the saved reader row while rendering,
  // so this commit already mounts the row the reading policy restores onto.
  const adopted = useRef(false)
  let window = state
  if (!adopted.current && order.length > 0) {
    adopted.current = true
    if (!followingTail && readerRow >= 0) {
      const next = windowAt(order, headKeepingRow(readerRow - REVEAL_ROW_STEP, readerRow))
      if (next.kind === 'frozen') {
        setState(next)
        window = next
      }
    }
  }
  const windowRef = useRef(window)
  windowRef.current = window

  const hold = useCallback((key: string | null): boolean => {
    const current = orderRef.current
    const index = orderIndexOfAnchor(current, key)
    if (index < 0) return false
    const head = headIndexOf(windowRef.current, current)
    if (index >= head && index < head + MOUNTED_ROW_LIMIT) return false
    setState(windowAt(current, headKeepingRow(index - REVEAL_ROW_STEP, index)))
    return true
  }, [])

  const reveal = useCallback((): boolean => {
    const current = orderRef.current
    const head = headIndexOf(windowRef.current, current)
    if (head <= 0) return false
    const next = windowAt(current, headKeepingRow(head - REVEAL_ROW_STEP, readerRow))
    if (headIndexOf(next, current) >= head) return false
    setState(next)
    return true
  }, [readerRow])

  const release = useCallback((): void => { setState({ kind: 'tail' }) }, [])

  // The reader owns the live tail again: own input, Back to bottom, or arrival at
  // the mounted floor, which is not the transcript floor while rows remain below.
  useLayoutEffect(() => {
    if (followingTail && windowRef.current.kind !== 'tail') setState({ kind: 'tail' })
  }, [followingTail])

  // The reader's saved row sits below the tail window: a session opened off the
  // floor after its order arrived, or a prepend that grew the order under it.
  useLayoutEffect(() => {
    if (followingTail || windowRef.current.kind !== 'tail' || readerRow < 0) return
    const next = windowAt(order, headKeepingRow(readerRow - REVEAL_ROW_STEP, readerRow))
    if (next.kind === 'frozen') setState(next)
  }, [followingTail, order, readerRow])

  const plan = useMemo(
    () => planMountedWindow(entries, order, window, running && window.kind === 'frozen'),
    [entries, order, window, running],
  )
  const tailEntry = entries.at(-1)
  return {
    ...plan,
    tailMounted: tailEntry === undefined || plan.entries.at(-1) === tailEntry,
    hold,
    reveal,
    release,
  }
}
