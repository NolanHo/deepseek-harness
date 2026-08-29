# Fork patch surface — upstream divergence inventory and merge runbook

English | [中文](FORK_SURFACE.zh.md)

The fork's maintenance contract with upstream: every divergence is either a fork-owned module (zero merge cost), a config flag, a small behavior patch, or a semantic core change. This file inventories each surface, its isolation tier, and the re-apply procedure for upstream syncs. Keep it current with every change that touches an upstream-owned file.

## Why this exists

The 0.1.2-alpha.1 sync (1079 upstream commits) resolved 123 conflicts. The pain concentrated in a handful of upstream-owned files carrying fork semantics. The inventory below classifies every surface so the next sync is a mechanical re-apply checklist instead of an archaeology dig.

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
| `ui-chat` ChatView reader-input attribution | D | 32 lines | Upstream's scroll-follow bug fix (clamp misattribution); watch upstream for their own fix |
| `ui-conversation`/`ui-chat` CSS overflow-anchor + safe-area | C | ~40 lines | Scrollport anchoring; localized rules |
| `api/session-controller/src/history.ts` fast-path injection | C | ~60 lines | Delegates to fork-owned `src/page-boundary.ts` (the boundary walk, the ladder, the fast-path plan); one call in `page()` plus `paginate`'s delegation |
| `session-persistence-sqlite` messageCut | C | ~24 lines | The concrete store's indexed seek; upstream's abstract, coordinator, and jsonl stub are pristine again |
| `session-query-sqlite` live-observation memo | C | 30 lines | Localized memo in one function |
| `client/ui-layout` AppFrame mobile shell | C | ~62 lines + fork-owned `mobile-shell.tsx` | The regime hook, drawer chrome, and details sheet live in the fork's module; AppFrame composes |
| `client/modules` + `client/web` deferred boot batches | C | ~120 lines across 3 files | `WebBootBatchPhase 'deferred'` + `Config.defer` partition + two-stage boot; upstream-shaped (additive wire field, empty default); the defer list is deployment config, not repo state |
| `ui-workspace` stable promotion head | C | ~20 lines | `nextSessionOrderAccount` keeps the leading promoted run stable while sessions co-stream; one promotion per activity burst |
| `ui-chat` StatsLine passive measurement | C | 1 line + comment | Ellipsis test in `useEffect` (post-paint) instead of `useLayoutEffect`; no behavior change |

## Optimization plan (priority order)

1. **DONE — Extract the paging core from `history.ts`** — move `nthMessageCut`, `turnAlignedCut`, `paginateSuffix`, and the pure part of `tryIndexedPage` into a fork-owned module (e.g. `src/page-boundary.ts`, a file upstream will never have). `history.ts` keeps a ~10-line injection: the import, the `tryIndexedPage` call in `page()`, and `paginate` delegating to the shared walk. Upstream refactors of `page()` re-conflict against ten lines, not two hundred.
2. **DONE — Move `messageCut` off the upstream persistence interface** — a fork-owned service (its own package or an extension in `session-query-sqlite`) exposing the indexed cut; `history.ts`'s fast path already discovers it optionally (`SeekablePersistence` duck-typing). The upstream `SessionPersistence` abstract and coordinator revert to pristine; the SQL moves with the fork service.
3. **Write the merge runbook as you change, not at sync time** — every Tier C/D change notes its injection point here; the sync re-apply follows this file top to bottom.
4. **Keep Tier D diffs compact and marked** — the scroll-attribution block carries its rationale comment; upstream fixing the same clamp bug upstream-side shrinks the fork diff to zero (watch for it in upstream releases).
5. **DONE — AppFrame mobile shell** — the largest surface. Realistically stays a patch (layout is upstream's core component), but keep the fork's regimes in `columns.ts`-style leaf modules so the AppFrame diff stays import-and-delegate.
6. **PAGE_MESSAGES** — one line; optionally a build-time env (`DSH_CLIENT_PAGE_MESSAGES`) if it churns.

## Sync procedure (runbook)

1. `git fetch upstream && git merge upstream/master` in a worktree.
2. Tier A: no action (upstream has no such files); resolve only `pnpm-workspace`/tsconfig aggregates and `cordis.patch.yml`.
3. Tier B: re-apply the flag/constant; expect trivial context conflicts.
4. Tier C: re-apply each localized block per this file's inventory; run the owning package's suite.
5. Tier D: re-apply the injection points (after step 1–2 above they are the only remaining history.ts/persistence diffs), then copy the fork-owned modules verbatim.
6. Run `pnpm run test:gui`, the session-controller suite, and `DSH_SNAPSHOT=replay pnpm run test:web`; refresh goldens only for intentional output changes.
7. Record the sync in `FORK_CHANGES.md`.
