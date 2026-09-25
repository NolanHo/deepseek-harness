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

/** Last resolved frozen head; an append leaves a resident index in place. */
const frozenHead: { key: string; index: number } = { key: '', index: -1 }

/** Head index of a window; a head key that left the order falls back to the tail. */
function headIndexOf(window: MountWindow, order: readonly string[]): number {
  if (window.kind === 'tail') return tailHead(order)
  if (frozenHead.key === window.head && order[frozenHead.index] === window.head) return frozenHead.index
  const index = order.indexOf(window.head)
  if (index < 0) return tailHead(order)
  frozenHead.key = window.head
  frozenHead.index = index
  return index
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
 * Clamp a head so the row at `rowIndex` stays inside the window.
 *
 * Starting the window at that row's owning entry root is not equivalent: a root
 * key can sit above the reader by a whole group run, which mounts rows the bound
 * does not count. Callers hold the head back only for a row this module resolved;
 * a saved anchor with no resident index leaves the head unclamped, so the window
 * keeps the start it was given and the restore path must keep the saved position
 * instead of adopting the mounted floor.
 * @param head - requested head index.
 * @param rowIndex - resident index of the reader row to keep mounted.
 * @returns the head index to plan with.
 */
function headKeepingRow(head: number, rowIndex: number): number {
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
 * Resident index a `group:`-prefixed anchor names. `process-groups.ts` builds the
 * group key as `["process", <first member key>, <group part>]`, so the block's
 * first resident member is the row the anchor sits on; a group key whose members
 * all left the order names none.
 * @param order - resident Node keys in transcript order.
 * @param anchorKey - a rendered `group:<groupKey>` anchor.
 * @returns its index in `order`, or -1 when no embedded key is resident.
 */
function groupAnchorIndex(order: readonly string[], anchorKey: string): number {
  try {
    const parts = JSON.parse(anchorKey.slice('group:'.length)) as readonly unknown[]
    // The literal tag precedes every key, so the first resident element is a member.
    for (let at = 1; at < parts.length; at++) {
      const part = parts[at]
      if (typeof part !== 'string') continue
      const index = order.indexOf(part)
      if (index >= 0) return index
    }
    return -1
  } catch {
    // A grouped anchor that does not parse names no resident row.
    return -1
  }
}

/**
 * Resolve a rendered anchor key to its resident order index. A group member's
 * part anchor is the JSON pair `ChatNodeSeat` renders, and a group's own anchor
 * embeds its first member key, so both name the resident row they sit on.
 * @param order - resident Node keys in transcript order.
 * @param key - rendered `data-chat-anchor-key`; null when the reader owns none.
 * @returns its index in `order`, or -1 when no resident row carries it.
 */
export function orderIndexOfAnchor(order: readonly string[], key: string | null): number {
  if (key === null) return -1
  const direct = order.indexOf(key)
  if (direct >= 0) return direct
  if (key.startsWith('group:')) return groupAnchorIndex(order, key)
  const node = memberNodeKey(key)
  return node === null ? -1 : order.indexOf(node)
}

/** Entry indices rendering each resident key; a repeated key keeps every entry. */
const keyedEntries = new WeakMap<readonly RenderEntry[], ReadonlyMap<string, readonly number[]>>()

/**
 * Index the Node entries by the key they render, once per `entries` identity. A
 * Node entry mounts on its own key alone, so this resolves most of a window
 * without pairing the entries against the whole resident order.
 * @param entries - root rendering entries over the whole loaded window.
 * @returns the entry indices rendering each Node key.
 */
function entriesByKey(entries: readonly RenderEntry[]): ReadonlyMap<string, readonly number[]> {
  let index = keyedEntries.get(entries)
  if (index === undefined) {
    const keys = new Map<string, number[]>()
    for (let at = 0; at < entries.length; at++) {
      const entry = entries[at] as RenderEntry
      if (entry.kind !== 'node') continue
      const found = keys.get(entry.key)
      if (found === undefined) keys.set(entry.key, [at])
      else found.push(at)
    }
    index = keys
    keyedEntries.set(entries, index)
  }
  return index
}

/**
 * Pair every entry with the resident order and collect the mounted ones. One
 * owner walk: every order key belongs to the entry that renders it, and a group
 * owns the member run it heads. Interior members have no entry of their own,
 * which is why an entries-only cap cannot bound the DOM. The walk visits the
 * whole resident history, so callers use it only where a window cannot bound
 * the range it needs.
 * @param entries - root rendering entries over the whole loaded window.
 * @param order - resident Node keys in transcript order.
 * @param keys - order keys the mounted entries may render.
 * @returns mounted entry indices in transcript order.
 */
function walkMounted(
  entries: readonly RenderEntry[], order: readonly string[], keys: ReadonlySet<string>,
): number[] {
  const mounted: number[] = []
  let cursor = 0
  for (let index = 0; index < entries.length;) {
    const entry = entries[index] as RenderEntry
    if (entry.kind === 'node') {
      if (keys.has(entry.key)) mounted.push(index)
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
      for (; index < next; index++) mounted.push(index)
      break
    }
    cursor = end
    index = next
  }
  return mounted
}

/**
 * Collect the group blocks whose member run reaches into a resident suffix,
 * walking the entries and the order backwards from the tail so the work stops
 * at `from`. The suffix is at most one window long, so both the entries visited
 * and the keys scanned stay bounded however long the resident history is.
 * @param entries - root rendering entries over the whole loaded window.
 * @param order - resident Node keys in transcript order.
 * @param from - first resident index of the suffix.
 * @returns mounted entry indices, or null when the walk cannot bound the range.
 */
function tailBlocks(
  entries: readonly RenderEntry[], order: readonly string[], from: number,
): number[] | null {
  const mounted: number[] = []
  let cursor = order.length
  let index = entries.length
  while (index > 0 && cursor > from) {
    index -= 1
    const entry = entries[index] as RenderEntry
    if (entry.kind === 'node') {
      // A root entry a group run ends on consumed nothing: the run took its key.
      const inRun = index > 0 && (entries[index - 1] as RenderEntry).kind === 'group'
      if (!inRun && order[cursor - 1] === entry.key) cursor -= 1
      continue
    }
    let first = index
    while (first > 0 && (entries[first - 1] as RenderEntry).kind === 'group') first -= 1
    const following = entries[index + 1]
    // A member run ends on the following root entry's key; a run ending anywhere
    // else means the walk lost the pairing, and the caller re-pairs from the head.
    if (following !== undefined && order[cursor - 1] !== following.key) return null
    const previous = first > 0 ? entries[first - 1] as RenderEntry : undefined
    // The run holds every key above the previous root entry's key, so it reaches
    // into the suffix unless that key still sits inside the suffix.
    let start = from
    if (previous !== undefined && previous.kind === 'node') {
      for (let at = cursor - 1; at >= from; at--) {
        if (order[at] !== previous.key) continue
        start = at + 1
        break
      }
    }
    // An empty run renders no row, so the block mounts nothing either way.
    if (start < cursor) for (let at = first; at <= index; at++) mounted.push(at)
    cursor = start
    index = first
  }
  return cursor === from ? mounted : null
}

/** Frozen window resolution: the resident key slice and the entries it mounts. */
interface FrozenResolution {
  readonly slice: readonly string[]
  readonly mounted: readonly number[]
}

/** Frozen window resolutions, keyed by the entries identity and the head key. */
const frozenWindows = new WeakMap<readonly RenderEntry[], Map<string, FrozenResolution>>()

/** Whether a cached slice still matches the resident order at `head`. */
function sameSlice(slice: readonly string[], order: readonly string[], head: number): boolean {
  for (let at = 0; at < slice.length; at++) if (slice[at] !== order[head + at]) return false
  return true
}

/**
 * Resolve a frozen window's mounted entries, reusing the last resolution while
 * the resident keys it was paired against keep their identities: a resident
 * append leaves that slice untouched, so the pairing walk runs once per window.
 * @param entries - root rendering entries over the whole loaded window.
 * @param order - resident Node keys in transcript order.
 * @param headKey - resident key the frozen window starts on.
 * @param head - its resident index.
 * @param keys - order keys the window may render.
 * @returns mounted entry indices.
 */
function frozenMounted(
  entries: readonly RenderEntry[], order: readonly string[], headKey: string, head: number,
  keys: ReadonlySet<string>,
): readonly number[] {
  let resolutions = frozenWindows.get(entries)
  if (resolutions === undefined) {
    resolutions = new Map()
    frozenWindows.set(entries, resolutions)
  }
  const cached = resolutions.get(headKey)
  const count = Math.min(MOUNTED_ROW_LIMIT, order.length - head)
  if (cached !== undefined && cached.slice.length === count && sameSlice(cached.slice, order, head)) {
    return cached.mounted
  }
  const mounted = walkMounted(entries, order, keys)
  resolutions.set(headKey, { slice: order.slice(head, head + MOUNTED_ROW_LIMIT), mounted })
  return mounted
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
  const windowKeys = order.slice(head, head + MOUNTED_ROW_LIMIT)
  const tailKeys = stub ? order.slice(tailHead(order)) : []
  const keys = new Set(stub ? [...windowKeys, ...tailKeys] : windowKeys)
  const mounted = new Set<number>()
  for (const key of keys) for (const at of entriesByKey(entries).get(key) ?? []) mounted.add(at)
  if (window.kind === 'tail') {
    const blocks = tailBlocks(entries, order, head)
    if (blocks === null) for (const at of walkMounted(entries, order, keys)) mounted.add(at)
    else for (const at of blocks) mounted.add(at)
  } else {
    for (const at of frozenMounted(entries, order, window.head, head, new Set(windowKeys))) mounted.add(at)
    if (stub) {
      const blocks = tailBlocks(entries, order, tailHead(order))
      if (blocks === null) for (const at of walkMounted(entries, order, keys)) mounted.add(at)
      else for (const at of blocks) mounted.add(at)
    }
  }
  const headKey = order[head] ?? null
  return {
    entries: [...mounted].sort((left, right) => left - right).map(at => entries[at] as RenderEntry),
    keys,
    headKey,
    atTail: head + MOUNTED_ROW_LIMIT >= order.length,
    canReveal: head > 0,
    signature: `${headKey ?? ''}:${windowKeys.length}`,
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
  const [requested, setRequested] = useState<MountWindow>({ kind: 'tail' })
  const orderRef = useRef(order)
  const windowRef = useRef<MountWindow>(requested)
  const readerRow = useMemo(() => orderIndexOfAnchor(order, anchorKey), [order, anchorKey])

  // Opening a session off the floor: the saved reader row sits outside the tail
  // window, so the window in effect is derived from that row while the reader
  // owns no window of their own. Deriving it instead of storing it keeps the
  // adoption idempotent, where a render-phase setState would be discarded and
  // replayed by a repeated render.
  const window = useMemo((): MountWindow => {
    if (requested.kind !== 'tail' || followingTail || readerRow < 0) return requested
    return windowAt(order, headKeepingRow(readerRow - REVEAL_ROW_STEP, readerRow))
  }, [followingTail, order, readerRow, requested])
  useLayoutEffect(() => {
    orderRef.current = order
    windowRef.current = window
  })

  const hold = useCallback((key: string | null): boolean => {
    const current = orderRef.current
    const index = orderIndexOfAnchor(current, key)
    if (index < 0) return false
    const head = headIndexOf(windowRef.current, current)
    if (index >= head && index < head + MOUNTED_ROW_LIMIT) return false
    setRequested(windowAt(current, headKeepingRow(index - REVEAL_ROW_STEP, index)))
    return true
  }, [])

  const reveal = useCallback((): boolean => {
    // A reveal grows the window upward and keeps the reader's own row mounted;
    // with no reader row the head would move while the reader's rows unmount, so
    // the caller pages resident history in instead.
    if (readerRow < 0) return false
    const current = orderRef.current
    const head = headIndexOf(windowRef.current, current)
    if (head <= 0) return false
    const next = windowAt(current, headKeepingRow(head - REVEAL_ROW_STEP, readerRow))
    if (headIndexOf(next, current) >= head) return false
    setRequested(next)
    return true
  }, [readerRow])

  const release = useCallback((): void => { setRequested({ kind: 'tail' }) }, [])

  // The reader owns the live tail again: own input, Back to bottom, or arrival at
  // the mounted floor, which is not the transcript floor while rows remain below.
  // Only tail ownership releases the window: a window a jump moved is what the
  // landing below it is aligned against, so releasing on the window kind alone
  // would unmount that row mid-jump.
  useLayoutEffect(() => {
    if (followingTail && windowRef.current.kind !== 'tail') setRequested({ kind: 'tail' })
  }, [followingTail])

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
