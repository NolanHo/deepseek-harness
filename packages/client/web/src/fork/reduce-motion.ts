// Fork-owned reduced-motion opt-in (see FORK_SURFACE.md): the deployment can
// pin the preference for its own GUI without changing the browser-wide
// `prefers-reduced-motion` setting. `?reduce-motion=1` stores the choice,
// `?reduce-motion=0` clears it, and each boot reapplies the stored value as
// `<html data-reduce-motion>`; the shell stylesheet turns animations and
// transitions off under that attribute only.

/** Storage key holding this deployment's reduced-motion choice. */
export const REDUCE_MOTION_STORAGE_KEY = 'dsh:reduce-motion'

/** Query parameter that sets or clears the stored choice. */
export const REDUCE_MOTION_QUERY_KEY = 'reduce-motion'

/** Whether one stored value means "motion off". */
function stored(): boolean {
  try {
    return globalThis.localStorage?.getItem(REDUCE_MOTION_STORAGE_KEY) === '1'
  } catch {
    // A blocked storage (private mode, disabled cookies) only costs persistence.
    return false
  }
}

/** Persist or clear the choice, ignoring a blocked storage. */
function store(on: boolean): void {
  try {
    if (on) globalThis.localStorage?.setItem(REDUCE_MOTION_STORAGE_KEY, '1')
    else globalThis.localStorage?.removeItem(REDUCE_MOTION_STORAGE_KEY)
  } catch {
    // Same blocked-storage case as `stored`: this page still gets the attribute.
  }
}

/**
 * Resolve the deployment's reduced-motion choice. The query parameter wins and
 * persists the choice (`?reduce-motion`, `=1`, `=true` enable it; `=0` or
 * `=false` clear it); without the parameter the stored choice applies.
 * @param search - the page URL's query string, with or without the leading `?`.
 * @returns whether this page should run without motion.
 */
export function resolveReduceMotion(search: string): boolean {
  const value = new URLSearchParams(search).get(REDUCE_MOTION_QUERY_KEY)
  if (value === null) return stored()
  const on = value !== '0' && value !== 'false'
  store(on)
  return on
}

/**
 * Apply the resolved choice to the document root before the loader roster
 * activates, so no boot-time animation runs under the opted-in preference.
 * @param root - the element receiving the `data-reduce-motion` marker.
 * @param search - the page URL's query string.
 * @returns whether motion was disabled for this page.
 */
export function applyReduceMotion(root: HTMLElement, search: string): boolean {
  const on = resolveReduceMotion(search)
  if (on) root.dataset.reduceMotion = 'true'
  else delete root.dataset.reduceMotion
  return on
}
