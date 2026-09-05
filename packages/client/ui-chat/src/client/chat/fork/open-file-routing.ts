// Fork-owned open-file routing module (see FORK_SURFACE.md): the decision that
// sends core file surfaces to the third-party betterSidebar editor when that
// plugin is installed, plus the refusal mapping for Hosts without a native
// opener. The Chat apply closure keeps the ctx duck read, the remote call, and
// the locale seat.

/** One editor tab request the third-party sidebar editor accepts. */
export interface SidebarEditorTab {
  type: string
  title: string
  path: string
  id: string
}

/** The third-party sidebar editor surface found by a duck-typed ctx service. */
export interface SidebarEditorLike {
  openTab?: (tab: SidebarEditorTab) => void
}

/** Where one file-open request routes. */
export type OpenFileRoute =
  | { readonly kind: 'sidebar'; readonly openTab: (tab: SidebarEditorTab) => void; readonly tab: SidebarEditorTab }
  | { readonly kind: 'native' }

/**
 * Decide where one file-open request routes: a folder reveal (`.` carries no
 * editor file) and plugin-less profiles keep the native Host opener; anything
 * else opens in the installed betterSidebar editor.
 * @param path - Raw surface path (folder reveals stay native).
 * @param absolutePath - The path resolved against the Session cwd.
 * @param sidebar - Optional third-party editor service.
 * @returns The routing choice carrying the sidebar tab when routed there.
 */
export function routeOpenFile(
  path: string,
  absolutePath: string,
  sidebar: SidebarEditorLike | undefined,
): OpenFileRoute {
  const openTab = sidebar?.openTab
  if (path === '.' || openTab === undefined) return { kind: 'native' }
  const cut = Math.max(absolutePath.lastIndexOf('/'), absolutePath.lastIndexOf('\\'))
  const title = cut === -1 ? absolutePath : absolutePath.slice(cut + 1)
  return {
    kind: 'sidebar',
    openTab,
    tab: { type: 'editor', title, path: absolutePath, id: `editor:${absolutePath}` },
  }
}

/**
 * Failure text for a refused native open: a Host without a native opener
 * relays the caller's friendly localized copy instead of the wire message;
 * any other refusal keeps the wire message under the standard prefix.
 * @param wireMessage - The refused open result's error message.
 * @param desktopUnavailableCopy - The localized `fileOpen.desktopUnavailable` copy.
 * @returns The error text to surface.
 */
export function nativeOpenFailureText(wireMessage: string, desktopUnavailableCopy: string): string {
  if (wireMessage.includes('desktop unavailable')) return desktopUnavailableCopy
  return `path open failed: ${wireMessage}`
}
