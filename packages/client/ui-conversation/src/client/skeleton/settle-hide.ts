/** Fork-owned bounded settle hide (see FORK_SURFACE.md): the composer seat's
 * hide while a Session settles must not outlive an asynchronous settle that
 * never lands. */

import { useEffect, useState } from 'react'

/**
 * Longest time the settle hide may keep the composer seat invisible.
 *
 * Both settle inputs are asynchronous facts that need not settle: a history open
 * that never lands, and the parent-catalog read that establishes a continuable
 * subagent's `parentAvailable` (the manager retries neither while the child
 * waits). Hiding the seat is an anti-flash device, so it expires instead of
 * outliving them — otherwise the composer stays invisible for the life of the
 * page and only a reload clears it.
 */
export const SETTLE_HIDE_LIMIT_MS = 5000

/**
 * Bound one settle-driven hide to a fixed window.
 *
 * Each continuous pending period hides for at most `limitMs`; the window
 * restarts for a different `resetKey` and a cleared condition re-arms it.
 *
 * @param pending - Whether the settle state currently applies.
 * @param resetKey - Identity whose change restarts the window (the Session id).
 * @param limitMs - Maximum time the hide may last.
 * @returns Whether the hide still applies.
 */
export function useSettleHide(pending: boolean, resetKey: string, limitMs: number): boolean {
  const [expiredKey, setExpiredKey] = useState<string | null>(null)
  useEffect(() => {
    if (!pending) {
      setExpiredKey(null)
      return
    }
    const timer = setTimeout(() => { setExpiredKey(resetKey) }, limitMs)
    return () => { clearTimeout(timer) }
  }, [pending, resetKey, limitMs])
  return pending && expiredKey !== resetKey
}
