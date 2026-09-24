// Fork-owned mobile shell (see FORK_SURFACE.md): below the phone breakpoint the
// left sidebar becomes a fixed overlay drawer, because upstream's frame only
// auto-collapses it to a rail and a phone frame has no room to re-expand it.
// The module owns the drawer regime hook and its chrome; AppFrame keeps only
// the composition branches. Pure components and one hook over framework-shared
// props; no self-made hooks beyond this module.

import { useCallback, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { IconPanelLeftOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
// Fork patch (FORK_SURFACE.md): upstream 0.1.5 rewrote columns.ts without the
// fork's phone breakpoint; the fork module owns its own value now.
export const MOBILE_VIEWPORT = 768
import css from '../AppFrame.module.css'

/** Owner-prop width fed to the sidebar occupant inside the mobile drawer (inside the sidebar contract range). */
export const DRAWER_WIDTH = 300

/** The layout store's action surface the mobile regime drives. */
export interface MobileRegimeActions {
  setMobile(mobile: boolean): void
  setDrawerOpen(open: boolean): void
  toggleSidebar(): void
}

/** The live layout facts the regime reads (render subscriptions stay in the frame). */
export interface MobileRegimePanels {
  drawerOpen: boolean
  mobile: boolean
}

/**
 * The mobile regime's reactive decisions over the frame's viewport: the mobile
 * flag (mirrored into the store), Escape closing an open drawer, the drawer
 * closing on session change, and the drawer dismiss.
 *
 * @param viewport - The frame's own box width (the frame tracks it).
 * @param panels - The live layout facts.
 * @param currentSession - The current session id (drawer closes on change).
 * @param actions - The layout store actions.
 * @returns The mobile flag the frame composes with and the drawer dismiss.
 */
export function useMobileRegime(
  viewport: number,
  panels: MobileRegimePanels,
  currentSession: string | undefined,
  actions: MobileRegimeActions,
): { readonly mobile: boolean; readonly closeDrawer: () => void } {
  const mobile = viewport < MOBILE_VIEWPORT
  useEffect(() => { actions.setMobile(mobile) }, [actions, mobile])
  const closeDrawer = useCallback(() => { actions.setDrawerOpen(false) }, [actions])
  // Live snapshot for the Escape handler (event-handler snapshot reads are
  // sanctioned; render keeps subscribing through its hooks).
  const panelsRef = useRef(panels)
  panelsRef.current = panels
  useEffect(() => {
    if (!mobile) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (panelsRef.current.drawerOpen) closeDrawer()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [closeDrawer, mobile])
  // A session change closes an open mobile drawer (the drawer lists sessions;
  // after selecting one the conversation must be unobstructed).
  const drawerSession = useRef(currentSession)
  useEffect(() => {
    if (drawerSession.current !== currentSession) {
      drawerSession.current = currentSession
      if (panelsRef.current.mobile && panelsRef.current.drawerOpen) closeDrawer()
    }
  }, [closeDrawer, currentSession])
  return { mobile, closeDrawer }
}

/** Drawer scrim + slid-out sidebar drawer + the frame-owned opener button. */
export function MobileNavChrome(props: {
  open: boolean
  onToggle: () => void
  onClose: () => void
  openLabel: string
  children: ReactNode
}): ReactNode {
  return (
    <>
      {/* Drawer scrim sits below the drawer, above column content. */}
      {props.open && <div className={css.scrim} onClick={props.onClose} />}
      {/* Always mounted so the sidebar subtree survives close (CSS slides). */}
      <div className={css.mobileDrawer} data-open={props.open || undefined}>
        {props.children}
      </div>
      {/* The drawer's own toggle lives inside the slid-out drawer, so a
          closed drawer needs a frame-owned opener — the only navigation
          entry in the mobile regime, present in every column phase
          (including the blank hero, which hides the session header). */}
      {!props.open && (
        <button
          type="button"
          className={css.mobileMenu}
          aria-label={props.openLabel}
          onClick={props.onToggle}
        >
          <IconPanelLeftOutlineRegular />
        </button>
      )}
    </>
  )
}
