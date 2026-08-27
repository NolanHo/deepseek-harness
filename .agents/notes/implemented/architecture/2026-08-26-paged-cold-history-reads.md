# Agent Note: Paged cold history reads over the persistence `readFrom` seam

Status: implemented

English | [中文](2026-08-26-paged-cold-history-reads.zh.md)

> Scope: how the web `session.history` RPC reads detached (cold) sessions — suffix-window `readFrom` reads with a widening loop, turn-aligned page cuts, the projection-cache cold ladder for tail-page baselines, and the full-inspection fallback for repair-ambiguous tails. The persistence seam's [`readFrom`](../../docs/subsystems/session.md) primitive and the projection cache's `coldSnapshot` ladder are the building blocks this note composes.

## Problem

Opening a large session in the web GUI paid a full-log rebuild on every cold read: the history handler ran `inspect()` — read the whole artifact, JSON-parse and chunk-expand every row, replay all events through the Session fold, and synthesize interrupted-turn closers — then sliced one page in memory. Measured on an 812k-event session: ~1.1s on the JSONL backend, ~820ms on SQLite, while the served page holds only ~50 turns. The SQLite provider already implements the seek-capable `loadStoredFrom` hook and the projection cache already exposes the zero-full-log `coldSnapshot` ladder; the handler simply never used them.

## Decision

**Cold history reads are paged suffix reads with a widening loop.** `detachedHistoryRead` in the api proxy resolves the session's header through `persistence.list()` (mapping an absent session to `session-not-found`), picks a first window (`fromSeq`) anchored at the projection cache's stored watermark minus `maxMessages × 256` events (tail pages) or at `beforeSeq` minus the same estimate (loadOlder pages) — kept small because `readFrom` scales ~linearly with the window on the production store (decode is CPU-bound; there is no cheap within-page plateau to spend headroom on) — and loops: `readFrom(id, fromSeq)` → `paginate` → if the page cut provably lands inside the suffix (`cut >= fromSeq`) and the window holds at least `maxMessages` user messages, serve; otherwise re-estimate `fromSeq` from the suffix's observed events-per-user-message density (doubled as headroom; a suffix without any user message yields no sample and halves instead) and re-read. `fromSeq === 0` is exact by construction, so the loop always terminates; the worst case is today's full read. A non-seek backend (JSONL) degrades inside the coordinator (`readFrom` falls back to full prefix + skip), never below today's behavior.

**Pages cut at user messages only.** `paginate` counts `user/message` boundaries (falling back to `assistant/message` for synthetic logs without one), so one page = whole turns: the cut lands at the user's question and the page carries that turn's complete tool/assistant content — never sliced mid-turn or mid-answer. The previous behavior counted both message kinds and could cut between a user message and its own answer. `maxMessages` now means "user messages per page" (50 by default = 50 turns).

**Two conservatively guarded fallbacks keep every page exact.** (1) `needsRepairTail` scans the suffix's last turn boundary: a tail ending in `turn/start` — or a window with no turn boundary at all, which cannot prove cleanliness — falls back to full `inspect()`, the only path that synthesizes interrupted-turn closers; a tail ending in `turn/end` needs none, so the suffix serves verbatim. (2) Tail-page projections come from `sessionProjectionCache.coldSnapshot` (cached checkpoint rows + a `readFrom` tail refold, fail-soft, no full-log load); when the cache is absent the block is absent, same as a deployment without the registry.

**Known degradation (documented in the handler JSDoc):** the presenter scope resolves from the suffix, so a preset selected before the read window falls back to the header value — view-only (generic tool cards), confined to switched-blank sessions whose switch lies outside the page.

Measured on the migrated SQLite store (812k-event session, cold process): full `inspect()` 820ms vs `readFrom` tail window 40ms — the cold-open cost becomes independent of history length.

## Consequences

- Cold history no longer synthesizes closers unless the tail is repair-ambiguous; clean tails are byte-identical to inspection output minus the closers it would not have produced anyway.
- `inspect()` remains on the resume path (`ensureSession`), so agent activation is unchanged; only transcript reading went paged.
- The subagent-history handler still inspects fully — its pages share the new turn-aligned `paginate`, but its read path is a follow-up candidate for the same treatment.
- Tests that pinned the old mixed message counting (`api-proxy-view`) or the inspect call count on cold reads (`api-proxy-cold`) were updated to the new observable behavior; the paged contract has its own spec (`api-proxy-history-paged`).

## Alternatives considered

- **Paged reads without the repair-tail guard**: rejected — a suffix cannot prove an interrupted turn's closers; serving it verbatim would change crash-recovery presentation.
- **Keep the projection baseline folded from the page events**: rejected — projections are session-wide facts; the cache ladder exists precisely for this zero-full-log case.
- **Boundary at assistant messages too (status quo)**: rejected — cuts a turn between the question and its answer, the reading defect this change exists for.
- **Widen by halving `fromSeq` alone (the first implementation)**: replaced — one halving step can overshoot by an order of magnitude (a 6.4k-event window jumping to 275k on dense agent sessions); density re-estimation converges from a sample, and halving remains only the no-sample fallback. An aggressive first window (×4096) was measured and rejected: the read curve is linear, so oversized first reads waste a full linear read (2.2s at 102k events under load).

## Verification

- `pnpm exec vitest run packages/host/apiproxy` 21 files / 385 tests green (new `api-proxy-history-paged.spec.ts`: tail-via-readFrom, user-message cuts, widening convergence, unclosed-tail fallback, not-found mapping, projection cache presence/failure/absence).
- `pnpm run typecheck` and `pnpm run test:gui` green (4044 tests); the client's turn-aligned page size (25) updated three client-runtime specs that pinned the old wire value.
- Browser lane: full `DSH_SNAPSHOT=replay pnpm run test:web:built` replay — 269 passed; the 11 remaining failures are the pre-existing host sandbox set (no sandbox backend on this container: bwrap cannot create namespaces, kernel 5.4 has no Landlock) plus built-boot's official-profile digest, which passes after `DSH_BUILD_CLIENT_PROFILE=official pnpm run build`. Zero failures attribute to the paged read.
- Measured on the migrated SQLite store: full `inspect()` 820ms vs `readFrom` tail window 40ms for the 812k-event session.
