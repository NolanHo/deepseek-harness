# Agent Note: User-aligned, turn-complete history paging across both read paths

Status: implemented

English | [中文](2026-08-29-user-aligned-turn-complete-paging.zh.md)

> Fork deviation from upstream's message-indexed paging, extending the fork's messageCut fast path to the observation path it falls back to.

## Problem

History paging ran on two logic paths with different boundary rules. The indexed fast path (messageCut + suffix read) cut pages at the Nth user message, while the observation fallback cut at the Nth message of any kind — so the same cursor produced different boundaries depending on which path served it. Pages cut mid-turn, the head turn reached the client without its turn/start and rendered unfolded, and the fold applied only after the next page completed the turn: visible re-layout (flicker) on every Load earlier. Separately, a compaction replacement widens its group head across the whole shadowed range, so the fast path's 128-event lead failed its completeness check and every compaction-adjacent page fell back to the full observation read.

## Change

- One boundary walk (`nthMessageCut` in `packages/api/session-controller/src/history.ts`) now serves both `paginate` (observation) and `paginateSuffix` (indexed): user messages anchor pages (whole-log fallback to any message for synthetic logs), the chosen message widens its cut through `sourceEventSeqs`, and the cut pins only at the max-th message so a short window stays whole. The dense observation walk indexes its array prefix instead of slicing it.
- Every cut widens back to its owning turn's opening events (`turnAlignedCut`, stopping at the previous `turn/end`), so pages start at complete turn boundaries and the client's Turn Process fold is stable from the first render of a page.
- The indexed fast path retries its suffix read once at a 4096-event deep margin when the shallow 128-event lead cannot hold the (compaction-widened) cut, before falling back to the observation path.

## Verification

`packages/api/session-controller` suite green (414 tests), including a new deep-retry test; chat-scroll-contract and seeded-history lanes green in replay mode (the two long-standing sandbox-environment failures aside); the boundary expectations of the pagination tests updated to the user-aligned, turn-complete semantics.
