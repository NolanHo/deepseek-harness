// Fork-owned mobile shell (see FORK_SURFACE.md): the mobile regime's
// composition pieces — the drawer regime hook, the drawer chrome, and the
// details sheet column — extracted from upstream's AppFrame so the frame
// keeps only the composition branches. Pure components and one hook over
// framework-shared props; no self-made hooks beyond this module.

import { useCallback, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { IconPanelLeftOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { MOBILE_VIEWPORT } from '../columns.ts'
import css from '../AppFrame.module.css'

/** Owner-prop width fed to the sidebar occupant inside the mobile drawer (inside the sidebar contract range). */
export const DRAWER_WIDTH = 300

/** The layout store's action surface the mobile regime drives. */
export interface MobileRegimeActions {
  setMobile(mobile: boolean): void
  setDrawerOpen(open: boolean): void
  toggleSidebar(): void
  closeDetails(): void
}

/** The live panels snapshot the regime reads (render subscriptions stay in the frame). */
export interface MobileRegimePanels {
  drawerOpen: boolean
  details: number
  mobile: boolean
}

/**
 * The mobile regime's reactive decisions over the frame's viewport: the
 * mobile flag (mirrored into the store), Escape closing the highest open
 * layer (sheet above drawer), an open drawer closing on session change, the
 * mobile details-sheet visibility, and the drawer dismiss.
 *
 * @param viewport - The frame's own box width (the frame tracks it).
 * @param panels - The live panel state.
 * @param currentSession - The current session id (drawer closes on change).
 * @param detailsSession - The session gating the details sheet, or undefined.
 * @param actions - The layout store actions.
 * @param desktopDetailsOpen - The solved desktop details visibility (the
 * frame's column solver answers it; mobile gates on the sheet state).
 * @returns The regime facts the frame composes with.
 */
export function useMobileRegime(
  viewport: number,
  panels: MobileRegimePanels,
  currentSession: string | undefined,
  detailsSession: string | undefined,
  actions: MobileRegimeActions,
  desktopDetailsOpen: boolean,
): { readonly mobile: boolean; readonly detailsOpen: boolean; readonly closeDrawer: () => void } {
  const mobile = viewport < MOBILE_VIEWPORT
  useEffect(() => { actions.setMobile(mobile) }, [actions, mobile])
  const closeDrawer = useCallback(() => { actions.setDrawerOpen(false) }, [actions])
  // Live snapshots for the Escape handler (event-handler snapshot reads are
  // sanctioned; render keeps subscribing through its hooks).
  const panelsRef = useRef(panels)
  panelsRef.current = panels
  const detailsSessionRef = useRef(detailsSession)
  detailsSessionRef.current = detailsSession
  // Escape closes the highest open mobile layer first (sheet above drawer).
  // The sheet gate matches its render visibility (detailsSession defined):
  // a retained preference without a visible sheet must not swallow a press.
  useEffect(() => {
    if (!mobile) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const now = panelsRef.current
      if (now.details > 0 && detailsSessionRef.current !== undefined) actions.closeDetails()
      else if (now.drawerOpen) closeDrawer()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [actions, closeDrawer, mobile])
  // A session change closes an open mobile drawer (the drawer lists sessions;
  // after selecting one the conversation must be unobstructed).
  const drawerSession = useRef(currentSession)
  useEffect(() => {
    if (drawerSession.current !== currentSession) {
      drawerSession.current = currentSession
      if (panelsRef.current.mobile && panelsRef.current.drawerOpen) closeDrawer()
    }
  }, [closeDrawer, currentSession])
  const detailsOpen = mobile
    ? panels.details > 0 && detailsSession !== undefined
    : desktopDetailsOpen
  return { mobile, detailsOpen, closeDrawer }
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
          <IconPanelLeftOutline16 />
        </button>
      )}
    </>
  )
}

/** Details column grid item; width 0 keeps the subtree mounted (never unmount on close). */
export function DetailsColumn(props: {
  children?: ReactNode
  mobile?: boolean
  open?: boolean
  onClose?: () => void
  closeLabel?: string
}): ReactNode {
  return (
    <div
      className={css.detailsCol}
      data-mobile={props.mobile || undefined}
      data-open={props.open || undefined}
    >
      {props.mobile && (
        /* Sheet chrome owned by the frame: occupants assume the desktop shell,
           so the sheet's explicit close affordance lives here. */
        <button type="button" className={css.sheetClose} aria-label={props.closeLabel} onClick={props.onClose} />
      )}
      {props.children}
    </div>
  )
}
