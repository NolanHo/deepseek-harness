# Agent Note: Phone settings dialog and conversation header

Status: implemented

English | [中文](2026-09-12-phone-settings-dialog-and-header.zh.md)

> Scope: the two defects that make the settings dialog unusable and clip the session header at phone widths (≤560px CSS pixels), and the fork rules that fix them. The [ui-settings-general](../../../../packages/client/ui-settings-general/README.md) and [ui-conversation](../../../../packages/client/ui-conversation/README.md) READMEs own their packages' contracts; [the mobile shell note](../architecture/2026-08-23-transcript-turn-fold-and-mobile-shell.md) owns the phone regime.

## Problem

At a 412×905 CSS-pixel phone viewport (OnePlus 13: 1440×3168 at DPR 3.5), opening Settings rendered the modal layer inside ui-layout's mobile drawer. The drawer is `position: fixed` and carries `transform: translate(0)` while open, and a non-none transform makes an element the containing block for its `position: fixed` descendants, so the layer's `inset: 0` resolved to the 320px drawer instead of the viewport. Measured with the drawer open: overlay 319×905, panel 319 wide, nav rail 188, content column 131 — every content label wrapped to one or two words, the panel's `overflow: hidden` clipped the trailing controls, the close button shrank to 16×28, the panel centered itself in the drawer rather than the viewport, and the mask covered only the drawer, leaving the page behind the "modal" interactive.

The same header grows to 78px on a session with background jobs: the job badge's label ("9 background jobs") wraps inside the shrunken actions box into a four-line column, the lineage chip and the preset chip clip mid-word, and the session title is left two characters. The row re-wraps whenever a job starts or finishes, so the header height keeps moving while work runs.

The conversation header overflowed by a constant 4px at every phone width. `.headerCorner` carries `margin-right: -16px` so the corner control reaches into the desktop header's 28px right padding (28 − 16 = 12px inside the viewport), while the fork's ≤560px block set that padding to 12px (12 − 16 = 4px past the viewport). The same block hid the session breadcrumb with `display: none`, leaving the title row with only the agent-preset chip.

## Decision

The settings modal layer mounts under `document.body` through a fork-owned portal (`packages/client/ui-settings-general/src/client/fork/portal.tsx`), injected as one marked import at the module top plus one marked wrap at the `SettingsPanel` call site in `SettingsRoot`, leaving the panel's own body unchanged. `react-dom` and `@types/react-dom` join the package's devDependencies, matching ui-primitives' declaration, because the client bundle treats them as platform externals.

Below 560px the Settings panel fills the viewport as a single column (`width`/`height` 100%, `max-width`/`max-height` 100%, `border-radius: 0`, `flex-direction: column`): the nav rail becomes a row that pins its title and scrolls its cells horizontally, the close control grows to the 36px thumb floor, and the nav and options carry `env(safe-area-inset-*)` padding.

The conversation header's phone block keeps the 56px leading pad that clears the drawer opener and gives the title row what the trailing controls leave: `.crumbs` stays visible with an 88px floor and truncates through `.crumb`'s existing ellipsis, `.headerActions` shrinks (`flex: 0 1 auto`, `min-width: 0`) so its own child gives way — the job trigger narrows — without clipping, because the job badge's menu is absolutely positioned inside that box, and `.headerCorner` resets `margin-right` to 0 so the corner control lands 12px inside the viewport, matching desktop. The phone row then carries a metadata budget. The session-header agent-preset label renders nothing below 560px: it is static context with no control, its glyph is the same for every preset, and its `title` carries the preset description rather than the name, so a capped chip would show neither (`display: none` on `.label`). The job badge keeps its count on one line and ellipsizes (`white-space: nowrap` with `text-overflow: ellipsis` on the count, plus a `max-width: 100%` bound on the trigger, whose inline-flex shrink-to-fit would otherwise overflow the row instead of narrowing). The lineage chip stays: for a subagent session it carries that session's own title, and it is the only phone entry point into the subagent catalog. The session title keeps its 88px floor and takes what is left.

