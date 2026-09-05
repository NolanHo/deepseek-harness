/**
 * Reflow-stable reader position for non-prepend height changes. The paging
 * anchor (ChatView's PagingAnchor) restores the reader's row across prepends;
 * this restores it across everything else that changes flow height above the
 * reading line — Turn Process fold collapse, image intrinsic loads, and
 * disclosure toggles — so history settling stops shifting the page.
 */

/** Held reader position: a rendered row key plus its flow offset. */
export interface ReflowAnchor {
  /** Row key captured while the row was visible. */
  readonly key: string
  /** Row top relative to the scrollport at capture time. */
  readonly top: number
}

/** Row top in scrollport coordinates (viewport-independent). */
function flowTop(row: HTMLElement, scrollport: HTMLElement): number {
  return row.getBoundingClientRect().top - scrollport.getBoundingClientRect().top
}

/**
 * Find the anchor row, or the nearest surviving visible row at or above its
 * position: folding may hide the captured row itself, in which case the row
 * above the collapse keeps its position and everything below stays aligned.
 */
export function anchorOrNearestVisible(list: HTMLElement, key: string): HTMLElement | null {
  const rows = list.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')
  let lastVisible: HTMLElement | null = null
  for (const row of rows) {
    if (row.dataset.chatAnchorKey === key && !row.hidden) return row
    if (!row.hidden) lastVisible = row
    if (row.dataset.chatAnchorKey === key && row.hidden) return lastVisible
  }
  return null
}

/**
 * Re-assert the held anchor after a flow height change. Writes
 * `scrollport.scrollTop` by the row's movement delta and returns the
 * re-captured hold for the caller to store and book into its observed-top
 * ledger; null when no row survives (caller falls back to a fresh capture).
 * @param list - the flow list element owning the anchor rows.
 * @param scrollport - the scroll container.
 * @param anchor - the held reader position.
 * @param anchorRef - mutable hold the caller keeps across renders.
 * @param ledger - records the programmatic write so reader-input attribution
 * does not misclassify the compensation as a user scroll.
 * @returns the re-captured hold, or null when nothing anchors anymore.
 */
export function restoreAnchorOnReflow(
  list: HTMLElement,
  scrollport: HTMLElement,
  anchor: ReflowAnchor,
  anchorRef: { current: ReflowAnchor | null },
  ledger: { current: number },
): ReflowAnchor | null {
  const row = anchorOrNearestVisible(list, anchor.key)
  if (row === null) {
    anchorRef.current = null
    return null
  }
  const next = { key: row.dataset.chatAnchorKey as string, top: flowTop(row, scrollport) }
  const delta = next.top - anchor.top
  if (delta !== 0) {
    scrollport.scrollTop += delta
    ledger.current = scrollport.scrollTop
  }
  anchorRef.current = next
  return next
}
