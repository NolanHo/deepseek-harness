# Agent Note: Re-capturing the paging anchor across plain scrolls, prepends, and remounts

Status: implemented

English | [中文](2026-09-05-scroll-anchor-recapture.zh.md)

> Scope: `ui-chat` ChatView anchor lifecycle. Extends the reflow-stable scroll anchor ([note](2026-09-05-reflow-stable-scroll-anchor.md)) with four fork edits in `ChatView.tsx`.

## Problem

The reflow compensator only corrects height changes while a paging anchor is held, but the anchor is created only on jump and prepend paths and cleared at load-earlier settlement, and a plain reader scroll only refreshed an existing hold. Measured in the production browser: after a Load-earlier prepend, expanding a collapsed 127-tool-call block above the reading line (+8,460 px of flow height) shifted the reader's rows by the full delta with zero `scrollTop` compensation. Every session where the reader merely scrolled away from the pinned tail had no anchor, so folds, image loads, and disclosures above the reading line kept jumping the page while the session kept loading.

## Decision

ChatView arms the anchor on every path a reader can reach, so the compensator always has a row: an off-bottom scroll sample captures it (`else if (position !== null)`); the prepend compensation arm re-holds the reader's row at its compensated position whenever the jump did not take ownership (a landed jump's target row stays the anchor); the saved-position restore arm captures the restored row; and the upstream effect that cleared the anchor when `loadingOlder` left its busy state is removed — the anchor now also owns non-prepend reflows, which still need it after settlement. A failed or empty page leaves the head row intact, and the next compensation refreshes a stale top anyway.

`restoreAnchorOnReflow` now measures the re-captured hold after the scroll write: with scroll-coupled geometry the row returns to its anchored flow offset once compensated, so recording the pre-write value made a second callback for the same reflow compute the negative delta and undo the compensation.

Chosen over re-capturing inside the ResizeObserver arm: the observer has no scroll geometry to derive a reader position, and the scroll sample already computes one. Chosen over keeping the settlement clear and re-arming only on the next scroll: a fold that lands between settlement and the reader's next scroll is exactly the measured jump.

## Alternatives considered

- **Re-capture inside the ResizeObserver arm**: the observer lacks the scroll geometry the position needs; duplicating it there would fork `scrollPosition`.
- **Keep the settlement clear, re-arm on next scroll**: the fold that lands between settlement and the next reader scroll stays uncompensated — the production measurement.
- **Upstream report**: the guard and clearing are deliberate upstream (the anchor only owns prepends there); reporting without the fork's compensator in place would not fix the fork's page.

## Verification

Four red-first component tests in `chat-view.client.spec.tsx` (plain-scroll capture, prepend re-hold, restore capture, settlement retention — each fails on the unfixed src with the fold delta uncompensated), then green 87/87 with the fix; the full GUI lane passes (3,944), and the chat-view spec passes 87/87 in the coverage-lane configuration (forks pool + v8, three consecutive runs — a single-spec invocation exits nonzero only on the repo-wide per-file thresholds of untouched files). The anchor unit spec uses scroll-coupled geometry and pins idempotence across consecutive callbacks (95 tests in the two files). Production browser instrumentation: instrumented `scrollTop` writes and per-frame sampling show the pre-fix 8,460 px shift and zero compensation; the same expansion after the fix is under the compensation arm's coverage.

## Consequences

- Folds, image loads, and disclosures above the reading line now stay compensated after plain scrolls, load-earlier prepends, and page remounts — the jump the reader saw while the session kept loading is gone.
- The anchor is held more often, so the compensator runs its rect read on more column resizes; it writes nothing when the delta is zero, and the resize cadence, not render cadence, bounds the cost.
