# Agent Note: User-aligned, turn-complete history paging across both read paths

Status: implemented

English | [中文](2026-08-29-user-aligned-turn-complete-paging.zh.md)

> Fork deviation from upstream's message-indexed paging, extending the fork's messageCut fast path to the observation path it falls back to.

## Problem

History paging ran on two logic paths with different boundary rules. The indexed fast path (messageCut + suffix read) cut pages at the Nth user message, while the observation fallback cut at the Nth message of any kind — so the same cursor produced different boundaries depending on which path served it. Pages cut mid-turn, the head turn reached the client without its turn/start and rendered unfolded, and the fold applied only after the next page completed the turn: visible re-layout (flicker) on every Load earlier. Separately, a compaction replacement widens its group head across the whole shadowed range, so the fast path's 128-event lead failed its completeness check and every compaction-adjacent page fell back to the full observation read.

## Decision

- One boundary walk (`nthMessageCut` in `packages/api/session-controller/src/history.ts`) now serves both `paginate` (observation) and `paginateSuffix` (indexed): user messages anchor pages (whole-log fallback to any message for synthetic logs), the chosen message widens its cut through `sourceEventSeqs`, and the cut pins only at the max-th message so a short window stays whole. The dense observation walk indexes its array prefix instead of slicing it.
- Every cut widens back to its owning turn's opening events (`turnAlignedCut`, stopping at the previous `turn/end`), so pages start at complete turn boundaries and the client's Turn Process fold is stable from the first render of a page.
- The indexed fast path retries its suffix read once at a 4096-event deep margin when the shallow 128-event lead cannot hold the (compaction-widened) cut, before falling back to the observation path.

## Consequences

- Both read paths produce identical page boundaries for the same cursor, so the boundary semantics have one home (`nthMessageCut`); the fast path is no longer observably different from observation.
- Pages start at turn openings and carry their group-head events, so the client's Turn Process fold renders correctly on first paint of each page — the Load-earlier flicker is gone.
- Compaction-adjacent pages reach the indexed fast path again (the deep 4096-event retry absorbs the widened cut); the observation fallback remains for stores without the indexed cut.

## Alternatives considered

- **Fix the two paths separately** (keep message-kind anchors on the fast path): the split semantics were the defect; every future boundary rule would have to be encoded twice.
- **Serve the lead at the page boundary regardless of turn state**: the folded head already rendered misaligned; widening to the turn opening is what makes the boundary stable.
- **Raise the lead margin instead of the deep retry**: a wider lead penalizes every indexed read for a compaction-only condition; the retry ladder pays only when the cut actually needs it.

## Verification

`packages/api/session-controller` suite green (414 tests), including a new deep-retry test; chat-scroll-contract and seeded-history lanes green in replay mode (the two long-standing sandbox-environment failures aside); the boundary expectations of the pagination tests updated to the user-aligned, turn-complete semantics.
