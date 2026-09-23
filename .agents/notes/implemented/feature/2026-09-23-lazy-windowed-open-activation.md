# Agent Note: A windowed Session open no longer activates the Session

Status: implemented

English | [中文](2026-09-23-lazy-windowed-open-activation.zh.md)

> Scope: why the windowed open stopped mounting the Session it opened, what the removed background read cost on the largest stored Session, and what the GUI gives up until the first write or explicit resolution.

## Problem

Opening a stored Session through the windowed fast path served its history page from one indexed suffix read, and then activated the Session in the background. Activation cannot reuse that suffix: `sessionQuery.observeSession` reads the whole log through the persistence handle, `sessions.prepare` builds the dense zero-based Session that every projection folds from seq 0, and a 247-row suffix can never seed it. The read was therefore unavoidable once a Session had to exist — and the open made one exist whether or not anything was going to write.

Measured on an isolated instance against this deployment's 67,358-event Session: the windowed open read 247 rows in 0.55 ms, and the activation that followed ran `select-events` over all 67,358 rows (241 ms of SQL) and then decoded, validated, and froze the log, blocking the single Node event loop for 3,650.9 ms. Every RPC, stream, and turn sharing that loop waited for a read the reader never asked for; opening a Session to read history is a read-only gesture.

The rest of the Host already treated activation as a consequence of use rather than of opening: `commands.ts` resolves the Agent when a command needs one, the Typert lookups resolve it on demand, and the agents facade deduplicates concurrent resumes. Only the fork's windowed open called `resolveAgent` by id, from a `this.activate(target)` fire-and-forget after the snapshot.

## Decision

**The windowed opening branch yields its snapshot and stops.** `SessionHistoryController` keeps exactly the upstream constructor — the context and the `promote` callback that hands over an already-read observation — and `follow` no longer calls an activation callback after the windowed snapshot. `SessionController` loses the `activate(sessionId)` method and the constructor argument that fed it; nothing else in the open path changes.

**The whole-log read and the Agent mount happen at the first explicit resolution.** A prompt, an append, a Typert lookup, or any other `resolveAgent` consumer mounts the Session through the same path the GUI already used for every other Session. The follower that is still open receives the mount's constructor suffix and later appends through `session/created` and `session/event`, exactly as it did when activation was eager, and the snapshot still precedes every live frame because the windowed branch yields before the follower loop starts.

## What the deferred mount costs

The first resolution now pays the read the open used to pay. For a Session the reader only reads, nothing pays it.

The GUI's live indicators — queue, jobs, status, title, and the checkpoint projection — appear at first activation instead of immediately after the open. `session/control`'s baseline reports mounted Sessions only, and a Session that has never been activated has no queue and no jobs to report, so the indicators that were empty at open stay empty until something resolves the Session.

Failure surfacing is deferred with the mount. The deleted `activate` emitted `api-session/error` right after the windowed snapshot, so a Session that cannot be mounted now paints a normal transcript and fails at the first prompt; of the two activation paths, only the observation path's `promote` still reports its failure immediately.

`api-session/added` stops firing at the open as well: `src/index.ts:146-148` emits it from `session/created`, and the open mounts nothing, so the client's list row keeps the cold-path summary `summarizeCold` builds (`src/list.ts:146-158`) until the first activation replaces it.

## Alternatives considered

**Keep the eager activation but make the read cheaper.** The activation read is not work the fork can skip: `prepare` builds the dense zero-based Session before the observation exists, and every projection folds from seq 0. A cache would still pay one whole-log read per open and would add a retention policy the fork would own.

**Activate only when a live-state consumer attaches.** The only open-path consumer that observes mount state is the `session/control` baseline, and it already reports mounted Sessions alone. Making that baseline a mount trigger would move the stall rather than remove it: a GUI opens the stream for every Session it renders.

**Keep the activation behind a config field.** The fork's convention prefers a `Config` field over a patch, but a knob here would only choose between two behaviors with no consumer for the eager one, and this deployment's own measurement is the argument against it.

**Defer the activation to an idle callback instead of removing it.** The read would still run and still block the same event loop, now at an unpredictable moment, so it would not bound the stall a reader sees.

## Consequences

A read-only windowed open no longer stalls the shared event loop: the largest stored Session's open serves its page in under a millisecond of persistence work and starts no whole-log read. The deferred read is the same read, and the first write or explicit resolution pays what the open used to pay.

`promote` and the observation fallback are untouched: a request that cannot take the window still reads its observation and hands it to the same background activation as before, so the non-windowed path's live indicators keep their current timing.

Removing the activation callback restores the upstream `SessionHistoryController` constructor exactly, so the fork's inventory registers the injection without it and a future sync re-applies only the windowed branch. The surface row records the deferred-activation contract.

## Testing

`packages/api/session-controller/tests/session-open-window.host.spec.ts` carries the rewritten cases. `never reads the whole log for a windowed open` opens through the real controller's Remote face and asserts the persistence answered exactly one suffix read — no capability `stat` and no whole-log `inspect` — and that the whole-log read stays uncalled after the follower parks and two macrotasks plus a microtask turn drain. `keeps the windowed Session out of the live store until something asks for it` asserts the same settle leaves neither the Session store nor the Agent registry holding the id. `mounts the windowed Session on demand when a later request resolves it` resolves the id through the controller after a windowed open and asserts the whole-log read happened for that Session and the Agent facade was asked to mount it. `replays frames after the snapshot cursor when the Session mounts later` publishes the deferred mount's seed suffix and a later append and asserts the already-open follower yields both in seq order. `streams an append after the windowed opening through the real controller` repeats the continuity claim through the Remote face. `leaves the still-open follower healthy when the deferred resolution fails` rejects the deferred resolution, asserts its caller answers that failure and nothing is mounted, then resolves again and asserts the frames the successful mount publishes still reach the follower left open across the failure. `replays the constructor suffix when the Session is created during the window read` emits `session/created` from inside the window read, before the follower holds a cursor, and asserts the front-pushed suffix starts at the mount's `firstLiveSeq` and continues the page tail in seq order.

Mutation round (each mutation reverted): re-adding `this.activate(target)` to the windowed branch fails `never reads the whole log for a windowed open` and `keeps the windowed Session out of the live store until something asks for it`; replaying from seq 0 instead of the mount's `firstLiveSeq` fails `replays the constructor suffix when the Session is created during the window read`; and leaving a rejected resume in the facade's single-flight map fails `leaves the still-open follower healthy when the deferred resolution fails`. The package suite passes: 43 files / 822 tests. `npx tsc -b packages/api/session-controller/tsconfig.host.json` exits 0; the repo-wide `tsconfig.host.json` aggregate fails on three pre-existing `BrowserAuth` TS2345 errors in untouched client test files.

## Related

- The windowed open this change removes the eager activation from: [Windowed opening snapshot for cold Sessions](../architecture/2026-09-11-windowed-session-open.md)
- The fork inventory rows this surface is registered under: [FORK_SURFACE.md](../../../../FORK_SURFACE.md)
