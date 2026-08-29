# Agent Note: Deferred boot batches, sidebar promotion stability, and the web perf anatomy

Status: implemented

English | [中文](2026-08-29-deferred-boot-batches.zh.md)

> Scope: the web client's boot phasing (`dsh-client-modules` graph composition, `dsh-client-web` boot), the workspace sidebar's recency promotion, and `ui-chat` StatsLine measurement timing. No wire-format, protocol, or persistence changes.

## Problem

Field measurements of the served GUI (local Chrome field data) reported LCP 3.82 s and CLS 0.19 with a ~150-entry shift cluster on sidebar session rows. Measurement on the running deployment attributed the numbers:

- **Transport**: the boot combo request carries every client bundle in one response — ~6.8 MB uncompressed (54 packages; 12 third-party plugins are ~2.5 MB of it) — and the webserver's compression default is `none`. Over the domain path (WireGuard → traefik → Caddy) the raw bytes dominate LCP.
- **Boot gate**: `boot.ts` created every Loader entry and asserted all of them active before mounting the UI renderer, so skin/market/SSH chrome blocked first paint without contributing to it.
- **Sidebar churn**: `nextSessionOrderAccount` re-sorted every session whose `updatedAt` bumped on each tick, so co-streaming sessions swapped positions continuously (the user's sessionRow shift cluster; Playwright even failed `click()` with "element is outside of the viewport" 57 times while the list moved under the pointer).
- **Idle CPU**: a third-party plugin (`@changfenhuang/dsh-annotation`) polls `decorateAll` every second forever over all message rows, and `StatsLine` measured ellipsis truncation in `useLayoutEffect`, forcing a layout flush per row inside the session-open commit (46 ms of a 374 ms cold-open long task).

## Decision

**Deferred boot batches (config-gated, upstream-shaped).** `WebBootBatchPhase` gains `'deferred'`: the node half of `dsh-client-modules` partitions the application records by a new `Config.defer` list into pre-mount and deferred combos; deferred combos are served on demand but not preloaded, and the boot kernel creates their entries only after the application mounts. Two composition contradictions fail loud (a deferred row that is stage-one `immediately`; a pre-mount row whose `external` requests a deferred package). A pre-mount plugin that waits on a service a deferred package provides surfaces in the existing activation audit. Stale defer names (uninstalled plugins) warn once and are ignored. The deployment names its third-party plugins in the profile patch layer — mechanism in the repo, policy in the deployment.

**Recency promotion keeps the leading run stable.** Sessions already leading the order (the promoted head) keep their relative positions while they stream together; only rows outside the head jump to the front, newest first — one promotion per activity burst instead of a re-sort per update tick. The full recency sort on entering "last updated" and the single-promotion semantics are unchanged.

**StatsLine measures post-paint.** The ellipsis test moved from `useLayoutEffect` to `useEffect`: the session-open commit no longer carries one forced layout read per stats row, and the hover tooltip (500 ms delay) is unaffected — nothing visible changes.

**Transport and third-party are deployment-local.** The webserver overlay enables `compression: 'gzip'` (the response middleware already covered the plugin route; the option defaults to `none` upstream). The annotation plugin's 1 s fallback poll is gated on observed mutations through a local patch to the installed copy (`~/.dsh/profiles/web/node_modules/@changfenhuang/dsh-annotation/client.js`), lost on the plugin's next update — the fix belongs upstream.

## Consequences

- Cold-load first paint fetches and parses only pre-mount bundles; deferred packages (~2.5 MB before compression) arrive right after mount and their slots fill in late.
- Co-streaming sidebar rows stop swapping; opening one session still promotes it once.
- The cold-open long task drops by the StatsLine measurement pass; the remaining cost is React mounting the visible conversation window (already memoized and host-windowed).
- A plugin wrongly deferred (one a pre-mount package injects) fails the boot audit loudly instead of hanging — the defer list is a deployment contract to trim per site.

## Alternatives considered

- **Defer by policy (every third-party package) instead of a config list**: rejected — silent re-classification on plugin install, and a site's load-bearing third-party plugin would break the audit with no diff to consult.
- **`startTransition` around the session-open store update**: rejected — the data arrives through the uSES adapter on the SSE frame path; making external-store notifications transitions wholesale changes streaming echo latency for every update.
- **`content-visibility: auto` on chat rows**: rejected — the custom scroller (`toBottom`, scroll restoration, folding) reads layout continuously; estimated intrinsic sizes would perturb it for a paint-only win on already-mounted rows.
- **Virtualizing the conversation window**: out of scope — the host window (page boundary) already bounds the mount, and the measured 374 ms cold open is dominated by React mounting ~215 memoized rows, not layout.

## Verification

`test:gui` 291 files / 3852 tests; `test:web` replay lane; module and boot suites cover the deferred partition (three contradiction/staleness cases), the two-stage boot ordering (deferred bundle loads only after mount), and the co-streaming promotion stability.
