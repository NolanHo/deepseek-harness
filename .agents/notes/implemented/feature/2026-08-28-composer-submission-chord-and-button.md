# Agent Note: One composer submission path — Enter is a newline, Cmd/Ctrl+Enter and the send button share the busy-state policy

Status: implemented

English | [中文](2026-08-28-composer-submission-chord-and-button.zh.md)

## Problem

The composer had three submission surfaces with three different rules: plain Enter submitted (Queue by the busy-Enter preference), Cmd/Ctrl+Enter submitted with the opposite delivery mode, the send button always queued, and while an ordinary session ran the primary button swapped to Stop so it could not send at all. Enter-as-send also fired accidental sends while typing, and the empty-draft Cmd/Ctrl+Enter chord meant "steer the whole queue" — a queue-mutating meaning unrelated to submission. The observed failure mode: messages landed in the running turn when the user believed they had queued them, because the delivery mode depended on which key they pressed.

## Decision

Web composer submission has one model:

- Enter and Shift+Enter insert newlines. Only Cmd/Ctrl+Enter submits; an open command menu still claims Enter to pick the highlighted option.
- The send button and the Cmd/Ctrl+Enter chord share one submission path, `ComposerSubmissionPolicy.resolve(running, steeringAvailable)`: outside steer-capable busy state every submission is Queue; while a steer-capable session runs, the persisted `ui-conversation.busyEnter` preference (default `queue`) selects Queue or Steer for both. There is no chord inversion.
- While any sendable session runs (ordinary or continuable subagent), the primary control stays Send with an independent Stop button beside it; one-shot subagent runs expose neither. This supersedes and consolidates the running-draft primary-Send decision: it keeps that note's fix (a running actionable draft submits through the pointer control instead of stopping the turn, issue #2850) but generalizes the continuable-subagent two-control pattern to ordinary sessions, and it reverses that note's "never apply the busy-Enter preference to the pointer" guard — delivery must come from the setting alone so the chord and the button cannot diverge.
- The empty-draft whole-queue steer chord is removed: Cmd/Ctrl+Enter on an empty draft is a no-op like the button. The QueueDock per-row strict steer remains the only way to transfer a queued occurrence into the running turn. This note consolidates and supersedes the whole-queue gesture note; its motivation, removal rationale, and reintroduction conditions are recorded below and its triplet is deleted in the same change.
- The settings row copy becomes `繁忙时发送行为` / `Send behavior while busy`; the persisted field name and default stay `busyEnter` / `queue` under the [preference persistence decision](../bug-fix/2026-08-06-host-backed-web-preferences.md).

Consolidated from the removed whole-queue gesture note: the gesture existed because an empty composer draft had no keyboard action and steering several queued rows one by one was multi-click friction. It lost because it overloaded the submit chord with a queue-mutation meaning and its only discovery surface was an empty-draft placeholder hint. Once Enter stops sending, the chord is the sole submit gesture and must behave like the send button everywhere — the empty-draft no-op preserves that. Alternatives to full removal were keeping the chord as a whole-queue flush (rejected: it re-splits chord semantics from the button) or moving the flush to a dock-level button (deferred: the per-row action exists). The capability given up is the whole-queue keyboard flush; if the need returns, a dock-level steer-all affordance is the natural home, and the submit chord must not be re-overloaded. Complete absence is verified by deleting `ComposerKeyboard.steerQueue`, `InputHub.steerQueue`, the placeholder copy, the `expected/steer-all` e2e scenario, and its Agent Note triplet: `rg steerQueue` and `rg STEER_ALL` return nothing.

## Alternatives considered

- **Keep the chord inversion (chord = opposite of the preference).** Rejected: delivery should depend on the setting alone; two mirrored rules on two keys is the confusion this change removes.
- **Keep Enter submitting and only Shift+Enter as newline.** Rejected: Enter-as-newline is the requested accident prevention, and Shift+Enter was already a newline.
- **Keep the send button queued-only.** Rejected: the button and the chord would diverge while busy — the exact inconsistency reported.
- **Keep Stop as the running primary button.** Rejected: while busy the button must send like the chord; the continuable-subagent independent-Stop pattern generalizes to ordinary sessions so the stop affordance survives.
- **Keep the empty-draft whole-queue chord.** Rejected: it gave the submit chord a second, queue-mutating meaning (see Decision).

## Consequences

- One delivery rule covers every submission surface; steering is produced only by the busy-state preference, so the reported "always inserted into the loop" surprise can no longer come from the key used.
- The composer is multiline by default: Enter inserts newlines (the Lexical editor already handled multiline drafts through Shift+Enter).
- Keyboard-only users must press Cmd/Ctrl+Enter to send — the deliberate accident-prevention trade-off.
- The whole-queue keyboard flush capability is gone; per-row strict steer remains in QueueDock.
- Web e2e scenarios that submitted with plain Enter now press Control+Enter. Under `DSH_SNAPSHOT=refresh` the settings-dialog goldens re-record the new row copy, and the queue-actions, turn-tail-actions, live-interactions, and streaming-fence goldens gain the disabled `Send message` button of the running composer chrome; the steering goldens only pick up the unrelated fold-copy label from the fork's own commits.

## Related

- Per-row strict steer and its host boundary: [Steer a queued Web message into the active turn](../feature/2026-07-30-web-queue-steer-action.md)
- Preference persistence boundary: [Persist Web user preferences through Host settings](../bug-fix/2026-08-06-host-backed-web-preferences.md)
