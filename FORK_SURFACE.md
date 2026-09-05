# Fork patch surface — upstream divergence inventory and merge runbook

English | [中文](FORK_SURFACE.zh.md)

The fork's maintenance contract with upstream: every divergence is either a fork-owned module (zero merge cost), a config flag, a small behavior patch, or a semantic core change. This file inventories each surface, its isolation tier, and the re-apply procedure for upstream syncs. Keep it current with every change that touches an upstream-owned file.

## Why this exists

The 0.1.2-alpha.1 sync (1079 upstream commits) resolved 123 conflicts. The pain concentrated in a handful of upstream-owned files carrying fork semantics. The inventory below classifies every surface so the next sync is a mechanical re-apply checklist instead of an archaeology dig.

## The fork-module convention

Every piece of fork logic that is more than a one-liner lives in a fork-owned module under `<pkg>/src/fork/` (client faces: `<pkg>/src/client/<area>/fork/`). Upstream-owned files carry only a marked injection — one import plus one call — each preceded by a `// Fork patch (FORK_SURFACE.md): ...` comment. Syncing means: copy every `fork/` directory verbatim, then re-apply the registered injections below. Inherent one-liners (constants, single-hook swaps, CSS blocks, config fields) stay inline by policy; extracting them would add indirection without shrinking the merge surface.

## Isolation tiers

- **Tier A — fork-owned packages**: files upstream will never have. Zero merge cost.
- **Tier B — config flags**: a constant or a validated `Config` field in an upstream file. Trivial re-apply.
- **Tier C — small behavior patches**: under ~40 lines per upstream file, localized blocks. Small, resolvable conflicts.
- **Tier D — semantic core changes**: fork behavior inside upstream-owned algorithms. This is the merge cost; minimize the injection surface.

## Current inventory (vs upstream/master at the 0.1.2-alpha.1 sync)

