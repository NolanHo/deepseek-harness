# Agent Note: Bounded settle hide for the conversation composer

Status: implemented

English | [中文](2026-09-22-bounded-settle-hide.zh.md)

> Scope: the conversation composer seat's settle-driven hide and the ceiling the fork puts on it. The [ui-conversation](../../../../packages/client/ui-conversation/README.md) README owns the package's composer and shell contracts.

## Problem

The composer occasionally disappeared on desktop for no visible reason, and only a page reload brought it back. It was reproduced on the deployment (1440×900, own browser session) by restoring the GUI into a continuable subagent child while the parent-catalog read failed once (`POST /api/subagents/list` answered `gateway/internal`): `data-phase` stayed `settling`, the 136px `[data-composer-seat]` stayed `visibility: hidden` (space kept, so the column did not reflow), the transcript rendered fully (133 turns), and the state survived +4/+6/+8 s. Re-selecting the same child issued no new catalog read, and a reload with the read restored flipped the phase to `active` and made the seat visible again.

The hide itself is one rule, `.root[data-phase='settling'] .composerSeat { visibility: hidden }` (`ConversationRoot.module.css`), and `settling` has two inputs that are asynchronous facts with no guaranteed settlement:

- **Unresolved parent availability.** `parentAvailable` is written only by a **successful** `subagents.list` read: the success branch notifies every addressed child of that parent, while both failure branches keep at most the previous value and notify nobody (`packages/api/session-controller/src/client/sessions/manager.ts`). Re-selecting the child refreshes the child's own catalog, never its parent's, so navigation neither retries the read nor repairs the state; a stalled read additionally poisons the manager's single-flight entry, and no RPC timeout exists. A page restored into a continuable child therefore waits for a read that may never land.
- **Unsettled history open.** `Session.doOpen` awaits the first journal frame with no timeout and rethrows a non-remote rejection without touching `openState`, leaving it `loading` (`packages/api/session-controller/src/client/sessions/session.ts`).

Both paths only ever hid the seat; nothing else in the UI was wrong, and the elector that owns the seat (`packages/client/ui-subagent/src/client/index.ts`, `selectReadOnlySubagent`) deliberately leaves the normal composer in place while the parent is unknown — it takes the composer over only for a parent *known* to be offline.

## Decision

`packages/client/ui-conversation/src/client/skeleton/settle-hide.ts` adds `useSettleHide(pending, resetKey, limitMs)` and `SETTLE_HIDE_LIMIT_MS = 5000`. One continuous pending period hides for at most five seconds, a different Session restarts the window, and a cleared condition re-arms it. `ConversationRoot` feeds its `settlePending` (either clause) through the hook, so when the window expires `data-phase` falls back to `hero` or `active` — for a Session with a transcript, `active`, the normal docked composer.

The hide keeps its anti-flash job for the sub-second settles it was written for and no longer outlives a read or open that never lands. Five seconds is above every observed healthy settle and below the deployment's own measured cold `subagents.list` cost (7–8 s on a large parent with a cold projection cache), so even that case returns the composer before the read finishes.

## Alternatives considered

**Retry the parent-catalog read in the session manager.** It repairs the failed case but not a stalled read (no RPC timeout exists, and the single-flight entry keeps returning the stalled promise), and the UI would still have no liveness guarantee of its own. Kept as follow-up work and recorded in the package README's limitations.

**Drop the parent-availability clause from `settling` entirely.** It removes the flash protection for a read that lands `false`, and leaves the history-open clause unbounded; the ceiling keeps both properties.

**Port upstream's summary-based parent availability.** Upstream replaced the read-derived fact with a Host-summary projection (`agentAvailable` + `updateParentAvailability`); the fork is behind that migration and its summary wire carries no such field, so the port belongs to the next upstream sync rather than to a client bug fix.

**Add a timeout to the Remote RPC layer.** That settles a stalled read too, but it is a transport-wide policy decision (every RPC, every consumer) rather than a fix for this symptom.

## Consequences

The composer can no longer be lost to a settle that never resolves: the worst case is an invisible seat for the ceiling, after which the docked composer returns and accepts input. A continuable child whose parent catalog is unknown keeps the normal composer — the same surface the elector already chooses — while a known-offline parent still swaps in the read-only takeover at any time. The phase stays `settling` inside the window, so captures taken on a healthy load are unchanged.

## Testing

`packages/client/ui-conversation/tests/skeleton.client.spec.tsx` gains two fake-timer cases: a continuable child with `parentAvailable` undefined stays `settling` through `SETTLE_HIDE_LIMIT_MS - 1` and becomes `active` at the limit, and a blank Session whose open never lands does the same. Both fail on the pre-change tree (`expected 'settling' to be 'active'`). The live check ran on an isolated instance built from this revision (port 3099, own `DSH_HOME` whose profile points at a `VACUUM INTO` snapshot of the production session database, single ownership proven through `/proc/*/fd`): with the parent-catalog read still failing, the phase read `settling`/hidden at 1.5 s, 3.0 s and 4.8 s and `active`/visible at 5.6 s, 7.0 s and 9.0 s.
