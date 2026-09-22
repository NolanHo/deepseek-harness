# Agent Note: Phone drawer settings seat — the entry moves into the brand row

Status: implemented

English | [中文](2026-09-22-phone-drawer-settings-seat.zh.md)

> Scope: where the web client's Settings entry sits inside the fork's phone drawer (below the 768px `MOBILE_VIEWPORT` breakpoint). [The mobile shell note](../architecture/2026-08-23-transcript-turn-fold-and-mobile-shell.md) owns the phone regime, [the phone settings dialog note](../bug-fix/2026-09-12-phone-settings-dialog-and-header.md) owns the dialog and the conversation header, and the [ui-sidebar](../../../../packages/client/ui-sidebar/README.md) and [ui-layout](../../../../packages/client/ui-layout/README.md) READMEs own their packages' contracts.

## Problem

In the phone drawer the Settings entry was the last row of the sidebar column: a 42px full-width row pinned to the bottom of the 300px overlay, with nothing between it and the scrolling session list. At 412×915 that row sits where a thumb rests while scrolling the list, so a scroll or a session tap that lands there opens Settings instead of the intended target. The desktop sidebar keeps its foot placement; the mis-tap belongs to the drawer regime.

## Decision

The frame reports the drawer regime to the sidebar occupant, and the settings seat moves with that report.

`SidebarOwnerProps` gains a required `mobile: boolean`. AppFrame sets it `true` in the drawer branch (`{ collapsed: false, width: DRAWER_WIDTH, mobile: true }`) and `false` for the desktop column. `SidebarRoot` renders the `sidebar.settings` seat in the brand row directly after the brand while `mobile` is true, and passes the compact owner share `{ wide: false }` so the registrant renders its icon-only trigger; the foot then holds only `sidebar.footer.action`. The drawer's brand row packs from the leading edge (`.drawerLogoRow`), the brand stops growing (`flex: 0 1 auto`), and the toggle keeps the trailing edge (`margin-left: auto`), so the seat lands beside the brand rather than at the row's far end and the blank beside the brand is not a New Session target. Outside the drawer the markup, owner shares, and CSS are unchanged.

The seat renders exactly once in both regimes. The settings modal keeps its fork portal, so opening it from the brand row still mounts the layer under `document.body`.

## Alternatives considered

**Mount a second trigger in the brand row beside the existing foot seat.** The `sidebar.settings` slot is `single`, and each mount carries its own dialog state, so two triggers would mount two dialog instances; the foot row — the surface that produces the mis-tap — would also stay.

**Move the seat into the brand row at every width.** Rejected: it changes a desktop sidebar no one reported, and the collapsed rail has no room for a second control in its 36px row (the rail's logo row is a single toggle button).

**Let the sidebar read the viewport itself (a media query) and decide.** Rejected: the frame owns the breakpoint through `useMobileRegime`, and client business components read no external state of their own.

**Place the seat at the trailing edge of the brand row, immediately before the drawer toggle.** Rejected: it puts a settings target next to the drawer's close control, which trades one mis-tap for another; the leading position also matches the request that placed the entry right of the logo.

**Keep a connection control in the drawer by rendering the seat twice or by moving the indicator into the footer-action seat.** Rejected for now: it needs a second registration plus a placement contract for the indicator, and the wide foot seat already owns that control on desktop (see Consequences).

## Consequences

- On phones the Settings entry is a compact icon beside the brand, and the drawer's foot holds only footer actions: the end of the session list no longer neighbours a settings row.
- Footer actions still stack at the drawer's foot: an active dynamic-plugin panel (`ui-cordis`) renders its own full-width 42px row there, so the foot keeps that row shape for other controls while no settings entry sits in it.
- The phone drawer loses the connection control, both the status pill and its manual reconnect action; automatic reconnection continues. The indicator belongs to the wide seat — `SettingsRoot` renders `<ConnectionIndicator state={wide ? connectionState : undefined}>` — so the compact drawer seat shows no disconnected, reconnecting, or connected pill, and the drawer's only connection-status surface disappears below the breakpoint. The expanded desktop column keeps it; the collapsed rail's compact seat never carried it (its own spec pins that absence). Restoring a phone surface means a second, smaller connection presentation (a footer-action contribution), not a wider brand row.
- The blank beside the brand is no longer part of the New Session button, because the brand stops growing in the drawer row.
- `SidebarOwnerProps` is the `sidebar` slot's public owner share: a replacement occupant must accept `mobile`. The generated client slot catalog embeds the declaration text and is regenerated in the same change.

## Testing

- `packages/client/ui-layout/tests/app-frame.client.spec.tsx` pins the hand-off (`mobile: true` in the drawer; `false` for the desktop column and after crossing back above the breakpoint) and the required field at typecheck time (`expectTypeOf<SidebarOwnerProps['mobile']>()`).
- `packages/client/ui-sidebar/tests/sidebar-root.client.spec.tsx` pins the placement: exactly one seat, a sibling of the column toggle directly after the brand button and before the toggle in document order, owner `{ wide: false }`; and the desktop regime's foot seat with `{ wide: true }` outside the brand row. `sidebar-styles.client.spec.ts` pins the drawer row's declarations: leading-edge packing, a brand that no longer grows, and the trailing toggle. The committed `sidebar-snapshot` DOM snapshots are unchanged, because they render the non-drawer regime (`mobile: false`).
- `pnpm exec vitest run packages/client/ui-layout packages/client/ui-sidebar` (the path filter also collects the sibling sidebar packages): 61 files / 600 tests green. `pnpm run test:gui` is green apart from two `ui-tool` failures that fail identically on unmodified master (recorded in the change handoff).
- Browser round at 412×915 against a second `dsh web` instance on port 3097 (own `DSH_HOME`, no production session database) over the rebuilt bundles: drawer open through the frame opener, close through the scrim and Escape, Settings opened from the brand-row icon, and the desktop 1280px column plus the collapsed rail checked for the unchanged foot placement.
