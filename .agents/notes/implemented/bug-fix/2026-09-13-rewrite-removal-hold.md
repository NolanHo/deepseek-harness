# Agent Note: Rewriting history in place no longer reads as a Session removal

Status: implemented

English | [中文](2026-09-13-rewrite-removal-hold.zh.md)

> Scope: the client-visible lifecycle edge the in-place history rewrite produced in its Agent teardown (`SessionController`'s `api-session/removed` relay), and the hold that suppresses it. [The feature note](../feature/2026-09-12-in-place-history-rewrite.md) owns the rewrite design; [the session-controller package](../../../../packages/api/session-controller/README.md) owns the transport contract.

## Problem

Sending an edited message through the in-place rewrite made the GUI fall back to the new-Session frame — the workspace chip reading "Choose workspace" with the inert "Choose a workspace to start" composer and no transcript — for as long as the rewrite took, then snap back to the conversation.

The rewrite disposes the Session's Agent to release its persistence write ownership before truncating (`AgentHandle.dispose()` stops the loop, unregisters the agent, and *removes its session from the store*). The Session Layer pairs that removal with `session/disposed`, and this controller relays it as `api-session/removed`. Clients treat that as the Session leaving the list: the summary is dropped, `sessions.list` masks `current` to `undefined`, the session-current binding becomes absent, and `ConversationRoot` renders `hero = sessionId === undefined` — the new-Session frame. The same request then resumes an Agent under the same Session id, `api-session/added` restores the summary, and the conversation comes back while the selection was never cleared. Measured on a second instance with a clean database, the frame occupied 62–132 ms per rewrite there; the window is the rewrite's own duration (agent teardown, truncation, projection discard, resume), so a large live Session on the deployment shows it for noticeably longer.

## Decision

The `SessionController` now holds the removal announcement across the whole rewrite window instead of publishing it and retracting it moments later. The rewrite is one operation: this Session id and its durable log survive it, the Agent is rebuilt inside the same request, and no client should observe the internal teardown as a lifecycle edge.

`SessionCommandController.prompt` enters the hold before `rewriteHistory` and leaves it after `resolveAgent` settles, so the window covers the dispose-to-rebuild span; the `api-session/removed` relay asks the same controller (`deferRemoval`) before emitting. A deferred announcement is re-published at release when the window ends with no live Agent — a rewrite that fails after disposal (a truncated-log write error) must still tell clients the Session is gone — so the fallback keeps the announcement truthful instead of leaking a Session no client can reach.

## Alternatives considered

- **Do not dispose the Agent.** The live Session owns the in-memory log its loop appends to; truncating durable storage beneath it desynchronizes the next append (seq cursor and handler revision both assume a log that only grows). An in-place rewrite of a *live* Session would need the Session Layer to drop a committed tail in memory and storage together, which no current seam provides.
- **Suppress `session/disposed` itself.** Other consumers act on that event for their own reasons (persistence handles close, the projection cache retires rows, staged uploads drop), and the store genuinely has no session in the window; only the *client-facing* announcement is the defect.
- **Fix the client to render through a masked gap.** `ConversationRoot` reads an absent current binding as "no Session at all", and the data layer already distinguishes a masked gap; teaching every client-side render path to keep the last conversation would paper over the host publishing a removal that does not describe the Session's fate, and would leave other clients on the same lie.

## Consequences

- A client that never sees the removal keeps the row, the selection, and its rendered conversation; the edit-and-resend now swaps the transcript in place (the replaced message disappears when the edited one renders) instead of blanking the app.
- The hold is scoped to one Session id and one rewrite request; the relay is unchanged for every other disposal path, and no other owner observes different events.
- The deferral is not a retraction protocol: clients that connect *during* the window read the ordinary list (the Session is absent from the store then), which is the same state a client sees if it loads between a disposal and its rebuild.

## Testing

- `packages/api/session-controller/tests/session-rewrite.host.spec.ts` pins the production composition (real sqlite persistence, the production Agent loop, the real projection cache): a rewrite over a *live* Agent resolves `rewrote: true` while `api-session/removed` is never emitted for that Session. Against the unpatched source the same case fails with `["session-rewrite-quiet"]`.
- `packages/api/session-controller/tests/rewrite-hold.spec.ts` pins the hold's four transitions, including the failed-rewrite fallback that still announces the removal.
- A real browser drove the same edit-and-resend on a second isolated `dsh web` instance (127.0.0.1:3097, own `DSH_HOME`, own database) with a 20 ms DOM probe around the send: before the change the new-Session frame appears at t=62 ms with the composer unmounted; after it, no frame and no blank conversation state at any sample, and the transcript transitions straight from the replaced message to the edited one.
