// Fork-owned session-order stability module (see FORK_SURFACE.md): the
// workspace browser's activity-promotion order account. Upstream's
// WorkspaceBrowser keeps its call sites and the view store keeps its sync
// action; the promotion policy and the unchanged-order guard live here so
// upstream reorders of the browser re-apply as one injection.

import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionOrderBy } from '../tree.ts'

/**
 * Reconcile a stored view order with the Workspace's current session account:
 * the stored keys that still exist keep their relative order and every
 * account Session missing from the store appends in the live order.
 * @param sessionIds - The account's current session set.
 * @param stored - Stored order keys, undefined when none exist yet.
 * @returns The reconciled order over the live session ids.
 */
export function reconciledSessionOrder(sessionIds: readonly SessionId[], stored: readonly string[] | undefined): SessionId[] {
  if (stored === undefined) return [...sessionIds]
  const byId = new Map(sessionIds.map(id => [id as string, id]))
  const ordered: SessionId[] = []
  const included = new Set<string>()
  for (const key of stored) {
    const id = byId.get(key)
    if (id === undefined || included.has(key)) continue
    ordered.push(id)
    included.add(key)
  }
  for (const id of sessionIds) {
    if (included.has(id)) continue
    ordered.push(id)
  }
  return ordered
}

/** Newest update first with stable Session identity as the tie-break. */
function compareSessionRecency(a: SessionId, b: SessionId, byId: SessionListState['byId']): number {
  const aUpdatedAt = byId[a]?.updatedAt ?? Number.NEGATIVE_INFINITY
  const bUpdatedAt = byId[b]?.updatedAt ?? Number.NEGATIVE_INFINITY
  if (aUpdatedAt !== bUpdatedAt) return bUpdatedAt - aUpdatedAt
  return a < b ? -1 : 1
}

/**
 * Whether a next order array differs from the one already stored. The store
 * action keeps the previous array reference when the content is unchanged:
 * the observed timestamps advance on every activity tick, and a fresh array
 * for equal content would re-run every order-derived memo on each one.
 *
 * @param previous - Stored order, undefined when the account has none yet.
 * @param next - The next order content.
 * @returns true when the content changed or nothing was stored.
 */
export function sessionOrderChanged(
  previous: readonly string[] | undefined,
  next: readonly string[],
): boolean {
  return previous === undefined
    || previous.length !== next.length
    || previous.some((id, index) => id !== next[index])
}

/**
 * Reconcile one editable order account and apply its activity-promotion policy.
 * @param sessionIds - The account's current session set.
 * @param previousOrder - Stored order, undefined when none exists yet.
 * @param previousUpdatedAt - Last update timestamps observed per Session.
 * @param list - Live session list supplying update timestamps.
 * @param orderBy - Manual (fixed after edits) or updated (activity promotions).
 * @param sortByRecency - Full recency re-sort instead of one-burst promotions.
 * @returns The next order, the observed timestamps, and whether either moved.
 */
export function nextSessionOrderAccount({
  sessionIds, previousOrder, previousUpdatedAt, list, orderBy, sortByRecency,
}: {
  sessionIds: readonly SessionId[]
  previousOrder: readonly string[] | undefined
  previousUpdatedAt: Readonly<Record<string, number>>
  list: SessionListState
  orderBy: SessionOrderBy
  sortByRecency: boolean
}): { order: SessionId[]; updatedAt: Record<string, number>; changed: boolean } {
  let order = reconciledSessionOrder(sessionIds, previousOrder)
  if (sortByRecency) {
    order.sort((a, b) => compareSessionRecency(a, b, list.byId))
  } else if (orderBy === 'updated') {
    const promoted = new Set(sessionIds.filter((id) => {
      const session = list.byId[id]
      return session !== undefined
        && (previousUpdatedAt[id] === undefined || session.updatedAt > previousUpdatedAt[id])
    }))
    if (promoted.size > 0) {
      // Rows already leading the order keep their relative positions while they
      // stream together: re-sorting the promoted set on every update swap
      // co-streaming rows continuously. Only rows outside the leading promoted
      // run jump to the front, newest first — one promotion per activity burst.
      const head: SessionId[] = []
      for (const id of order) {
        if (!promoted.has(id)) break
        head.push(id)
      }
      const headSet = new Set(head)
      const fresh = order
        .filter(id => !headSet.has(id) && promoted.has(id))
        .sort((a, b) => compareSessionRecency(a, b, list.byId))
      const freshSet = new Set(fresh)
      order = [...fresh, ...head, ...order.filter(id => !headSet.has(id) && !freshSet.has(id))]
    }
  }
  const updatedAt: Record<string, number> = {}
  for (const id of sessionIds) {
    const session = list.byId[id]
    if (session !== undefined) updatedAt[id] = session.updatedAt
  }
  const orderChanged = sessionOrderChanged(previousOrder, order)
  const timestampsChanged = Object.keys(updatedAt).length !== Object.keys(previousUpdatedAt).length
    || Object.entries(updatedAt).some(([id, timestamp]) => previousUpdatedAt[id] !== timestamp)
  return { order, updatedAt, changed: orderChanged || timestampsChanged }
}