## Alternatives considered

**Keep the overlay in place and widen the drawer.** The drawer's `overflow: hidden` still clips `position: fixed` descendants, and a viewport-wide drawer is no longer a drawer.

**Animate the drawer with `inset-inline-start` instead of `transform`.** It removes the containing block for this one case while making every drawer frame a layout pass, and the shell's `transform` transition is what the sidebar-right panel probe observes.

**CSS-only phone variant without the portal.** The dialog then fills the drawer instead of the viewport: the mask stays drawer-scoped, the page behind stays interactive, and the desktop dialog keeps the wrong containing block.

**Keep the breadcrumb hidden on phones.** The drawer names Sessions, but the header is the only in-context label; the 88px floor plus a shrinking action cluster fits at 360px.

**Compact the job badge to a bare count.** A count-only chip needs a locale key and a viewport-aware label, which client CSS cannot express; the nowrap label keeps the count readable and the same trigger opens the full list.

**Hide the lineage chip at phone widths.** For a normal session it is the largest metadata, but for a subagent session the same slot renders that session's own title, and it is also the only phone path into the subagent catalog: the drawer tree and session search filter subagent children out, so hiding it deletes both a title and a capability.

**Keep the lineage chip and let the title clip to two characters.** The title is the session's only in-context identity, and that state is the defect this change removes.

## Consequences

The settings modal's layer is viewport-relative at every width and its phone presentation is one full-width column that neither wraps nor clips its controls. The conversation header shows a truncated session title on phones, keeps its trailing controls inside the viewport, and holds its 30px row while background jobs run: the badge neither wraps nor grows the header, and its menu stays unclipped.

The portal moves the dialog out of the sidebar subtree, so a selector or query that relied on that DOM proximity must reach the dialog from the document root; the dialog's markup, roles, focus handling, and slot rendering are unchanged. Because the layer is a child of `document.body`, it sits outside the `#root` that onboarding marks `inert`: the settings trigger is inside `#root`, so the dialog stays unreachable while onboarding runs, and the onboarding surface (z-index 1100) paints above the dialog (z-index 1000) if both are open.

The phone header spends its width in this order: session title, lineage chip, job badge. Below 560px the lineage chip can be clipped by the breadcrumbs box, but its visible part stays tappable, and a subagent session's own title still renders in it. The preset label is absent from the phone header, so Settings is the surface that names the preset (the new-session seat degrades to its icon when its own label has no room). The actions box still does not clip, so the badge's menu stays reachable at every width; at 360px the badge's count ellipsizes and its trigger stays operable.

The literal 88px floor, the 560px breakpoint, and the 36px thumb floor join the fork's phone vocabulary; the fork's client CSS breakpoints remain 560px and 767.98px. The 2026-08-27 mobile pass recorded in `FORK_CHANGES.md` describes rules that are absent from the tree at this revision, so this note — not that record — carries the phone header and settings-dialog rules that ship.

## Testing

`settings-root.client.spec.tsx` opens the dialog and asserts the modal layer's parent is `document.body`, that the trigger subtree does not contain it, and that the dialog keeps `role="dialog"`, `aria-modal="true"`, and its slot-provided accessible name. CSS-contract specs parse the media blocks with a brace-balanced extractor and pin the phone declarations: `settings-root-phone-styles.client.spec.ts` (full-screen panel, horizontal rail, 36px close), `header-phone-styles.client.spec.ts` (breadcrumb floor, non-clipping actions, corner margin, header padding, and a guard that no phone rule hides the lineage slot), `job-list-action-phone-styles.client.spec.ts` (count nowrap and ellipsis, the trigger width bound that makes the ellipsis engage, shrinkable non-clipping badge boxes) and `agent-preset-label-phone-styles.client.spec.ts` (the label renders nothing at phone widths). The live check runs a second dsh instance at 412×905 on port 3099 against the rebuilt client bundles.
