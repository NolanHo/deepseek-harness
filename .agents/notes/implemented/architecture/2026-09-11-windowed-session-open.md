# Agent Note: Windowed opening snapshot for cold Sessions

Status: implemented

English | [中文](2026-09-11-windowed-session-open.zh.md)

## Problem

Opening a Session in the Web client reads through `session.history.follow`, which resolved a full observation: the entire stored log decoded, every projection unit folded, and then the newest page of messages trimmed out of that fold. On the largest Session this deployment holds (1,035,641 events) one open costs seconds of CPU and hundreds of megabytes of heap, and the client only ever shows the newest 8 messages plus one projection cut. Backwards paging stopped paying that: `page`/`loadOlder` serve older pages from the fork's indexed seek surface (`messageCut` + `readFrom`). The opening snapshot kept the full read, so every open paid the whole log again — and reopening a Session after any navigation is the common path.

## Decision

`follow` serves a cold ordinary Session's opening snapshot from one seekable suffix window when the mounted persistence exposes the fork seek surface and the projection cache holds a record for that Session lifecycle. Everything the window cannot prove falls back to the existing observation path, unchanged.

### The capability gate

Both fast paths read their cuts from `messageCut`, which selects on the stored physical `seq` column, and both read events through `readFrom`. Only a current-format row keeps those two in one space: `loadStoredFrom`'s historical arm restores the whole log through the format catalog, and that restore re-bases the sequence numbers over the restored events, so a physical cut addresses nothing there. The deployed store is mostly historical rows, so a window plan that skipped the check paid a cut query plus a full log read per attempted margin and then fell back to the observation path, which read the log again — slower than not having the fast path at all. The gate is therefore the first thing `readIndexedSuffix` calls: `SeekablePersistence.seekable(id)` asks the backend whether a bounded seq window is addressable, `SqliteStore.seekable` answers from the session row's format version alone (no event rows), and a false answer returns before `messageCut` and before any `readFrom`. The historical arm of `loadStoredFrom` keeps serving whole-log readers and says in its contract that it cannot serve an indexed page cut.

### The window plan

`packages/api/session-controller/src/fork/open-window.ts` drives `readIndexedSuffix` from `fork/page-boundary.ts`, the same message-cut ladder older pages use: the indexed cut over append-origin user messages, a lead margin below it, one deep-margin retry for a compaction-widened group head, and a soft bail whenever the accepted window does not provably hold a full page. The window itself is the read the page is cut from, so the page tail and the cursor come from one cut: the gateway rejects an opening page that does not end at its reported cursor.

The plan resolves the projection floor from the first read's stored header (the cache identity needs that metadata). A floor below the window start restarts the read there, so one window serves both the page and the projection tail; a floor at or above the window start needs no second read.

### The projection cut

`ctx.sessionProjections.restore(rows, window, fromSeq, meta, inheritedEventCount)` folds every registered unit from the cached checkpoint rows over the accepted window, and its `snapshot` becomes the wire `projections` block. `fromSeq` is the restore `baseSeq`; rows at or above it are usable by construction (the floor extension guarantees it), and the block's `asOfSeq` is the window end — the same cut the page and cursor report.

The fast path serves only a log whose last turn boundary is a `turn/end`: a window ending inside an open turn folds differently from the balanced view `readColdSessionLog` builds by appending `interruptedTurnClosers`, and the opening block must equal a full observation's values and `asOfSeq`. A window that holds no turn boundary proves the same only from the log head, so a window that starts later and finds none bails. A checkpoint record the current units cannot seed (a predecessor generation without `formatVersion`, a version- mismatched row) bails for the same reason: `restore` would either refold from seq 0 or reject the row.

### Write-back

A cold observation with no usable record now installs one, so the *next* open takes the windowed path: `SessionProjectionCache.hydratePrepared` folds the log's **durable prefix** and writes that checkpoint back, fail-soft and fire-and-forget (a lost write only costs a longer tail replay). `readColdSessionLog` reports that prefix length (`durableEventCount`) because the balanced log it hands over may carry synthetic recovery closers the stored log never held; the served block still folds the whole balanced log, resuming from the written rows so only the closers are refolded. The rows never come from `checkpoint(session)`: a restored Session appends its own `session/end-seed` resume marker one seq past the supplied log, and rows beyond the durable end would reject every later tail restore that seeds from them.

### Activation

An opening snapshot activates the Session in the background, off the request path. The observation path promotes the exact prepared Session it already holds; the windowed path read persistence only and has no observation, so it activates by id through a second injected callback (`SessionController.activate` → `ApiSessionAgentController.resolveAgent`), which reads the log once per activation. `SessionController` owns the activation bookkeeping for both.

### Injection points

