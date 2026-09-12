# Agent Note: Turn Process fold with partial history

Status: implemented

English | [中文](2026-08-29-turn-process-fold-with-partial-history.zh.md)

> Fork-local deviation from upstream's Turn Process fold (see [2026-08-14-web-turn-process-folding](2026-08-14-web-turn-process-folding.md) for the upstream decision).

## Problem

The upstream fold withholds the disclosure control and hides no members while any older history remains available (`historyIncomplete` gate in `ChatNodeSeat.processWindowReady`). A served page is partial by construction (`PAGE_MESSAGES = 8` in `session.ts`), so real sessions keep `hasMore` true and the fold never appears — a closed Turn renders every intermediate Tool call, Context row, and Assistant message inline.

## Decision

- `ChatNodeSeat` neither declares nor reads `historyIncomplete`: `processWindowReady` drops the gate, so a closed Turn folds by default even when `hasMore` is true. `ChatView` stops passing the prop. The injection point carries the `// Fork patch (FORK_SURFACE.md)` marker, and the row is registered in [FORK_SURFACE.md](../../../FORK_SURFACE.md).
- The disclosure label and the Turn duration are upstream's inline form: the fork's counted collapsed prefix and wall-clock duration retired to it, and the duration stays visible in the turn footer's usage details.
- Tests: `folds a closed Turn even while history is partial` and `folds final-page groups while history is partial` assert the fold applies with `hasMore` true and survives the flip back.

## Consequences

- Closed turns fold by default regardless of remaining history; partial pages show the disclosure control, and the fold is stable from the page's first render.
- The served page is turn-aligned (`session-controller/src/fork/page-boundary.ts` widens upstream's cut to the owning Turn's opening events), so a folded span is one whole Turn and the control's counts cover every member it hides.
- Nothing else changes: the hidden members are the rows the loaded page carries.

## Alternatives considered

- **Keep the `historyIncomplete` gate**: the gate contradicted paging — a served page is by construction partial, so the fold would only appear on short sessions.
- **Fold only on explicit user action**: intermediate Tool/Assistant rows still dominated every long session's default view.

## Verification

`pnpm run test:gui`; without the change `folds a closed Turn even while history is partial` fails with `TypeError: Cannot read properties of null (reading 'getAttribute')` and `folds final-page groups while history is partial` with `expected null not to be null`; both pass with it. The recorded web goldens the replay lane compares are refreshed, and `pnpm run typecheck` is clean.
