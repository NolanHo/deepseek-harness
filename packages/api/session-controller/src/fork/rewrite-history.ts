// Fork-owned in-place rewrite cut module (see FORK_SURFACE.md): the host
// validates one armed rewrite anchor against an exact stored-log observation
// and derives the turn-boundary cut the persistence truncation needs, as one
// pure function. Upstream's commands.ts keeps only the marked call.

import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'

/** Typed reasons one armed rewrite anchor is refused. */
export type RewriteRefusalReason =
  | 'REWRITE_INVALID_FROM'
  | 'REWRITE_SUBAGENT_SESSION'
  | 'REWRITE_INHERITED_PREFIX'

/** One validated rewrite cut, or the typed reason the anchor was refused. */
export type RewriteCutResult =
  | { readonly ok: true; readonly cut: SessionLogOffset }
  | { readonly ok: false; readonly reason: RewriteRefusalReason }

/**
 * Validate an armed in-place rewrite anchor and derive the storage cut it
 * produces: the seq of the last `turn/start` at or below the armed
 * `user/message`, extended backwards over that message's admission splices.
 * Truncation therefore discards the whole turn, never slices a turn open
 * (resume would otherwise append synthetic interrupted-turn closers into the
 * new history), and never leaves the replaced message's own admission
 * bookkeeping behind. `0` when the armed turn is the log's first.
 * Runtime subagent ownership under a live parent is the caller's check; this
 * function refuses only the durable `origin` form.
 * @param header - the observed Session header carrying durable ownership.
 * @param events - the observed contiguous log from seq 0.
 * @param rewriteFrom - seq of the armed `user/message` to replace.
 * @param inheritedEventCount - stored fork-inherited prefix length.
 * @returns the cut, or the typed refusal reason.
 */
export function resolveRewriteCut(
  header: Pick<SessionHeader, 'origin'>,
  events: readonly SessionEvent[],
  rewriteFrom: number,
  inheritedEventCount: SessionLogOffset,
): RewriteCutResult {
  if (header.origin === 'subagent') return { ok: false, reason: 'REWRITE_SUBAGENT_SESSION' }
  const armed = events[rewriteFrom]
  if (armed === undefined || armed.seq !== rewriteFrom || armed.type !== 'user/message') {
    return { ok: false, reason: 'REWRITE_INVALID_FROM' }
  }
  let cut = 0
  for (const event of events) {
    if (event.seq > rewriteFrom) break
    if (event.type === 'turn/start') cut = event.seq
  }
  // The replaced message's admission bookkeeping sits immediately before its
  // turn: the `agent/inbox/spliced` insert carries that message's content (the
  // client renders it as the user bubble, so keeping it would leak the
  // replaced text into the window), and its removal splice lands inside the
  // discarded turn (so keeping the insert would also leave a phantom inbox
  // entry after resume). Only splices that inserted THIS message are crossed:
  // another message's admission is not this rewrite's to discard, and the
  // walk never crosses a committed `turn/end` (such an event ends the run).
  const armedId = String(armed.data.id)
  while (cut > 0) {
    const previous = events[cut - 1]
    if (previous?.type !== 'agent/inbox/spliced') break
    if (!previous.data.inserted.some(message => String(message.id) === armedId)) break
    cut -= 1
  }
  if (cut < inheritedEventCount) return { ok: false, reason: 'REWRITE_INHERITED_PREFIX' }
  return { ok: true, cut: SessionLogOffset(cut) }
}

/** The inbox targets whose pending lists one splice mutates. */
export type RewriteInboxTarget = 'next-turn' | 'next-step'

/** The removal splice one rewrite appends to neutralize a retained insert. */
export interface RewriteInboxRepair {
  /** Pending list that still holds the replaced message. */
  readonly target: RewriteInboxTarget
  /** Index of that message inside the folded pending list. */
  readonly start: number
}

/**
 * Plan the inbox repair one rewrite needs after truncating at `cut`. A message
 * queued while an earlier turn was still running has its admission insert
 * inside that earlier turn, so the cut (the start of the message's own turn)
 * retains the insert while discarding the claim splice that removed it — the
 * backward walk in {@link resolveRewriteCut} cannot cross the committed
 * `turn/end` between them. Folding that prefix restores the replaced message
 * as pending, and the resumed driver claims and replays it as a new turn with
 * the replaced text (observed on the second instance). The repair is the one
 * removal splice, at the id's folded index, that empties the entry again.
 * @param events - the observed contiguous log from seq 0.
 * @param cut - the retained prefix length (the truncation cut).
 * @param armedId - stable id of the armed `user/message`.
 * @returns the splice to append, or undefined when nothing stays pending.
 */
export function planInboxRepair(
  events: readonly SessionEvent[],
  cut: SessionLogOffset,
  armedId: string,
): RewriteInboxRepair | undefined {
  for (const target of ['next-turn', 'next-step'] as const) {
    const index = pendingIds(events, cut, target).indexOf(armedId)
    if (index >= 0) return { target, start: index }
  }
  return undefined
}

/**
 * Fold one inbox target's pending message ids over the retained prefix, with
 * the same array-splice semantics the inbox projection applies.
 * @param events - the observed contiguous log from seq 0.
 * @param cut - the retained prefix length.
 * @param target - the inbox list to fold.
 * @returns the pending message ids in list order.
 */
function pendingIds(events: readonly SessionEvent[], cut: SessionLogOffset, target: RewriteInboxTarget): string[] {
  const pending: string[] = []
  for (const event of events) {
    if (event.seq >= cut) break
    if (event.type !== 'agent/inbox/spliced' || event.data.target !== target) continue
    pending.splice(
      event.data.start,
      event.data.removedCount ?? 0,
      ...event.data.inserted.map(message => String(message.id)),
    )
  }
  return pending
}
