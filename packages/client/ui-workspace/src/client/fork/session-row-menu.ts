// Fork-owned session-row menu registry (see FORK_SURFACE.md): the contribution
// point an out-of-tree Web plugin uses to add one hover-submenu row to a
// sidebar session row's `⋯` menu. The registry, the leaf-id namespace rule, and
// the injected service type live here; the browser carries only marked
// injections that read the hook and merge the registered rows.

import type { ReactNode } from 'react'

/** One selectable submenu row a contribution offers for a single Session. */
export interface SessionRowMenuLeaf {
  /** Registrant-owned leaf id, unique inside its contribution. */
  readonly id: string
  /** Leaf label, already localized by the registrant. */
  readonly label: string
  /** Render the leaf as unavailable; `Menu` never selects a disabled row. */
  readonly disabled?: boolean | undefined
}

/** One plugin-contributed row of the sidebar session row's `⋯` menu. */
export interface SessionRowMenuContribution {
  /** Registrant-owned id; duplicated registration throws. */
  readonly id: string
  /** Menu row label, already localized by the registrant. */
  readonly label: string
  /** Leading icon for the contributed menu row. */
  readonly icon?: ReactNode
  /**
   * Submenu leaves for one session, evaluated per render. An empty array hides
   * the contribution row for that session.
   * @param sessionId - The row's Session id.
   * @returns The leaves this contribution offers for that Session.
   */
  readonly submenu: (sessionId: string) => readonly SessionRowMenuLeaf[]
  /**
   * Leaf selection; `leafId` is the leaf's own id (not prefixed).
   * @param sessionId - The selected row's Session id.
   * @param leafId - The selected leaf's own id.
   */
  readonly onSelect: (sessionId: string, leafId: string) => void
}

/** The contribution registry an out-of-tree plugin injects as `sessionRowMenu`. */
export interface SessionRowMenuService {
  /**
   * Register one contribution.
   * @param contribution - The menu row and its per-session leaves.
   * @returns The disposer that removes this contribution.
   */
  register(contribution: SessionRowMenuContribution): () => void
}

/** The provided handle: the registry plus the observable source the browser binds. */
export interface SessionRowMenuHandle extends SessionRowMenuService {
  /**
   * Current contributions, in registration order.
   * @returns The same array reference until a registration or removal lands.
   */
  snapshot(): readonly SessionRowMenuContribution[]
  /**
   * Observe registration changes.
   * @param listener - Called after every registration and removal.
   * @returns The unsubscribe function.
   */
  subscribe(listener: () => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Session-row `⋯` menu contribution registry. */
    sessionRowMenu: SessionRowMenuService
  }
}

/**
 * Create the session-row menu registry the browser half provides.
 * @returns The handle carrying `register` and the source the row menu reads.
 */
export function createSessionRowMenu(): SessionRowMenuHandle {
  const contributions = new Map<string, SessionRowMenuContribution>()
  const listeners = new Set<() => void>()
  let current: readonly SessionRowMenuContribution[] | undefined
  const publish = (): void => {
    current = undefined
    for (const listener of listeners) listener()
  }
  return {
    register: (contribution) => {
      if (contributions.has(contribution.id)) {
        throw new Error(`sessionRowMenu: duplicate contribution id "${contribution.id}"`)
      }
      contributions.set(contribution.id, contribution)
      publish()
      return () => {
        // A disposer outlives the registration it belongs to when a plugin
        // re-registers the same id before its old fiber unwinds.
        if (contributions.get(contribution.id) !== contribution) return
        contributions.delete(contribution.id)
        publish()
      }
    },
    snapshot: () => {
      current ??= [...contributions.values()]
      return current
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
