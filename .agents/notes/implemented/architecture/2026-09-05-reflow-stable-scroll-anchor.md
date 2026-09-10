# Agent Note: Reflow-stable reader position across fold and image height changes

Status: implemented

English | [中文](2026-09-05-reflow-stable-scroll-anchor.zh.md)

> Scope: `ui-chat` ChatView scroll anchoring. Fork module + one ResizeObserver callback arm.

## Problem

History loading shifts the conversation page: the Turn Process fold collapses intermediate rows only after its asynchronous projection resolves, and history images load their intrinsics after the rows settle — both change flow height above the reader without a prepend, and the paging anchor (which restores the reader's row across prepends only) never compensates them. The reader's content visibly jumps each time.

## Decision

`chat/fork/scroll-anchor.ts` generalizes the held reader anchor: on every flow-column resize (the same ResizeObserver that owns dynamic-height tail-follow — fires after layout, before paint), `restoreAnchorOnReflow` re-asserts the held row's flow offset by writing the row's movement delta into `scrollTop`, records the write in the observed-top ledger (so reader-input attribution does not misclassify the compensation as a user scroll), and re-captures the hold. When the fold hides the anchored row itself, the nearest surviving visible row above it keeps its position, which keeps everything below aligned. ChatView's injection is the import plus one callback arm guarded by `anchorRef` held and no jump in flight; the anchor lifecycle follow-up ([note](2026-09-05-scroll-anchor-recapture.md)) later added the capture and re-hold edits in ChatView and made the re-captured hold measure the post-write position.

Chosen over native `overflow-anchor`: the fork removed it because native adjustments are indistinguishable from user scrolls in the geometric reader-input ledger; the fork-owned compensation writes the ledger explicitly. Chosen over first-frame-fold (rendering history rows already folded): that would synchronize the fold with the projection pipeline, a much larger change.

## Alternatives considered

- **Native `overflow-anchor`**: the fork removed it — native adjustments are indistinguishable from user scrolls in the geometric reader-input ledger, so they misclassify and kill the tail follow.
- **First-frame fold**: render history rows already folded by synchronizing the fold with the projection pipeline; correct at the source but a much larger change.
- **Per-component fold compensation**: adjust the scrollport from the disclosure toggle itself; covers only the fold, leaves image loads and future height changes un-anchored.
## Verification

`scroll-anchor.client.spec.ts` (jsdom, stubbed rects): row-held compensation direction and ledger write, hidden-anchor fallback, no-op on zero delta, cleared hold when nothing anchors. 100% file coverage; the ui-chat suite passes (322), the GUI lane is green.

## Consequences

- Folds, image loads, and disclosure toggles no longer shift the reader's content while history settles; the tail-follow path is untouched (the compensation only runs with a held anchor — a reader unpinned from the bottom).
- The compensation cost is one rect read plus a scroll write per column resize with a held anchor — resize cadence, not render cadence.
