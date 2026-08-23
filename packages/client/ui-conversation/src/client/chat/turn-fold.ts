// Render-time fold pre-pass for ChatView: groups the ordered Chat rows into
// visible segments, collapsing a settled turn's intermediate content behind
// one fold header. Pure view grouping over the published Chat snapshot — no
// runtime or Session changes.

import type {
  ChatConversationViewNode, ChatNodeStore, ConversationTimelineSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNode } from '../contract/chat-nodes.ts'

/** One render segment: a visible row, or a fold header owning hidden rows. */
export type ChatRowSegment =
  | { readonly kind: 'row'; readonly key: string }
  | {
    readonly kind: 'fold'
    /** Owning turn number. */
    readonly turn: number
    /** Anchor identity of the first hidden row (scroll anchoring key). */
    readonly anchorKey: string
    /** Hidden rows of kind `tool-call`. */
    readonly toolCalls: number
    /** Hidden rows of kind `assistant-step` (intermediate replies). */
    readonly steps: number
    /** All hidden rows, kinds without a dedicated count included. */
    readonly total: number
  }

/** Rows a fold never swallows, keyed by Chat kind. */
const UNFOLDABLE_KINDS: ReadonlySet<string> = new Set(['user', 'steering', 'turn-error', 'turn-max-tokens'])

function turnNumberOf(node: ChatConversationViewNode | undefined): number | undefined {
  const location = node?.location
  return location !== undefined && (location.kind === 'turn' || location.kind === 'step')
    ? location.turn.turn
    : undefined
}

/** Closing answer seq carried by a turn-tail row; undefined for other rows. */
function tailClosingSeq(node: ChatConversationViewNode | undefined): number | undefined {
  if (node === undefined || node.kind !== 'turn-tail') return undefined
  const closing = (node.data as { readonly closing?: { readonly finalNode: { readonly seq: number } } | null })
    .closing
  return closing === null || closing === undefined ? undefined : closing.finalNode.seq
}

/**
 * Row key at a turn-span index. Every span index comes from the published
 * order array, so the key exists; a missing key means the snapshot contract
 * broke, and folding must not silently skip rows.
 * @param order - ordered Chat node keys.
 * @param index - span index.
 * @returns the row key.
 */
function keyAt(order: readonly string[], index: number): string {
  const key = order[index]
  if (key === undefined) throw new Error(`turn-fold: order index ${index} out of range`)
  return key
}

/**
 * Build the visible segment list over the Chat order.
 * @param order - Ordered Chat node keys from the snapshot.
 * @param nodes - Keyed Chat node store.
 * @param timeline - Turn boundary snapshot.
 * @param expandedTurns - Locally expanded turn numbers; every other settled
 *  turn with a closing answer renders folded.
 * @returns Ordered visible segments; rows outside any fold render unchanged.
 */
export function foldSegments(
  order: readonly string[],
  nodes: ChatNodeStore,
  timeline: ConversationTimelineSnapshot,
  expandedTurns: ReadonlySet<number>,
): readonly ChatRowSegment[] {
  const segments: ChatRowSegment[] = []
  let index = 0
  while (index < order.length) {
    const turn = turnNumberOf(nodes.get(keyAt(order, index)))
    if (turn === undefined || !timeline.turns.has(turn)) {
      segments.push({ kind: 'row', key: keyAt(order, index) })
      index += 1
      continue
    }
    // Consume the whole turn span at once; the turn-tail is the span's last
    // row, so the closing seq is known before the rows are classified.
    let end = index
    let closingSeq: number | undefined
    while (end < order.length && turnNumberOf(nodes.get(keyAt(order, end))) === turn) {
      closingSeq ??= tailClosingSeq(nodes.get(keyAt(order, end)))
      end += 1
    }
    // The loop above stopped with this turn in the timeline, so the state exists.
    const turnState = timeline.turns.get(turn)
    if (turnState === undefined) throw new Error(`turn-fold: turn ${turn} state missing from the timeline`)
    const settled = turnState.status !== 'open' && closingSeq !== undefined
    if (!settled) {
      for (let i = index; i < end; i += 1) segments.push({ kind: 'row', key: keyAt(order, i) })
      index = end
      continue
    }
    let foldAnchor: string | undefined
    let toolCalls = 0
    let steps = 0
    let total = 0
    const hidden = new Set<string>()
    for (let i = index; i < end; i += 1) {
      const key = keyAt(order, i)
      // Span membership came from the same store, so the node exists.
      const node = nodes.get(key) as ChatNode
      const finalSeq = node.kind === 'assistant-step'
        ? (node.data as { readonly finalNode?: { readonly seq: number } }).finalNode?.seq
        : undefined
      if (UNFOLDABLE_KINDS.has(node.kind)
        || node.kind === 'turn-tail'
        || finalSeq === closingSeq) {
        continue
      }
      if (foldAnchor === undefined) foldAnchor = key
      hidden.add(key)
      total += 1
      if (node.kind === 'tool-call') toolCalls += 1
      else if (node.kind === 'assistant-step') steps += 1
    }
    if (foldAnchor === undefined) {
      // Nothing foldable inside a settled turn: keep every row.
      for (let i = index; i < end; i += 1) segments.push({ kind: 'row', key: keyAt(order, i) })
      index = end
      continue
    }
    const expanded = expandedTurns.has(turn)
    for (let i = index; i < end; i += 1) {
      const key = keyAt(order, i)
      // The header stands at the first foldable row's position whether the
      // span is collapsed (replacing it) or expanded (a live re-collapse
      // control above the restored rows).
      if (key === foldAnchor) {
        segments.push({ kind: 'fold', turn, anchorKey: foldAnchor, toolCalls, steps, total })
      }
      if (!expanded && hidden.has(key)) continue
      segments.push({ kind: 'row', key })
    }
    index = end
  }
  return segments
}
