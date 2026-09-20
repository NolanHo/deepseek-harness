# Agent Note: The Web composer submits only through the Cmd/Ctrl chord

Status: implemented

English | [中文](2026-09-19-composer-chord-only-submission.zh.md)

## Problem

Upstream's composer submits on plain Enter, so an accidental Enter press mid-thought sends the draft. Its submission surfaces also disagree: plain Enter delivers the busy-Enter preference, Cmd/Ctrl+Enter delivers its opposite, the Send button follows plain Enter, and an empty-draft chord steers every queued message into the running turn — which key was pressed decides whether a message queues or interrupts. Upstream exposes no setting that demotes Enter to a newline. The fork's first attempt at this surface ([one composer submission path](../../archived/feature/2026-08-28-composer-submission-chord-and-button.md)) was retired at the 0.1.5-rc.2 sync because upstream's `BusyEnterBehavior` setting, `submit()` gesture, and `steerQueue` superseded it.

## Decision

Plain Enter and Shift+Enter insert native line breaks; only the Cmd/Ctrl chord submits, resolving through `resolveSubmitMode(busyEnter, running, 'enter', steeringAvailable)` — the Send button's exact mode, never upstream's inverted `accelerated` gesture. [FORK_SURFACE.md](../../../../FORK_SURFACE.md) registers the row; the marked edits are:

- `input/editor/keymap.ts` returns `false` for a non-chord Enter after the IME guard and menu arbitration, so the keystroke falls through to `@lexical/plain-text`'s line break; a null-event synthetic Enter still submits.
- `skeleton/InputBar.tsx` passes the constant `'enter'` gesture, deletes the empty-draft whole-queue steer branch, and drops the placeholder hint with the `canSteerQueue` derivation that fed both (the `placeholder.steerQueue` dictionary keys are deleted with it). An empty-draft chord meets the machine's empty-draft rejection instead.
- `client/locales.ts` rewrites `settings.enter.description` in both dictionaries: the setting governs the chord and the Send button together.

`submission-policy.ts`, `contract/composer-submission.ts`, `facade.ts`, `hub.ts`, and `machine.ts` stay upstream: the `accelerated` gesture keeps its direct unit coverage, and `steerQueue` survives on the shell face through `service-orchestration` coverage. QueueDock's per-row Steer remains the only path from the queue into the running turn.

## Alternatives considered

**Keep the empty-draft whole-queue steer chord.** With the chord as the sole submit gesture, a double press — send, then the now-empty draft — steers the just-queued message into the running turn under the default Queue preference, the same accident class this change removes. The 2026-08-28 note reached the same verdict when it deleted the gesture.

**Make the submit key a Settings toggle.** Rejected by the owner: a hardcoded behavior keeps the fork surface minimal — no settings row, persistence, or bilingual copy to re-apply at every sync — and chord-only submission is what this deployment wants.

**Remove the `accelerated` gesture from `resolveSubmitMode`.** The patch would spread into `submission-policy.ts`, `contract/`, and every direct policy test for a gesture nothing else produces. Leaving upstream's policy intact keeps that file conflict-free at every sync.

## Consequences

An accidental Enter inserts a newline instead of sending, and one delivery rule — the busy-Enter setting — covers the chord and the Send button in every session state; the Settings row copy names both. Keyboard-only submission requires the chord, the whole-queue keyboard flush is gone (per-row Steer in QueueDock remains), and Web e2e scenarios that submitted with plain Enter press Control+Enter. The three `steering.e2e.ts` describes pinning the inverted chord and the whole-queue gesture on recorded fixtures are fork-skipped with their restore path in the file, `subagent-interrupt-ui.e2e.ts` waits on the default placeholder instead of the deleted steer hint, and the `queued-image` and settings-dialog goldens carry the new placeholder and settings copy; re-recording the skipped scenarios needs `DSH_SNAPSHOT=record` and only pays off if the surface retires.

## Testing

`keymap-routing.client.spec.tsx` pins the plain-Enter line break and the chord-only submit through the real Lexical command layer. `input-bar.client.spec.tsx` pins the chord's preferred-mode delivery idle and running, the empty-draft no-op over queued and continuable-child sessions, and the placeholder fallbacks that replaced the steer hint. `pnpm run test:gui` is green beside two `ui-tool` failures proven pre-existing at HEAD.

## Related

- The retired first attempt, superseded here in amended form: [one composer submission path](../../archived/feature/2026-08-28-composer-submission-chord-and-button.md)
- The Send button resolving through the same mode: [the busy Send button follows the busy-Enter setting](../bug-fix/2026-09-04-busy-send-button-follows-enter-setting.md)
- The remaining queue-into-turn path: [steer a queued Web message into the active turn](../../archived/feature/2026-07-30-web-queue-steer-action.md)
