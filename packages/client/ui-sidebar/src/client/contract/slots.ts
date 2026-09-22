/**
 * Sidebar slot contract: the registrant-side props composition for the
 * layout-owned `sidebar` slot, plus the holes this shell declares. The shell
 * owns column geometry, the brand row, New Session, and global panel rows;
 * everything between the workspace section header and the list bottom is the
 * `sidebar.workspaces` registrant's (ui-workspace); the `sidebar.settings`
 * registrant (ui-settings) renders at the column foot or, in the phone drawer,
 * in the brand row, and optional `sidebar.footer.action` entries stack above
 * that foot seat.
 */
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Brand mark rendered in the expanded brand row and collapsed rail.
     * Declared by this package's `sidebar` entry; deployments may replace
     * the shell's fish fallback without replacing the surrounding controls.
     */
    'sidebar.brand.mark': { kind: 'single'; scope: 'root'; owner: SidebarBrandMarkOwnerProps }
    /**
     * Brand name rendered beside the expanded mark. Declared by this
     * package's `sidebar` entry; the shell supplies a generic text fallback.
     */
    'sidebar.brand.name': { kind: 'single'; scope: 'root'; owner: SidebarBrandNameOwnerProps }
    /**
     * Global panel icons. Each list id addresses the matching main panel;
     * the sidebar owns the button and resolves its label from list metadata.
     */
    'sidebar.panellist': { kind: 'list'; scope: 'root'; owner: SidebarPanelIconOwnerProps }
    /**
     * The workspace/session browsing region: section header, search, the
     * grouped/flat session list, and every workspace dialog. Declared by this
     * package's 'sidebar' entry (declaring is claiming); ui-workspace
     * registers the browser.
     */
    'sidebar.workspaces': { kind: 'single'; scope: 'root'; owner: SidebarSectionOwnerProps }
    /**
     * The settings seat: the sidebar foot normally, the phone drawer's brand
     * row beside the brand (fork drawer regime). Declared by this package's
     * 'sidebar' entry; ui-settings registers its trigger row + modal panel.
     * The sidebar passes only its column state — it holds no settings state.
     */
    'sidebar.settings': { kind: 'single'; scope: 'root'; owner: SidebarSettingsOwnerProps }
    /**
     * Optional actions at the sidebar foot, above the foot settings seat.
     * Declared by this package's 'sidebar' entry; each action receives only
     * the column state.
     */
    'sidebar.footer.action': { kind: 'list'; scope: 'root'; owner: SidebarFooterActionOwnerProps }
  }
}

/** Geometry supplied to the sidebar brand-mark occupant. */
export interface SidebarBrandMarkOwnerProps {
  /** Requested square edge in pixels. */
  size: number
}

/** Empty owner share for the sidebar brand-name occupant. */
export interface SidebarBrandNameOwnerProps {
  /** Marker field: the occupant owns its own content and width. */
  children?: never
}

/** Icon presentation supplied by the global panel row. */
export interface SidebarPanelIconOwnerProps {
  /** Requested square edge in pixels. */
  size: number
  /** Whether this panel is selected in the main column. */
  active: boolean
}

/** Serializable metadata for one active global panel list registration. */
export interface SidebarPanelMetadata {
  /** List id and matching main panel key. */
  id: MainPanelId
  /** Ascending row order; ties retain registration order. */
  order: number
  /** Row title and accessible name: resolved label, or the id when omitted. */
  label: string
}

/**
 * Owner share of the browser hole — the only facts crossing the shell/region
 * boundary. Business data and actions arrive through the region's own inject.
 */
export interface SidebarSectionOwnerProps {
  /** Shell fold-state output: wide renders the full browser, rail the icon column. */
  wide: boolean
  /** Rail icons request expansion; the browser rides the wide flip for focus. */
  expandSidebar: () => void
}

/**
 * Owner share of the sidebar settings seat: the column display state the
 * occupant's trigger row must render against (wide row vs compact icon).
 * The phone drawer's brand row renders the compact variant regardless of the
 * column's own width.
 */
// Fork patch (FORK_SURFACE.md): the phone drawer is the fork's regime; the
// compact variant above exists for that row.
export interface SidebarSettingsOwnerProps {
  /** Whether the seat renders the wide row (false = compact icon-only). */
  wide: boolean
}

/** Owner share of an action rendered beside Settings at the sidebar foot. */
export interface SidebarFooterActionOwnerProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
}

/**
 * Registrant-private injected share (arrives via the register inject
 * factory). The renderer binds the panel metadata source to usePanels.
 */
export type SidebarRootInjected = {
  /**
   * Start a New Session: with a workspace, reuse-or-create its blank session
   * and open it; without one, inherit the current Session Workspace, then the
   * recent Workspace, or clear into the New Session pure view when none exist.
   */
  startSession: (workspaceId?: WorkspaceId) => void
  /** Toggle the sidebar column through the layout service. */
  toggleSidebar: () => void
  /** Select the global panel addressed by a sidebar row. */
  selectPanel: (id: MainPanelId) => void
  /** Private reactive sources bound to framework selector hooks. */
  hooks: { panels: ObservableSnapshot<readonly SidebarPanelMetadata[]> }
}

/**
 * Full component props: layout owner state/actions plus the declared holes'
 * render shares, this package's injected callbacks, and the standard locale
 * seat. Panel metadata arrives through an injected observable.
 */
export type SidebarRootComponentProps =
  PropsRuntime<'sidebar'>
  & PropsRenderSlots<
    | 'sidebar.brand.mark'
    | 'sidebar.brand.name'
    | 'sidebar.panellist'
    | 'sidebar.workspaces'
    | 'sidebar.settings'
    | 'sidebar.footer.action'
  >
  & InjectFace<SidebarRootInjected> & PropsLocale<'sidebar'>
