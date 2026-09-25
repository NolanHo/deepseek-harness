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
  /**
   * Resident indices of the Turn-process control keys, ascending. A completed
   * Turn's rows fold behind its control, so a window that mounts those rows
   * must mount the control with them; the control also starts the Turn's run of
   * rows, which is the boundary a reveal or an opening head aligns to.
   */
  readonly controls: readonly number[]
  /** Whether the reader owns the live tail, so no saved row holds the window back. */
  readonly followingTail: boolean
  /** Reader row key from the session's scroll memory, null while at the tail. */
  readonly anchorKey: string | null
  /** Whether a Turn is streaming, so the resident tail stays mounted while frozen. */
  readonly running: boolean
}

/**
 * One reader scroll observation, as the head reveal reads it. The viewport's
 * scroll event satisfies this: the geometry says how close the reader is to the
 * mounted head and the attribution flag keeps programmatic writes out.
 */
export interface HeadScroll {
  /** Current scroll offset of the transcript scrollport. */
  readonly top: number
  /** Visible height of that scrollport. */
  readonly height: number
  /** Whether the reader's own input produced this scroll. */
  readonly movedByReader: boolean
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
   * Reveal one step of older resident rows, landing on the Turn start that owns
   * the step while the reader's own row stays inside the window.
   * @returns whether the head moved; false at the oldest row the reader can
   *   reveal, and when the landing would unmount the reader's own row.
   */
  readonly reveal: () => boolean
  /**
   * Whether a reveal gesture would still move the window head. The reader's own
   * row clamps the head, so a reader who owns no row, a head the reader row
   * already holds back, or a Turn-aligned landing that would drop that row makes
   * the gesture a no-op.
   */
  readonly revealable: boolean
  /**
   * Whether a reader scroll would step the head. The view asks this before it
   * settles the pending reading sample, because the settle costs a layout read
   * and only the head step needs it.
   * @param scroll - reader scroll geometry and attribution from the viewport.
   * @param historyBusy - whether history work (a retained paging anchor or a page request) owns the layout.
   * @returns whether `revealAtHead` would move the head for this scroll.
   */
  readonly willRevealAtHead: (scroll: HeadScroll, historyBusy: boolean) => boolean
  /**
   * Reveal one step for a reader scroll that came within one viewport of the
   * mounted head, so a wheel or touch gesture alone keeps older resident rows
   * coming instead of stopping at the window edge. Called from the viewport's
   * scroll event: a programmatic write, a jump, a page request, the live tail,
   * a reader who owns no row, and a Turn-aligned landing that cannot keep the
   * row it steps for never reveal, and the interval throttle bounds how fast one
   * fling can grow the window.
   * @param scroll - reader scroll geometry and attribution from the viewport.
   * @param historyBusy - whether history work (a retained paging anchor or a page request) owns the layout.
   * @returns whether the head moved; false leaves the window where it was.
   */
  readonly revealAtHead: (scroll: HeadScroll, historyBusy: boolean) => boolean
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

/**
 * Frozen window pinned to one resident head row. A reveal step and the derived
 * opening window pin the Turn-aligned head they chose: `windowAt`'s tail
 * normalization would clamp a head inside the newest resident rows back to
 * `tailHead`, which is no Turn boundary, and a step that lands on the tail
 * window is derived again from the reader's row, taking the step back.
 * @param order - resident Node keys in transcript order.
 * @param head - resident head index the window starts on.
 * @returns the frozen window identity.
 */
function frozenAt(order: readonly string[], head: number): MountWindow {
  return { kind: 'frozen', head: order[head] as string }
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
 * group key as `["process", <first member key>, <group part | null>]`, so the
 * member key follows the literal tag and the block's first resident member is the
 * row the anchor sits on; a member key that left the order names none. The group
 * part after it is a part name (`reasoning`, `response`), never a Node key.
 * @param order - resident Node keys in transcript order.
 * @param anchorKey - a rendered `group:<groupKey>` anchor.
 * @returns its index in `order`, or -1 when the embedded member key is not resident.
 */
function groupAnchorIndex(order: readonly string[], anchorKey: string): number {
  try {
    const parts = JSON.parse(anchorKey.slice('group:'.length)) as readonly unknown[]
    const member = parts[1]
    return typeof member === 'string' ? order.indexOf(member) : -1
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

/** One owner walk: the mounted entries and how far the pairing reached. */
interface OwnerWalk {
  /** Mounted entry indices in transcript order. */
  readonly mounted: readonly number[]
  /** Whether every member run ended on a resident root key. */
  readonly closed: boolean
  /** Whether the walk paired the whole resident order. */
  readonly covered: boolean
}

/**
 * Pair every entry with the resident order and collect the mounted ones. One
 * owner walk: every order key belongs to the entry that renders it, and a group
 * owns the member run it heads. Interior members have no entry of their own,
 * which is why an entries-only cap cannot bound the DOM. The walk visits the
 * whole resident history, so callers use it only where a window cannot bound
 * the range it needs.
 *
 * The walk also reports whether it closed every run and paired every resident
 * row. A run whose following root key is not resident ends where it starts, so a
 * key that becomes resident later moves that run without moving the window; a
 * walk that stopped short of the order left rows the pairing never reached.
 * @param entries - root rendering entries over the whole loaded window.
 * @param order - resident Node keys in transcript order.
 * @param keys - order keys the mounted entries may render.
 * @returns the mounted entry indices and the reach of the pairing.
 */
function walkMounted(
  entries: readonly RenderEntry[], order: readonly string[], keys: ReadonlySet<string>,
): OwnerWalk {
  const mounted: number[] = []
  let cursor = 0
  let closed = true
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
    if (following !== undefined && found < 0) closed = false
    const end = following === undefined ? order.length : found < 0 ? cursor : found + 1
    for (let at = cursor; at < end; at++) {
      if (!keys.has(order[at] as string)) continue
      for (; index < next; index++) mounted.push(index)
      break
    }
    cursor = end
    index = next
  }
  return { mounted, closed, covered: cursor === order.length }
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
 *
 * A resolution is reusable from that slice alone only when the walk closed every
 * member run and paired the whole resident order. A run left open ends where a
 * key that is not resident yet would sit, so that key's later arrival moves the
 * run without moving the slice, and rows the walk never paired leave the same
 * doubt. Anything else is recomputed, and a resolution an earlier order stored
 * for this head key is dropped.
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
  const walk = walkMounted(entries, order, keys)
  if (walk.closed && walk.covered) {
    resolutions.set(headKey, { slice: order.slice(head, head + MOUNTED_ROW_LIMIT), mounted: walk.mounted })
  } else resolutions.delete(headKey)
  return walk.mounted
}

/**
 * Resident index of the control row whose Turn owns the window head: the last
 * control at or above that head. Controls start their Turn's run of rows, so
 * this is the head's own `turn-process` node.
 * @param controls - ascending resident indices of the Turn-process controls.
 * @param head - window head index.
 * @returns the owning control index, or undefined before the first Turn.
 */
function headControl(controls: readonly number[], head: number): number | undefined {
  let low = 0
  let high = controls.length
  while (low < high) {
    const middle = low + (high - low >> 1)
    if ((controls[middle] as number) <= head) low = middle + 1
    else high = middle
  }
  return low === 0 ? undefined : controls[low - 1]
}

/**
 * Snap a requested window head to the start of the Turn that owns it. A window
 * head is a history-loading boundary: mounting from a row inside a Turn mounts
 * that Turn's later rows without the rows above the head — its control and its
 * prompt — so the reader sees a Turn fragment whose start is not on screen.
 * Controls start their Turn's run of rows, so the owning Turn's start is the
 * last control at or above the requested head.
 * @param controls - ascending resident indices of the Turn-process controls.
 * @param head - requested resident head index.
 * @returns the owning Turn's first resident index, or `head` ahead of the first Turn.
 */
function turnAlignedHead(controls: readonly number[], head: number): number {
  return headControl(controls, head) ?? head
}

/**
 * Head a reveal step moves to, or null when no step may move. The step keeps
 * one resident row mounted, so a Turn start farther above that row than the
 * window holds cannot mount together with it: the step refuses rather than
 * expose the Turn from its middle, and the caller's history page serves the
 * reader instead.
 * @param controls - ascending resident indices of the Turn-process controls.
 * @param head - current window head index.
 * @param row - resident index the step must keep mounted.
 * @returns the aligned head index, or null when the step must not move.
 */
function revealHead(controls: readonly number[], head: number, row: number): number | null {
  const target = turnAlignedHead(controls, headKeepingRow(head - REVEAL_ROW_STEP, row))
  return headKeepingRow(target, row) === target && target < head ? target : null
}

/**
 * Plan the mounted slice of the resident order. The window is
 * `MOUNTED_ROW_LIMIT` resident keys from its head, and an entry is mounted when
 * any key it renders is inside that slice: a `group` entry renders its members
 * as rows of its own, so the bound counts keys, not entries. `stub` also holds
 * the newest slice, which keeps a live Turn's rows and the opening echo spliced
 * while the reader is frozen above them. The Turn fold hides member rows behind
 * their `turn-process` control, so the control of every Turn whose rows a plan
 * carries mounts beside them: the head Turn's control for the window, and the
 * tail slice's own Turn control while the stub is mounted. A window that
 * carried members without their control would render none of them.
 * @param entries - root rendering entries over the whole loaded window.
 * @param order - resident Node keys in transcript order.
 * @param window - requested window identity.
 * @param stub - whether the resident tail slice stays mounted beside the window.
 * @param controls - ascending resident indices of the Turn-process controls.
 * @returns the mounted entries, the keys they may render, and the window's facts.
 */
export function planMountedWindow(
  entries: readonly RenderEntry[],
  order: readonly string[],
  window: MountWindow,
  stub: boolean,
  controls: readonly number[] = [],
): MountedWindowPlan {
  const head = headIndexOf(window, order)
  const windowKeys = order.slice(head, head + MOUNTED_ROW_LIMIT)
  const tailKeys = stub ? order.slice(tailHead(order)) : []
  const keys = new Set(stub ? [...windowKeys, ...tailKeys] : windowKeys)
  const control = headControl(controls, head)
  const controlKey = control === undefined ? undefined : order[control]
  if (controlKey !== undefined) keys.add(controlKey)
  // The stub is a second region of the plan: its newest slice can carry folded
  // member rows of a Turn whose control sits above the slice, so mount that
  // slice's own control too.
  if (stub) {
    const tailControl = headControl(controls, tailHead(order))
    const tailControlKey = tailControl === undefined ? undefined : order[tailControl]
    if (tailControlKey !== undefined) keys.add(tailControlKey)
  }
  const mounted = new Set<number>()
  for (const key of keys) for (const at of entriesByKey(entries).get(key) ?? []) mounted.add(at)
  if (window.kind === 'tail') {
    const blocks = tailBlocks(entries, order, head)
    if (blocks === null) for (const at of walkMounted(entries, order, keys).mounted) mounted.add(at)
    else for (const at of blocks) mounted.add(at)
  } else {
    for (const at of frozenMounted(entries, order, window.head, head, new Set(windowKeys))) mounted.add(at)
    if (stub) {
      const blocks = tailBlocks(entries, order, tailHead(order))
      if (blocks === null) for (const at of walkMounted(entries, order, keys).mounted) mounted.add(at)
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
  const { entries, order, controls, followingTail, anchorKey, running } = input
  // The reader's own window; null while they own none, where the window in
  // effect follows the reading policy instead. A request that resolves to the
  // live tail is still the reader's own: a jump to a row only the tail mounts
  // must move the window in effect, and the reader-row adoption below would
  // otherwise keep the head where it is.
  const [requested, setRequested] = useState<MountWindow | null>(null)
  const orderRef = useRef(order)
  const controlsRef = useRef(controls)
  const readerRow = useMemo(() => orderIndexOfAnchor(order, anchorKey), [order, anchorKey])
  const readerRowRef = useRef(readerRow)

  // Opening a session off the floor: the saved reader row sits outside the tail
  // window, so the window in effect is derived from that row while the reader
  // owns no window of their own. Deriving it instead of storing it keeps the
  // adoption idempotent, where a render-phase setState would be discarded and
  // replayed by a repeated render. The derived head snaps to the Turn start that
  // owns its row, so the opening boundary never exposes a Turn from its middle;
  // a Turn start farther above the reader's row than the window holds keeps that
  // row instead, because the session must open where the reader left it. An
  // aligned head is frozen even when its window still reaches the newest rows:
  // the tail window follows the newest resident rows and can only start at
  // `tailHead`, which is no Turn boundary.
  const window = useMemo((): MountWindow => {
    if (requested !== null) return requested
    if (followingTail || readerRow < 0) return { kind: 'tail' }
    const raw = headKeepingRow(readerRow - REVEAL_ROW_STEP, readerRow)
    const aligned = turnAlignedHead(controls, raw)
    // The Turn start wins only while the reader's own row stays inside the window
    // it mounts; otherwise the reader's row wins and the window keeps the start
    // the clamp gave it (`revealHead` refuses the same trade-off for a step).
    return headKeepingRow(aligned, readerRow) === aligned ? frozenAt(order, aligned) : windowAt(order, raw)
  }, [controls, followingTail, order, readerRow, requested])
  const windowRef = useRef<MountWindow>(window)
  useLayoutEffect(() => {
    orderRef.current = order
    controlsRef.current = controls
    windowRef.current = window
    readerRowRef.current = readerRow
  })

  const hold = useCallback((key: string | null): boolean => {
    const current = orderRef.current
    const index = orderIndexOfAnchor(current, key)
    if (index < 0) return false
    const head = headIndexOf(windowRef.current, current)
    if (index >= head && index < head + MOUNTED_ROW_LIMIT) return false
    // A row near the resident tail resolves to the tail window, which the reader
    // still has to be given: storing it is what moves the window in effect off
    // the reader's own row, so the commit that mounts the row follows.
    setRequested(windowAt(current, headKeepingRow(index - REVEAL_ROW_STEP, index)))
    return true
  }, [])

  /**
   * Step the head one reveal above the live window while `row` stays mounted.
   * @param row - resident index the new window must still hold; -1 moves nothing.
   * @returns whether the head moved.
   */
  const stepUp = useCallback((row: number): boolean => {
    if (row < 0) return false
    const current = orderRef.current
    const head = headIndexOf(windowRef.current, current)
    const target = revealHead(controlsRef.current, head, row)
    if (target === null) return false
    // The step pins its landing, so the tail normalization cannot take it back.
    setRequested(frozenAt(current, target))
    return true
  }, [])

  // A reveal grows the window upward and keeps the reader's own row mounted;
  // with no reader row the head would move while the reader's rows unmount, so
  // the caller pages resident history in instead.
  const reveal = useCallback((): boolean => stepUp(readerRow), [readerRow, stepUp])

  const willRevealAtHead = useCallback((scroll: HeadScroll, historyBusy: boolean): boolean => {
    if (historyBusy || !scroll.movedByReader || followingTail) return false
    // A reader who owns no row owns the tail: the newest rows must stay mounted,
    // so only the explicit gesture pages resident history in.
    if (readerRowRef.current < 0) return false
    // One viewport of headroom is what keeps the next gesture continuous; past it
    // the window is not what the reader is approaching, so nothing moves.
    if (scroll.top > scroll.height || scroll.height <= 0) return false
    // A head at the first resident row has nothing left to reveal, and this is the
    // check that keeps the view from settling a sample for a scroll it cannot step.
    // The step keeps the reader's own row while the window holds it and the head
    // row otherwise, and it refuses when the Turn-aligned landing cannot keep that
    // row: those scrolls are served by paging older resident history in. No timer
    // paces the steps: a reveal makes the scrollport absorb the rows it added,
    // which moves the reader more than a viewport from the new head, so the next
    // step waits for the next viewport of reader travel.
    const current = orderRef.current
    const head = headIndexOf(windowRef.current, current)
    const saved = readerRowRef.current
    const holdsSaved = saved >= head && saved < head + MOUNTED_ROW_LIMIT
    return (holdsSaved && revealHead(controlsRef.current, head, saved) !== null)
      || revealHead(controlsRef.current, head, head) !== null
  }, [followingTail])

  const revealAtHead = useCallback((scroll: HeadScroll, historyBusy: boolean): boolean => {
    if (!willRevealAtHead(scroll, historyBusy)) return false
    const current = orderRef.current
    const head = headIndexOf(windowRef.current, current)
    // The step keeps the head row the reader has scrolled to, and the saved row
    // while the window still holds it and the step can move with it. A saved row
    // the step cannot move under is the row the reading policy is about to replace
    // with this scroll's sample, so the head row is what the step must keep then.
    const saved = readerRowRef.current
    if (saved >= head && saved < head + MOUNTED_ROW_LIMIT && stepUp(saved)) return true
    return stepUp(head)
  }, [stepUp, willRevealAtHead])

  const release = useCallback((): void => { setRequested(null) }, [])

  // The reader owns the live tail again: own input, Back to bottom, or arrival at
  // the mounted floor, which is not the transcript floor while rows remain below.
  // Tail ownership drops the reader's own window, so a later departure from the
  // tail adopts the saved reader row again; a window a jump moved stays while the
  // reader is away from the tail, because the landing below it is aligned against
  // that row and releasing it would unmount that row mid-jump.
  useLayoutEffect(() => {
    if (followingTail) setRequested(null)
  }, [followingTail])

  const plan = useMemo(
    () => planMountedWindow(entries, order, window, running && window.kind === 'frozen', controls),
    [controls, entries, order, window, running],
  )
  // A reveal keeps the reader's own row mounted, so that row clamps how far the
  // head can step up: with no reader row, or one the aligned step cannot keep,
  // the gesture is a no-op the view must not offer.
  const revealable = useMemo(() => {
    if (readerRow < 0) return false
    const head = headIndexOf(window, order)
    return revealHead(controls, head, readerRow) !== null
  }, [controls, order, readerRow, window])
  const tailEntry = entries.at(-1)
  return {
    ...plan,
    tailMounted: tailEntry === undefined || plan.entries.at(-1) === tailEntry,
    revealable,
    hold,
    reveal,
    willRevealAtHead,
    revealAtHead,
    release,
  }
}
