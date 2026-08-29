# Agent Note: Turn Process fold with partial history and richer summary

Status: implemented

English | [中文](2026-08-29-turn-process-fold-with-partial-history.zh.md)

> Fork-local deviation from upstream's Turn Process fold (see [2026-08-14-web-turn-process-folding](2026-08-14-web-turn-process-folding.md) for the upstream decision).

## Problem

The upstream fold withheld the disclosure control and hid no members while any older history remained available (`historyIncomplete` gate). Real sessions almost always have more history than one page, so the fold effectively never appeared — closed turns rendered every intermediate Tool call and Assistant message inline. The fork's pre-merge fold had no such gate and additionally reported the Turn duration.

## Decision

- `ChatNodeSeat` no longer reads the `historyIncomplete` prop: `processWindowReady` and the process-layout key set drop the gate, so a closed Turn folds by default even when `hasMore` is true. `ChatView` stops passing the prop.
- `TurnProcessNodeView` gains the Turn wall-clock duration (resolved from the Turn location's `turn/start` and `turn/end` edges) and a collapsed-prefix label (`Collapsed {counts}` / `已折叠 {counts}`); the zero-count fallback keeps `Thought for a while` and appends the duration when available. The control restyles from a full-width divider into a rounded pill.
- Tests: the two partial-history fold tests now assert the fold applies; label assertions cover the prefix and duration segments; the chat-scroll anchor test's page cap accommodates the 8-message page size.

## Consequences

- Closed turns fold by default regardless of remaining history; partial pages show the pill control and the fold is stable from the first render of a page (paired with the turn-complete boundary work).
- Turn duration and the collapsed-prefix label ride the location data the client already derives; no extra events.

## Alternatives considered

- **Keep the `historyIncomplete` gate**: the gate contradicted paging — a served page is by construction partial, so the fold would only appear on short sessions.
- **Fold only on explicit user action**: intermediate Tool/Assistant rows still dominated every long session's default view.


## Verification

`pnpm run test:gui` green; seeded-history goldens refreshed; chat-scroll-contract anchor test green with the raised page cap.