| Surface | Tier | Size | Nature |
| --- | --- | --- | --- |
| `packages/web/web-search-{academic,bocha,brave,zhihu}` | A | 20 files | Fork search providers, fully isolated |
| `.agents/notes`, docs, snapshots, test updates | A | — | Follow their sources; re-apply with the source change |
| `session.ts` PAGE_MESSAGES 8 (upstream 50) | B | 8 lines | Client page size |
| `client/connection` browserAuth flag | B | ~50 lines | Optional auth disable behind a config field |
| `ui-chat` TurnProcessNodeView label + duration, ChatNodeSeat gate removal, locale, CSS | C | ~60 lines | Fold enhancement; localized blocks |
| `ui-chat` ChatView reader-input attribution | retired | — | Upstream's own fix landed (geometric observed-top ledger covers all input devices without listeners); the fork's device-marker patch was dropped at the 0.1.2-rc.1 sync |
| `ui-conversation`/`ui-chat` CSS overflow-anchor + safe-area | C | ~40 lines | Scrollport anchoring; localized rules |
| `api/session-controller/src/history.ts` fast-path injection | C | ~15 lines | Delegates to fork-owned `src/fork/page-boundary.ts` (the boundary walk, the ladder, the fast-path plan); one call in `page()` plus `paginate`'s delegation |
| `session-persistence-sqlite` whole package + messageCut | A (fork-owned since 0.1.2-rc.1) | 8 files | Upstream removed the package (JSONL-only decision) but kept the seam for out-of-tree providers; the fork keeps it ported to the handle-based `PersistenceBackend`/coordinator at upstream's final SCHEMA_VERSION 20 (`ignorable` column doubling as the packed-row sentinel; one-time in-place 19→20 migration; `seed_length` carries the inherited cut) |
| `session-query-sqlite` live-observation memo | C | ~13 lines in `index.ts` | The fingerprint memo (`length:tailSeq:tailTime`) in `src/fork/live-observation-memo.ts`; `index.ts` keeps the field plus a 3-line delegation |
| `client/ui-layout` AppFrame mobile shell | C | import + compose | The regime hook, drawer chrome, and details sheet live in `src/client/fork/mobile-shell.tsx`; AppFrame's diff is the import line plus composition slots |
| Conversation header mobile trim (session-log capsule + breadcrumb) | C | ~10 lines | `max-width: 560px` media blocks hide the Session log download capsule (`session-log-export`) and the session-title breadcrumb (`ui-conversation`) at phone widths |
| `api/session-controller` `openWorkspacePath` desktop gate + `ui-chat` open-file routing | C | gate stays inline (5 lines); routing = marker+import+2 calls | The open RPC consults `canOpenPath()` and fails fast (inherent one-liner); the routing decision and refusal copy mapping live in `src/client/chat/fork/open-file-routing.ts` |
| `client/modules` + `client/web` deferred boot batches | C | ~120 lines across 3 files | `WebBootBatchPhase 'deferred'` + `Config.defer` partition + two-stage boot; upstream-shaped (additive wire field, empty default); the defer list is deployment config, not repo state |
| `ui-workspace` stable promotion head | C | marker+import | `nextSessionOrderAccount`/`reconciledSessionOrder` in `src/client/fork/order-stability.ts`; WorkspaceBrowser calls them plainly |
| `ui-chat` StatsLine passive measurement | C | 1 line + comment | Ellipsis test in `useEffect` (post-paint) instead of `useLayoutEffect`; no behavior change |
| `skill` registry catalog restrictions | C | 17 lines in `index.ts` | All logic in `src/fork/skill-restrict.ts` (compile, per-scope store, chain filter); `index.ts` keeps the import, one field, and two marked delegating calls; allow/deny mutual exclusion documented in the module's JSDoc |
| `subagent` per-child cwd + skillFilter | C | seams + 2 injections in `child-agent.ts` | Logic in `src/fork/child-scoping.ts` (`stampChildCwd`, `applyChildSkillFilter`); the request-field threading through `childSessionMeta`/continuation/driver is the seam that stays; descriptor v3→4 (upstream bump at sync: union the version fields); cwd authority stays the session header on cold resume |
| `ui-chat` ChatView reflow-stable scroll anchor | C | import + 1 callback arm + 3 capture/re-hold edits, 1 removed upstream effect in ChatView | `chat/fork/scroll-anchor.ts` re-asserts the held reader row on every flow-column resize (fold collapse, image loads, disclosures), measuring the hold after the scroll write so consecutive callbacks stay idempotent, with ledger bookkeeping so reader-input attribution stays correct; anchored row hidden falls back to the nearest surviving visible row above. ChatView arms the anchor on every off-bottom scroll sample, re-holds the reader's row after each prepend compensation, captures the restored row on saved-position restore, and keeps the anchor across load-earlier settlement (the upstream clearing effect is removed) |
| `api/session-controller` reset recovery for failed session windows | C | 9 lines in `manager.handleConnected` | A carrier reset aborts every logical stream; errored sessions re-open through `resync()` instead of freezing on the last frame until a full page refresh |
| `api/session-controller` ambient activity coalescing | C | import + field + 1 call in `manager.ts` | Continuous `api-session/activity` streams from other running sessions buffered per-session (latest timestamp wins) and flushed at most every 200 ms by `sessions/fork/coalesced-refresh.ts`; lone activities apply immediately, preserving the synchronous staging contract |
| `api/session-controller` client selection notification + snapshot identity | C | ~9 lines in `manager.ts` | Identity/stability logic (entry/items/subagents/jobs caches, equal-content previous-snapshot reuse) in `src/client/sessions/fork/snapshot-identity.ts`; selection still notifies via `markDirty`, `open`/`openSubagent` stage synchronously through `followCurrent` |
| `api/gateway` Remote stream mux permessage-deflate | C | ~35 lines | `RemoteStreamMuxServer` takes a `perMessageDeflate` flag from `Config.websocketPerMessageDeflate` (default off); RFC 7692 negotiation with `threshold: 1024` so journal `opened` window frames compress while live frames stay raw; the mux frame handling itself is untouched
| `ui-workspace` order-store reference stability | C | marker+import+3-line guard | `sessionOrderChanged` in `src/client/fork/order-stability.ts`; the store action keeps the previous array reference when order is unchanged (timestamps still advance) |
| `bundle/base/cordis.patch.yml` sandbox disable + local-provider swap | C | 6 rows + comments | Fork decision 2026-09-05 (danger-full-access-only deployment, FORK_CHANGES.md): rows `sandbox`, `sandbox-policy`, `permission` get `disabled: true`; executor rows `bash-sandbox`/`pwsh-sandbox`/`fs-sandbox` keep their ids and platform `!!js` gates but mount `@deepseek-ai/dsh-bash-local`/`dsh-pwsh-local`/`dsh-fs-local` instead of the sandboxing packages. Re-apply on sync: revert names/flags per the in-file fork comments; `permission` must track the sandbox rows (its constructor rejects composition over a non-confining executor) |
| root `vitest.config.ts` disabled sandbox suites | C | 2 lists + spreads | `forkDisabledSandboxTests` drops `packages/sandbox/*`, bash-sandbox, pwsh-sandbox, fs-sandbox unit suites from collection; `forkDisabledSandboxCoverageExclusions` drops those sources from the per-file coverage gate. Restore path (re-enable base rows, delete the lists) is in the in-file comments |

