# Agent Note: Session selection stages synchronously; its list projection renders outside the interaction

Status: implemented

English | [中文](2026-08-29-selection-staging-outside-interaction.zh.md)

> Scope: the client sessions service (`dsh-client-api-session-controller` browser half) and the workspace sidebar's order store. No wire, host, or persistence changes.

## Problem

Field INP data showed the session-row click at 240 ms with 185 ms of processing: `SessionManager.select` flushed its notifier with `notifyNow`, so the whole sidebar and conversation swap rendered synchronously inside the interaction's processing window. Around the click, co-streaming sessions drove a second amplification: every list rebuild minted a fresh snapshot object (even for equal content), and the sidebar's account sync wrote a fresh order array per activity tick — each one re-ran the tree derivation and the order-derived memos twice per tick.

## Decision

**Staging and projection split at the service seam.** The manager's selection paths (`select`, `selectSubagent`, `clearSelection`) notify through `markDirty`: the list-store projection for React subscribers lands in the manager's existing microtask batch, outside the calling interaction. `ClientSessions.open`/`openSubagent` then stage synchronously by calling `followCurrent` directly — `followCurrent` now reads the manager's snapshot (the projection's source, fresh through the notifier's read-path rebuild), so each open still reaches its session window within the call and a burst of opens stages every selection, not only the last.

**Identity-stable list snapshots.** `buildListSnapshot` returns the previous snapshot object when every observable field is unchanged (items reference, current, state, phase, error, stabilized `subagentsByParent`/`jobsBySession` products, address); the two `Object.fromEntries` products keep their reference while no catalog or jobs entry moved. Equal-content rebuilds no longer re-render subscribers.

**Order references survive unchanged account syncs.** The workspace view store's `syncSessionOrderAccount` keeps the previous array reference when the order did not change (timestamps still advance and persist), so order-derived memos re-run only on real reorders.

## Consequences

- The session-row click returns in ~2-3 ms of handler time (measured: 185 ms → 2.6 ms); the swap renders in the same frame from the microtask batch.
- The controlled-input same-tick contract stays on `notifyNow` where it belongs (draft echoes); selection is navigation and never was one.
- Service tests that pin `list.getSnapshot()` right after `open()`/`clear()`/`openSubagent()` read the projection one microtask later; staging tests (scope windows, address routes) keep their synchronous assertions.
- Ambient churn from co-streaming sessions drops (no-op rebuilds skip notification; unchanged orders skip memo re-runs); activity-driven rebuilds remain by design (live time labels).

## Alternatives considered

- **Keep `notifyNow` and defer at the uSES layer**: the snapshot-store engine is upstream core; changing its notify semantics affects every store.
- **Async staging too (mark everything)**: a burst of opens would stage only the last selection — the scope-tree tests pin per-open staging, and the stage is the open signal.
- **Throttle activity mutations instead**: live relative-time labels are the product; delaying them trades visible correctness for headroom.

## Verification

`packages/api/session-controller` client suites green (420 tests: manager, service, notifier, lineage); `test:gui` 291 files / 3854 tests green; the new manager tests pin the snapshot-reference reuse, the equal-content contrast, and the microtask notification with synchronous staging.