Fork-owned modules: `src/fork/open-window.ts` (the window plan and the projection cut) and `session-projection-cache/src/fork/checkpoint-read.ts` (the checkpoint read the open path needs). Upstream-owned files carry the injections: `history.ts` keeps the synchronous service check, the windowed branch, and its observation fallback; `index.ts` wires the id-based activation; `session-projection-cache/src/index.ts` registers its private checkpoint lookup for the fork module and writes back the restored checkpoint from `hydratePrepared`; `page-boundary.ts` gains the windowed read (`IndexedRead`, `readIndexedSuffix`, the optional `throughSeq` and `windowFloor`) that `readIndexedPage` still delegates to. The registration is a symbol-keyed property rather than a WeakMap on the instance: cordis hands callers a tracker proxy, so the service object a caller sees is not the object the constructor registered. That same proxy is why both fast paths extract their seek surface through `history.ts`'s `seekSurface` helper, which binds `messageCut` and `readFrom` to the value `ctx.get` answered: a service method only receives the provider's own `this` when it is called on the proxy itself (`vendor/cordis/src/utils.ts`, `createShadowMethod`), so a wrapper object around the extracted methods — the shape both sites shipped before this round — calls them with the wrapper as `this` and every provider that reads its own state throws, which the fallback swallows in silence. The tracker-provider cases in `session-open-window.host.spec.ts` mount the persistence as a real `Service` and fail on that wrapper. Fixing the shared surface also put the older `page()`/`loadOlder` indexed page back in service: it had never engaged in production either. `packages/api/session-controller/tsconfig.host.json` lists the new source file.

## Alternatives considered

**Keep the full observation and trim, and only cache the fold.** The projection cache already skipped the checkpointed prefix for the fold, which is why the cache exists. It cannot skip the log *read* (the cache holds projection state, not events) and the client-visible cost is dominated by materializing and folding the whole log; a session with no usable record still paid all of it on every open. Rejected as the reason this note exists.

**Expose the checkpoint read as a public cache method.** The generated Cordis catalog and subsystem pages record every public service method, so a new method changes committed generated documentation outside the change's surface. The symbol-keyed registration keeps the service's public surface — and the catalog — unchanged while still giving the open path identity-checked rows.

**Write back `checkpoint(session)`.** It is the registry's documented checkpoint face, but it folds to the *Session's* cut, which a restored Session pushes one seq past the supplied log with its resume marker — and every later tail restore rejects a row beyond the stored end. The write-back therefore folds the durable prefix itself, using the count the cold read reports.

**Require the seek surface on the persistence abstraction.** `messageCut` and `readFrom` are the fork's own additions to a backend, duck-typed behind `Partial<SeekablePersistence>`; promoting them to the abstract would edit the upstream-owned persistence packages and force every backend to implement them. The duck-typed probe keeps the surface additive, exactly as the older-page fast path already ships it.

**Recover an unbalanced window locally.** The fast path could append `interruptedTurnClosers` to its window and fold that, but those closers are not durable: their seqs would claim events the stored log does not hold, and the next restore or activation would disagree about the cut. The observation path already owns that balance, so the window bails instead.

## Consequences

Cold opens of a Session with a current-format checkpoint record read one bounded suffix instead of the whole log, and install that record on the first open when it is missing, so the second open is the fast one. The client wire is unchanged: `SessionFollowFrame.snapshot` keeps `{ header, cursor, records, hasMore, projections, assistantStream? }`, and the served block equals a full observation's values and `asOfSeq` by construction, which the host tests pin against the live registry.

What it costs: an open needs a usable checkpoint record and the fork seek surface, so JSONL-backed deployments and Sessions whose stored tail is unbalanced stay on the observation path (correct, not faster); a record that the stored log does not reach — a Session recovered from synthetic closers — leaves the windowed attempt bailing until a live write replaces the row, which is what that Session did before this change. Projection cache records written by an older build without `formatVersion` still never seed the fast path; the first open installs a current-format record for the next one.

The gate is pinned by a store-level case (a migrated v0 row measuring the two spaces apart: stored rows `[0, 1, 2, 5, 6]` against restored seqs `[0..5]`, a physical cut selecting nothing, and the row flipping to addressable only once published) and by host cases asserting that a historical session reaches the observation path with zero `messageCut`/`readFrom` calls, plus a unit case for the probe-first ordering.

Verification lives in the host suites: `session-open-window.host.spec.ts` pins the windowed answer against a snapshot taken through the observation path for the same Session (records, `hasMore`, cursor, projection values and `asOfSeq`), the one-read tail window, the whole-log page with `hasMore` false, a stale checkpoint whose floor sits behind the window, a record the current units cannot seed, the fallback with its write-back and the following windowed open, the non-seekable, short-page, subagent, unbalanced-tail, failed-read, truncation, other-lifecycle, missing-workspace, attach-race, and subagent-fence fallbacks, the read plan's floor restart and deep-retry arithmetic, and the id-based background activation through the real controller with both of its failure arms; `session-projection-cache/tests/cache.spec.ts` pins the write-back cut for a balanced and a recovered log, a floor-seeded restore over the written rows, its fail-soft failure, and that the record serves `cachedSnapshot`. The language-visible cost of a cold open is covered by the benchmark worker (`benchmarks/session-open`), which composes the JSONL backend and therefore measures the observation path it was written for.
