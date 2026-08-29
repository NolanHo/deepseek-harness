# Agent Note: OnePlus 13 mobile UX pass — overflow, tap targets, portaled modals

Status: implemented

English | [中文](2026-08-27-oneplus-13-mobile-ux-pass.zh.md)

> Scope: a phone-viewport quality pass over the web client (target device OnePlus 13, 412×915 CSS viewport), verified round-trip in a real browser at that viewport. Builds on the [mobile shell regimes](2026-08-23-transcript-turn-fold-and-mobile-shell.md); no layout-regime or store changes.

## Problem

At a 412px viewport the conversation header crushed the session breadcrumb to 16px (its padding box) because header actions (`flex: none`) never gave way; the composer row and sidebar/workspace controls kept 28px desktop hit areas; the settings modal rendered inside the mobile drawer — the drawer is always mounted and transform-animated, so it becomes the containing block for `position: fixed` descendants and pinched the full-viewport modal to the 320px drawer; the job-badge popover anchored at the header's right edge extended past the viewport; and HoverCard (workspace-row preview/copy) was hover-only, unreachable on touch.

## Decision

**CSS breakpoint additions, one portal, one manifest line — no component rewrites.** The existing ≤560px/≤767.98px breakpoint vocabulary in `ui-conversation` gains the new rules; sibling packages each append their own ≤560px block:

- **Header squeeze priority**: the breadcrumb is the primary session identifier. `.crumbs` gets a 88px min-width floor at ≤560px; `.headerActions` becomes shrinkable (`flex: 0 1 auto`, `min-width: 0`, `overflow: hidden`) and slot mounts propagate the squeeze (`min-width: 0; max-width: 100%`); the agent-preset label collapses to its glyph at ≤560px (name in the title tooltip); the job badge trigger/count elide.
- **Thumb floors**: composer attach 36px, send 40px, select chips 32px, context meter 36px; goal pause/edit/clear 36px; sidebar/workspace standalone buttons 36px; session overflow rows and search strip 36px; settings/Modal close 36px; view tabs 35px; the frame's mobile drawer opener 40px. The ≤560px cut keeps the 28px desktop rhythm intact above it.
- **Settings modal portals to `document.body`** (`createPortal`; `react-dom` added to `ui-settings-general` devDependencies, matching `ui-primitives`): fixed overlays rendered inside the transformed drawer would otherwise pin to the drawer. At ≤560px the panel is full-screen with a 48px icon-only nav rail and a 36px close.
- **Job popover** becomes a fixed inset bottom panel at ≤560px (12px insets, above the composer).
- **HoverCard** gains a long-press path (`touchstart` dwell = hover delay, move/lift cancels; contextmenu suppressed while the card shows) and clamps its fixed card inside the viewport instead of unconditionally anchoring right of the wrapper.
- **Floating-chrome token fix (follow-up)**: the mobile drawer opener and the details sheet close were invisible — white glyph on the white light-theme floating fill, because they paired `--dsw-alias-button-floating-fill` with `--dsw-alias-label-primary-inverted` (the dark-surface pairing). Both now follow the desktop scroll-to-bottom button's pairing: `--dsw-alias-label-primary` glyph + `border-l2` hairline + `--dsw-shadow-lv2`; the sheet close also grew 24→32px. Verified in both themes: light = ink on white circle with hairline/shadow; dark = near-white glyph on the 850 fill.
- **Mobile trim (follow-up)**: phone chrome drops two desktop-only surfaces — the session-log export capsule in the header utilities (`display: none` ≤560px; the `/export` command and its shared dialog stay available) and the sidebar brand row's commit-hash badge (`display: none` ≤560px; developer telemetry, not user chrome). Workspace row drag-and-drop needs no change: HTML5 DnD never activates on touch, so the rows were already inert on phones.
- **Test contract**: `ui-workspace`'s browser-styles suite pins top-level CSS declaration values; its parser now skips `@media` bodies (balanced-brace scan) because breakpoint overrides are not the pinned contract.

## Consequences

- Desktop layouts are unchanged: every new rule sits under ≤560px (or ≤767.98px where the existing header clearance already applies) and the 1280px regression check shows no overflow.
- `ui-settings-general` now imports `react-dom`; its devDependencies (plus lockfile) gained `react-dom`/`@types/react-dom`. The client bundle keeps react/react-dom external to the shell, so no bundle-weight change.
- Consumers of `.headerActions` slot content that want their own un-shrinkable controls must opt out locally; the mobile squeeze is the shell's default.
- The job popover's mobile form is `position: fixed`, so a caller measuring it relative to the trigger must branch on the viewport.

## Alternatives considered

- **Portal-free settings fix via drawer `left` animation**: rejected — a layout-throttled animation replaces the compositor-friendly transform, and the drawer's `overflow: hidden` would still clip fixed descendants painted under a later stacking-context change.
- **Global `@media (hover: none)` hover suppression**: rejected — a blanket reset would fight every component's hover chrome; the one touch gap that matters (HoverCard) got a targeted long-press path instead.
- **Enlarging every control in place to 48px**: rejected — the composer row would wrap on 412px; 32–40px targets with the existing gap rhythm keep one line and stay thumb-operable.

## Verification

- Browser rounds at 412×915 against the live build: header crumb 16→88px, zero document overflow on hero/session/trajectory/settings surfaces, drawer/search/settings/menus exercised, long-draft composer growth, landscape 915×412, desktop 1280 regression.
- `pnpm vitest run` over the ten touched packages: 94 files / 1487 tests green (ui-workspace browser-styles parser updated in the same change).
- `tsc -b tsconfig.client.json` green; oxlint green on changed TS.
