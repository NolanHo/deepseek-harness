# Agent Note: Turn continuation after a truncated or failed turn

Status: implemented

English | [中文](2026-09-20-turn-continuation-policy.zh.md)

## Problem

A turn that reaches the output-token ceiling ends the session: the loop records `turn/end` with reason `max-tokens`, `max-tokens` is a terminal turn outcome, and nothing in the shipped composition acts on it, so the unfinished answer waits for a human to type "continue". The existing turn-end continuation policies serve other purposes — [`goal-round-driver`](../../archived/feature/2026-07-19-same-session-goal-round-driver.md) continues its own goal rounds and disarms on `max-tokens`, while the Claude Code and Codex hook bridges force a continuation only for a user-authored external hook, with no cap (`TODO(stop-loop-guard)` in `packages/hooks/hooks-claude-code/src/index.ts` and `packages/hooks/hooks-codex/src/index.ts`).

## Decision

`@deepseek-ai/dsh-turn-continuation` is an opt-in plugin in the `guard` group, and no shipped profile mounts it. It opens one more turn after a turn closes with a configured reason: `continueOn` (default `['max-tokens']`) selects those reasons and `maxConsecutive` (default `2`) bounds them. A `continueOn` entry outside the continuable reasons `max-tokens` and `error` — among them `aborted`, `blocked`, `completed`, and `interrupted` — fails the plugin load, as does a `maxConsecutive` that is not a non-negative whole number; `maxConsecutive: 0` disables continuation without unmounting the plugin.

The plugin records the reason in the `session/event` `turn/end` observer and enqueues nothing there: `Session.append` rejects reentry while another append is being published, and the session's contained observer wrapper logs that rejection at warn level and contains it instead of propagating it, so an enqueue attempted from the observer never reaches the queue. It acts on the `agent/status` idle edge instead — it resolves the session back to its exact live Agent, claims the idle phase with `agent.runMaintenance()`, and calls `agent.followup()`, which queues an ordinary follow-up turn and wakes the driver; the wake is latched while the maintenance task owns the phase and is replayed when it settles. The truncated turn keeps its `max-tokens` reason, and the continuation is a separate ordinary turn; a busy phase throws synchronously, so nothing is spent and the next idle edge retries.

The budget counts consecutive continuations per human turn in a `WeakMap` keyed by the exact Agent, and it refills only when `agent/inbox/claimed` reports a message whose `source.kind === 'user'` — the wake budget rule `tool-jobs` ships. Every continuation is a durable `user/message` carrying the `{kind: 'plugin', plugin: 'turn-continuation'}` source, so the transcript never presents it as human input and the message never refills the budget it spent. Continuation authority is process-local: `agent/session-start` drops the recorded reason and the budget, and a resumed session has observed no `turn/end` in this process, so it never continues on its own — [the recorded rule](2026-07-16-harness-level-loop.md) is that opening a session is observation, not authority to spend resources.

## Alternatives considered

Each rejection was checked against the shipped code.

**Do it in `agent-loop` as a built-in policy.** Rejected: the recorded design rejects adding a generic loop abstraction to `agent-loop` ([the harness-level loop](2026-07-16-harness-level-loop.md)), and this behavior composes through existing extension points — the session event stream, the Agent idle phase, and the Agent queue — with no loop change and no new session event.

**Steer at `agent/turn-stopping` so the same turn continues.** Rejected for this plugin: the turn would still read `max-tokens`, an asynchronous evaluator would hold the turn open, and the requested behavior is a new turn after the turn has ended. A synchronous, same-turn continuation is what the hook bridges do.

**Build a pluggable judge or evaluator extension point now, including a model that reads the transcript.** Rejected for now: the package rules require a current owner and need for each abstraction, and a transcript-only model evaluator is [recorded as rejected](2026-07-16-harness-level-loop.md) on trust grounds rather than merely deferred; the extension point belongs in the change that brings a second judge.

**Persist the budget so continuation survives a restart.** Rejected: the recorded rule is that opening or resuming a session must wait for human input, and durable state records status, not fresh authority to spend resources ([the same-session goal domain](2026-07-19-persisted-same-session-goal-domain.md)).

**Fork a child agent to evaluate the turn.** Rejected for this version: the base and headless compositions keep forked children one-shot ([forked children preserve the parent request prefix](../architecture/2026-08-10-fork-children-stay-one-shot.md)), where `send_message` to the parent is refused and the result returns only through the delegation tool result; a fork also copies the retained history into the child's session and request; and the rule-based policy needs no model call. Shipped CLI presets may bind fork to the continuable lifecycle, where a resident child can write into the origin session — that path still spends a child session and a model call on a decision the recorded reason already makes.

## Consequences

A truncated turn recovers without human input, bounded to `maxConsecutive` continuations per human turn; the injected message is a durable `user/message` carrying the `{kind: 'plugin', plugin: 'turn-continuation'}` source, so the transcript never presents it as human input and the refill rule can distinguish it; the `turn/end` reason contract is unchanged, because the truncated turn still reads `max-tokens`; and the policy adds no `agent-loop` code and no new session event.

The cost is model calls spent without a human prompt, up to the configured bound per human turn, and a decision made from the recorded reason alone rather than a judgment about whether the answer was complete.

Known gaps: there is no independent evaluator; the goal-round driver still disarms on `max-tokens` on its own, so a goal task does not gain goal-round continuation from this plugin; and the hook bridges still force uncapped continuations from an external hook, a pre-existing hole carrying the `TODO(stop-loop-guard)` marker.

## Testing

`packages/guard/turn-continuation/tests/turn-continuation.spec.ts` drives the policy through a real agent loop against a scripted adapter and pins the reason gate for `max-tokens` and `error` (with the durable reasons `[{kind: 'max-tokens'}, {kind: 'completed'}]` for a truncated turn the plugin continued), the `maxConsecutive` bound, refill on a later human turn, refusal to refill on the plugin's own message, the fail-loud config rejections, a zero budget that still records the truncation, and disposal.
