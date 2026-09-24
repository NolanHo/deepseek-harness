// Fork-owned deployment theme (see FORK_SURFACE.md): this deployment renders
// the dusk-blue palette in `themes.css` by default. Each boot marks
// `<html data-dsh-theme="harbor">` before any entry activates, so the first
// frame already carries the deployment palette; `?theme=default` stores a
// per-browser opt-out and `?theme=harbor` clears it. Upstream's theme plugin
// owns only the light/dark/system preference and content font size, so the
// palette lives here rather than in a theme registration.

/** Storage key holding this deployment's theme choice. */
export const THEME_STORAGE_KEY = 'dsh:theme'

/** Query parameter that sets or clears the stored choice. */
export const THEME_QUERY_KEY = 'theme'

/** Marker value the shell stylesheet reads for the deployment palette. */
export const THEME_MARKER = 'harbor'

/**
 * One stored choice: the marker keeps the palette, `'default'` is the reader's
 * opt-out, `undefined` means no choice was stored (or the storage is blocked).
 */
function stored(): typeof THEME_MARKER | 'default' | undefined {
  try {
    const value = globalThis.localStorage.getItem(THEME_STORAGE_KEY)
    return value === THEME_MARKER || value === 'default' ? value : undefined
  } catch {
    // A blocked storage (private mode, disabled cookies) only costs persistence;
    // the deployment default still applies.
    return undefined
  }
}

/** Persist or clear the opt-out, ignoring a blocked storage. */
function store(value: typeof THEME_MARKER | 'default' | undefined): void {
  try {
    if (value === undefined) globalThis.localStorage.removeItem(THEME_STORAGE_KEY)
    else globalThis.localStorage.setItem(THEME_STORAGE_KEY, value)
  } catch {
    // Same blocked-storage case as `stored`: this page still gets the attribute.
  }
}

/**
 * Resolve the deployment's theme choice. The palette applies by default; a
 * stored opt-out (`?theme=default`) restores upstream's rendering, and
 * `?theme=harbor` clears that opt-out. The query parameter wins and persists.
 * @param search - the page URL's query string, with or without the leading `?`.
 * @returns the theme marker to apply, or `'default'` for upstream's rendering.
 */
export function resolveTheme(search: string): typeof THEME_MARKER | 'default' {
  const value = new URLSearchParams(search).get(THEME_QUERY_KEY)
  if (value === null) return stored() ?? THEME_MARKER
  const optedOut = value === 'default' || value === '0' || value === 'false'
  store(optedOut ? 'default' : undefined)
  return optedOut ? 'default' : THEME_MARKER
}

/**
 * Apply the resolved theme to the document root before the loader roster
 * activates, so the first painted frame carries the deployment palette.
 * @param root - the element receiving the `data-dsh-theme` marker.
 * @param search - the page URL's query string.
 * @returns the theme marker that was applied.
 */
export function applyTheme(root: HTMLElement, search: string): typeof THEME_MARKER | 'default' {
  const theme = resolveTheme(search)
  if (theme === 'default') delete root.dataset.dshTheme
  else root.dataset.dshTheme = theme
  return theme
}
