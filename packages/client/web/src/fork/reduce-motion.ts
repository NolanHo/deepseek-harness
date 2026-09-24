// Fork-owned reduced-motion default (see FORK_SURFACE.md): this deployment
// runs without motion by default, without changing the browser-wide
// `prefers-reduced-motion` setting. Each boot marks `<html data-reduce-motion>`
// (the shell stylesheet then completes animations and transitions in one step);
// `?reduce-motion=0` stores an opt-out, `?reduce-motion=1` clears it.

/** Storage key holding this deployment's reduced-motion choice. */
export const REDUCE_MOTION_STORAGE_KEY = 'dsh:reduce-motion'

/** Query parameter that sets or clears the stored choice. */
export const REDUCE_MOTION_QUERY_KEY = 'reduce-motion'

/**
 * One stored choice: `'1'` keeps the default, `'0'` is the reader's opt-out,
 * `undefined` means no choice was stored (or the storage is blocked).
 */
function stored(): '1' | '0' | undefined {
  try {
    const value = globalThis.localStorage.getItem(REDUCE_MOTION_STORAGE_KEY)
    return value === '1' || value === '0' ? value : undefined
  } catch {
    // A blocked storage (private mode, disabled cookies) only costs persistence;
    // the deployment default still applies.
    return undefined
  }
}

/** Persist or clear the opt-out, ignoring a blocked storage. */
function store(value: '1' | '0' | undefined): void {
  try {
    if (value === undefined) globalThis.localStorage.removeItem(REDUCE_MOTION_STORAGE_KEY)
    else globalThis.localStorage.setItem(REDUCE_MOTION_STORAGE_KEY, value)
  } catch {
    // Same blocked-storage case as `stored`: this page still gets the attribute.
  }
}

/**
 * Resolve the deployment's reduced-motion choice. Motion is off by default; a
 * stored opt-out (`?reduce-motion=0`) turns it back on, and `?reduce-motion=1`
 * clears that opt-out. The query parameter wins and persists.
 * @param search - the page URL's query string, with or without the leading `?`.
 * @returns whether this page should run without motion.
 */
export function resolveReduceMotion(search: string): boolean {
  const value = new URLSearchParams(search).get(REDUCE_MOTION_QUERY_KEY)
  if (value === null) return stored() !== '0'
  const on = value !== '0' && value !== 'false'
  store(on ? undefined : '0')
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
