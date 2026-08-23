# Agent Note: Transcript turn fold and mobile shell regimes

Status: implemented

English | [中文](2026-08-23-transcript-turn-fold-and-mobile-shell.zh.md)

> Scope: two product-user-visible GUI behaviors in the web client — the settled-turn fold in the chat transcript (`ui-conversation`) and the three-regime viewport layout with mobile sidebar drawer and details sheet (`ui-layout`, `apps/web`). The [slot system standard](2026-07-22-slot-type-chain-implementation.md) and [web client architecture](2026-07-19-gui-web-client-architecture.md) own the surrounding composition model; this note records the two view-layer decisions that sit on top of it.

## Problem

Long agent turns bury the final answer under screens of tool calls and intermediate narration; readers want the process collapsed to one row and opened on demand. The grouping needs a seam: the transcript is assembled inside ChatView's ordered row list, and no slot exists between "whole view tab" (`conversation.view`, a list of tabs) and "one row" (`conversation.chat.node`, keyed per kind) — a per-row plugin shadow cannot wrap a consecutive span in one container, so an external plugin cannot express "fold everything between the user's message and the closing answer".

The desktop shell also assumed pointer-and-width abundance: the concession solver always reserves a ≥56px sidebar rail, so a 412px phone viewport leaves the conversation column starved, and `openDetails` silently no-ops below ~1000px because the solver zeroes the third column. Mobile adaptation needs regime semantics the pure-width solver deliberately does not own.

## Decision

**Turn fold is a render-time view grouping, not a projection change.** A pure pre-pass (`turn-fold.ts`) walks `order` and groups consecutive rows by `location.turn`; a turn folds exactly when the timeline reports it settled AND its `turn-tail` carries a `closing` answer. Foldable rows are everything except user/steering, the closing `assistant-step` (matched by `finalNode.seq`), `turn-tail`, and error rows. Collapsed rows leave the DOM entirely (not hidden), the fold header carries the first hidden row's anchor key, and expanded state is ChatView-local (`useState` Set) — deliberately not a store: it is per-reading-session view state, not shared across entries and not worth surviving remount. Running turns and turns without a closing answer render byte-identically to the pre-fold path. No new Chat Node kind, no Session change: the Conversation Node discipline keeps the append hot path unscanned, and the fold appears automatically when the timeline republishes on turn settlement.

**The shell owns three viewport regimes; the solver stays breakpoint-free.** `MOBILE_VIEWPORT = 768` (below SIDEBAR_AUTO_COLLAPSE's 1024 rail regime) decides in AppFrame: mobile skips the concession solver (`0 minmax(0,1fr) 0`), renders the sidebar inside an always-mounted fixed drawer (scrim tap, Escape, and session-change close it), and renders the details column as a fixed right sheet with frame-owned close chrome — restoring `openDetails` at mobile widths. The regime flag and drawer-open flag live in the existing layout store; `toggleSidebar` is mobile-first (drawer flip) before the narrow (rail re-expand) branch, so every existing caller (ui-sidebar's injected face) gets mobile semantics without service-surface changes. Crossing either breakpoint resets the transient regime-local flag; width preferences always survive. Drag handles do not render on mobile.

Conversation-column narrow CSS (header/tabs/transcript padding at ≤560px, composer `env(safe-area-inset-bottom)`) and the viewport meta (`viewport-fit=cover`, `interactive-widget=resizes-content`) complete the phone pass. The fold deliberately ships collapsed-by-default on every mount: process rows are re-derivable from the log, and the summary row (tool count, intermediate reply count, turn duration) is the reading affordance.

## Consequences

- Fold state is ChatView-local and resets on view-tab switch or remount: a deliberate trade — persistence would need a store seat (per-session, cross-entry) whose only consumer is this one component. Revisit if fold state must survive view switches.
- Folded rows are absent from the DOM, so transcript aria goldens and any consumer that counts `[data-chat-flow-kind]` rows sees only visible rows; browser e2e specs that assert tool-call row presence after turn settlement must first expand the fold (or assert the fold header). Existing goldens were refreshed accordingly.
- A plugin wanting its own rows exempt from the fold (e.g. a future inline deliverable card) cannot opt out: foldability is closed over Chat kinds in the view pre-pass. Exempting requires a contract change in `chat-nodes.ts` plus this note's update — do not special-case by registrant.
- The mobile drawer and details sheet are frame-owned chrome: occupants (ui-sidebar, details entries) render unaware of the regime. Anything that positions itself against the grid columns (a future third fixed panel) must read the regime from the store or owner props, not assume grid tracks.
- `toggleSidebar` is now regime-dependent: a caller cannot force a specific column outcome, only the user-intent toggle. Explicit open/close control remains `openDetails`/`closeDetails`; a drawer-specific service face was deliberately not added.

## Alternatives considered

- **Fold as a Chat Node kind** (projection folds the span into one node): rejected — it would put view presentation into the session projection, violating the web-layer discipline that "how to draw" never enters the session log, and it would fight replay recomputation.
- **Per-row fold via plugin shadowing `conversation.chat.node` renderers**: rejected — each row folds independently; a contiguous-span group container is unreachable from per-kind renderers without a row-group seam, which the spec explicitly declined to add for this feature.
- **Row-group slot extension point** (new `conversation.chat.rowGroup` wrapper slot, fold as a plugin): deferred — a wrapper slot adds a composition seam whose only current consumer is the fold; KISS wins until a second grouping consumer exists.
- **Mobile layout as pure CSS overlay of the existing grid**: rejected — grid track widths are JS-computed inline; CSS cannot reflow them, and drawer open/close is state that scrimp/Escape/session-change must mutate, which belongs in the layout store.
- **CSS-only details sheet** (like TrajectoryTable's 760px overlay): rejected for the shell column — the solver zeroes the third track before CSS sees it, and `openDetails` semantics must stay meaningful on mobile.

## Verification

- `pnpm run test:gui` green (285 files); package suites: `ui-conversation` 30 files/488 tests with 7 new fold specs (collapse/counts, expand/re-collapse, running turn, no-closing, generic label, duration-less, settle auto-fold), `ui-layout` + `ui-sidebar` 13 files/95 tests with the mobile suite (grid collapse, drawer open/close via toggle/scrim, sheet open/close, Escape layering, session-change close, breakpoint crossing).
- `pnpm run typecheck` green after integrator fixes (test-only: typed SessionProvider stub, completed store-actions mock).
- Browser snapshot replay run on the assembled build; transcript goldens refreshed for the fold's visible output change.