## Optimization plan (priority order)

1. **DONE — Extract the paging core from `history.ts`** — move `nthMessageCut`, `turnAlignedCut`, `paginateSuffix`, and the pure part of `tryIndexedPage` into a fork-owned module (e.g. `src/page-boundary.ts`, a file upstream will never have). `history.ts` keeps a ~10-line injection: the import, the `tryIndexedPage` call in `page()`, and `paginate` delegating to the shared walk. Upstream refactors of `page()` re-conflict against ten lines, not two hundred.
2. **DONE — Move `messageCut` off the upstream persistence interface** — a fork-owned service (its own package or an extension in `session-query-sqlite`) exposing the indexed cut; `history.ts`'s fast path already discovers it optionally (`SeekablePersistence` duck-typing). The upstream `SessionPersistence` abstract and coordinator revert to pristine; the SQL moves with the fork service.
3. **Write the merge runbook as you change, not at sync time** — every Tier C/D change notes its injection point here; the sync re-apply follows this file top to bottom.
4. **Keep Tier D diffs compact and marked** — the scroll-attribution block carries its rationale comment; upstream fixing the same clamp bug upstream-side shrinks the fork diff to zero (watch for it in upstream releases).
5. **DONE — AppFrame mobile shell** — the largest surface. Realistically stays a patch (layout is upstream's core component), but keep the fork's regimes in `columns.ts`-style leaf modules so the AppFrame diff stays import-and-delegate.
6. **PAGE_MESSAGES** — one line; optionally a build-time env (`DSH_CLIENT_PAGE_MESSAGES`) if it churns.

## Sync procedure (runbook)

1. `git fetch upstream && git merge upstream/master` in a worktree.
2. **Parity review (AGENTS.md policy)**: walk every inventory row against the new tag; when upstream ships an equivalent, drop the fork row and adopt upstream's (record the retirement in FORK_CHANGES.md); update each retained row's why-upstream-cannot-serve note.
3. Tier A: no action (upstream has no such files); resolve only `pnpm-workspace`/tsconfig aggregates and `cordis.patch.yml`.
4. Tier B: re-apply the flag/constant; expect trivial context conflicts.
5. Tier C: re-apply each localized block per this file's inventory; run the owning package's suite.
6. Tier D: re-apply the injection points (after step 1–2 above they are the only remaining history.ts/persistence diffs), then copy the fork-owned modules verbatim.
7. Run `pnpm run test:gui`, the session-controller suite, and `DSH_SNAPSHOT=replay pnpm run test:web`; refresh goldens only for intentional output changes.
8. Record the sync in `FORK_CHANGES.md`.
