# Agent Note: Skipping no-op session-list rebuilds and widening the ambient activity window

Status: implemented

English | [中文](2026-09-05-ambient-rebuild-skip.zh.md)

> Scope: `api/session-controller` session-list mutation path. Extends the ambient activity coalescer (`sessions/fork/coalesced-refresh.ts`, FORK_SURFACE row).

## Problem

Long-frame measurement on a 4,373-row production session (CDP CPU profiling plus Long Animation Frames) showed the session-list rebuild chain — `buildListSnapshot` → `flattenLineage` → `stableEntries` — running up to five times per second driven by other running sessions' ambient activity stamps, while the only list-visible effect is a relative-time cell displayed at minute granularity. Each stamp applied through a mutation whose `map` minted a new summaries array even when nothing changed, so every such frame paid the full rebuild.

## Decision

`applyMutation` now returns the input array reference when a mutation flips nothing (upsert whose merged fields all match, removal of an absent id, status with the same running bit and no blank flip, activity with a non-newer timestamp, engaged on a non-blank row), and `recordMutation` skips the completed-notification sync and the dirty flush on that identity — a no-op frame no longer rebuilds the list at all. The ambient activity flush window widens from 200 ms to 1 s (`ACTIVITY_COALESCE_MS`): timestamps display at minute granularity and the sidebar's updated-order promotion tolerates a one-second lag, while a busy side session now drives the rebuild chain roughly once per second instead of up to five times.

Chosen over per-field incremental rebuild: the list projection flattens lineage, subagent indexes, and projections across every row, so a content-diff shortcut at the mutation layer is the smallest correct cut; a full incremental projection is the deeper change that belongs to upstream. Chosen over coalescing alone: the window only reduces the cadence; identity skipping removes the wasted rebuilds the remaining frames would still pay.

## Alternatives considered

- **Coalescing window alone**: reduces cadence but every surviving frame still pays a full rebuild for a minute-granularity timestamp.
- **Incremental list projection**: correct at the root but re-architects lineage flattening and per-row projections — an upstream-scale change.
- **Dropping ambient stamps entirely**: loses the running-session ordering hint the sidebar shows.

## Verification

Three red-first tests in `manager.client.spec.ts` pin the rebuild skip (status no-op, activity same-timestamp no-op) and the one-second window (immediate first stamp, buffered second stamp inside the window, one flush at the first stamp's window end — a sliding debounce would fail). Focused specs 57/57, the session-controller suite 443/443, `git diff --check` clean. Production before/after comparison via Long Animation Frames is the acceptance measurement.

## Consequences

- No-op status/activity frames no longer rebuild the session list; ambient stamps land at most about once per second, cutting the measured long-frame chain roughly fivefold.
- The engaged no-op early return has no dedicated test; it mirrors the other four kinds and the file sits outside the repo's per-file coverage gate.
- Sidebar relative-time and updated-order promotion can lag a stamp by up to one second — invisible at minute display granularity.
