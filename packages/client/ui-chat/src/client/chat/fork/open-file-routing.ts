// Fork-owned open-file routing module (see FORK_SURFACE.md): the decision that
// sends core file surfaces to the third-party betterSidebar editor when that
// plugin is installed, and the native-availability gate for the delivered-file
// prose vocabulary. The Chat apply closure keeps the ctx duck read, the remote
// call, and the locale seat.

import type { MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'

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
 * Gate a prose mention vocabulary on Host native-opening availability.
 *
 * Upstream's deliverables vocabulary opens a delivered file by POSTing
 * `/api/present.open`, and that route answers 409 when the serving Host has
 * no desktop (`workspaceDesktop().available` false — a headless Linux or
 * containerised deployment). Its card disables the menu in that state; the
 * prose mention carries no guard, so each click printed a 409 and opened
 * nothing. With the probe reporting unavailable, this wrapper routes the
 * gesture through the chat file opener instead, which resolves the same path
 * into the Web surface (this fork's betterSidebar routing first).
 *
 * @param mentions - The deliverables vocabulary to wrap.
 * @param canOpenNative - Host native-opening probe; a rejected probe reads as unavailable.
 * @param openFile - The chat view's file opener.
 * @returns A vocabulary whose gestures consult the probe before opening.
 */
export function nativeGatedMentions(
  mentions: MarkdownFileMentions,
  canOpenNative: () => Promise<boolean>,
  openFile: (path: string) => void,
): MarkdownFileMentions {
  return {
    resolve(value: string) {
      const hit = mentions.resolve(value)
      if (hit === undefined) return undefined
      return {
        label: hit.label,
        title: hit.title,
        open: () => {
          // An unavailable or failed probe both route to the Web opener: the
          // path must open somewhere, and a probe error cannot prove a desktop.
          void canOpenNative().then(
            (available) => { if (available) hit.open(); else openFile(hit.title) },
            () => { openFile(hit.title) },
          )
        },
      }
    },
  }
}
