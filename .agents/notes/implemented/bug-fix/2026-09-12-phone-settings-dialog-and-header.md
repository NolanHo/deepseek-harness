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

The conversation header's phone blocks keep the 56px leading pad that clears the drawer opener and reserve the same top safe-area inset the opener's fixed `top` carries (`padding-top: calc(10px + env(safe-area-inset-top))` at ≤767.98px, folded into the 560px `padding` shorthand): without it a 34px status-bar inset dropped the fixed button 33px below the title row while the title painted under the system bar. The blocks then give the title row what the trailing controls leave: `.crumbs` stays visible with no width floor, the count-only chips hold their intrinsic width with each `.countCompact` keeping its number on one line (`white-space: nowrap`, because a squeezed count otherwise breaks inside its digits and the stacked count paints over the trailing controls), `.headerActions` keeps its content width (`flex: 0 0 auto`) without clipping, because the job badge's menu is absolutely positioned inside that box, and `.headerCorner` resets `margin-right` to 0 so the corner control lands 12px inside the viewport, matching desktop. The phone row then carries a metadata budget: below 560px the lineage chip and the job badge each render their count alone, with the localized label hidden but kept as the trigger's accessible name, so the title takes the width the two labels used to spend (measured at 412×915 on a 9-subagent mint session: title 88 → 172px, lineage chip 108 → 35px). The session-header agent-preset label renders nothing below 560px: it is static context with no control, its glyph is the same for every preset, and its `title` carries the preset description rather than the name, so a capped chip would show neither (`display: none` on `.label`). The lineage chip stays: for a subagent session it carries that session's own title, and it is the only phone entry point into the subagent catalog. The session title's breadcrumb absorbs the row deficit and truncates through `.crumb`'s ellipsis.

## Alternatives considered

**Keep the overlay in place and widen the drawer.** The drawer's `overflow: hidden` still clips `position: fixed` descendants, and a viewport-wide drawer is no longer a drawer.

**Animate the drawer with `inset-inline-start` instead of `transform`.** It removes the containing block for this one case while making every drawer frame a layout pass, and the shell's `transform` transition is what the sidebar-right panel probe observes.

**CSS-only phone variant without the portal.** The dialog then fills the drawer instead of the viewport: the mask stays drawer-scoped, the page behind stays interactive, and the desktop dialog keeps the wrong containing block.

**Keep the breadcrumb hidden on phones.** The drawer names Sessions, but the header is the only in-context label; a truncating title plus a content-width action cluster fits at 360px.

**Keep the ellipsized count labels instead of bare counts.** That was this note's first choice, because a count-only chip would have needed a locale key and a viewport-aware label; the 2026-09-22 phone-header pass replaced it — the component renders the count in its own span and the phone block hides the label, which is CSS-only, and the words were the widest part of both chips.

**Hide the lineage chip at phone widths.** For a normal session it is the largest metadata, but for a subagent session the same slot renders that session's own title, and it is also the only phone path into the subagent catalog: the drawer tree and session search filter subagent children out, so hiding it deletes both a title and a capability.

**Keep the lineage chip and let the title clip to two characters.** The title is the session's only in-context identity, and that state is the defect this change removes.

## Consequences

The settings modal's layer is viewport-relative at every width and its phone presentation is one full-width column that neither wraps nor clips its controls. The conversation header gives the session title the row's leftover width on phones, keeps its trailing controls inside the viewport, and holds its 30px row while background jobs run: the badge shows its count alone on phones, never wraps, and its menu stays unclipped.

The portal moves the dialog out of the sidebar subtree, so a selector or query that relied on that DOM proximity must reach the dialog from the document root; the dialog's markup, roles, focus handling, and slot rendering are unchanged. Because the layer is a child of `document.body`, it sits outside the `#root` that onboarding marks `inert`: the settings trigger is inside `#root`, so the dialog stays unreachable while onboarding runs, and the onboarding surface (z-index 1100) paints above the dialog (z-index 1000) if both are open.

The phone header spends its width in this order: session title, lineage chip, job badge. Below 560px the lineage chip and the job badge show their counts alone and stay fully tappable, and a subagent session's own title still renders in the chip's `switcher` variant. The preset label is absent from the phone header, so Settings is the surface that names the preset (the new-session seat degrades to its icon when its own label has no room). The actions box still does not clip, so the badge's menu stays reachable at every width; at 360px the badge keeps its one-number count and its trigger stays operable. When the badge band alone is wider than the row — about four badges at ≤411px, or three at ≤360px — the chips can still reach into the trailing controls: CSS cannot drop a chip as a unit, and the title is already at zero width there.

The top safe-area reservation the header shares with the drawer opener, the 560px breakpoint, and the 36px thumb floor join the fork's phone vocabulary; the fork's client CSS breakpoints remain 560px and 767.98px. The 2026-08-27 mobile pass recorded in `FORK_CHANGES.md` describes rules that are absent from the tree at this revision, so this note — not that record — carries the phone header and settings-dialog rules that ship.

## Testing

`settings-root.client.spec.tsx` opens the dialog and asserts the modal layer's parent is `document.body`, that the trigger subtree does not contain it, and that the dialog keeps `role="dialog"`, `aria-modal="true"`, and its slot-provided accessible name. CSS-contract specs parse the media blocks with a brace-balanced extractor and pin the phone declarations: `settings-root-phone-styles.client.spec.ts` (full-screen panel, horizontal rail, 36px close), `header-phone-styles.client.spec.ts` (the breadcrumb absorbing the row deficit with no width floor, the top safe-area padding in both phone blocks, content-width non-clipping actions, corner margin, and a guard that no phone rule hides the lineage slot), `job-list-action-phone-styles.client.spec.ts` (the count-only span and its phone toggles, the one-line count, the trigger width bound, shrinkable non-clipping badge boxes), `subagent-header-lineage-phone-styles.client.spec.ts` (the same count-only and one-line contract for the lineage chip, plus a guard that no phone rule hides the `switcher` title) and `agent-preset-label-phone-styles.client.spec.ts` (the label renders nothing at phone widths). The live check runs a second dsh instance at 412×915 against the rebuilt client bundles, with the top safe-area inset emulated through the DevTools protocol.
