// Fork-owned settings-modal portal (see FORK_SURFACE.md): SettingsRoot's marked
// injection wraps the panel in this layer so the phone drawer's transform cannot
// become the modal's containing block.

/**
 * Settings modal mount point. The trigger lives in ui-layout's sidebar, which
 * on phones renders inside the transform-animated mobile drawer; a non-none
 * transform makes that drawer the containing block for `position: fixed`
 * descendants, so the modal layer's `inset: 0` resolved to the 320px drawer
 * instead of the viewport: the mask covered only the drawer, the panel was
 * pinned to the drawer's width (188px nav + a 131px content column), and the
 * page behind the "modal" stayed interactive. Mounting the layer under
 * `document.body` restores the viewport as its containing block.
 */
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Render the settings modal layer under `document.body`.
 * @param props - portal props.
 * @param props.children - the modal layer's element tree.
 * @returns the layer mounted at the document root.
 */
export function SettingsPortal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body)
}
