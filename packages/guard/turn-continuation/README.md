---
description: "Turn-end continuation policy that opens one more turn after a truncated or failed turn, bounded by a budget only human input refills, for users and maintainers choosing, configuring, or debugging the plugin."
kind: "package-reference"
---

# @deepseek-ai/dsh-turn-continuation

English | [中文](README.zh.md)

## Summary

This package keeps a task moving when a turn stops early. A turn that ended because a step hit the output-token ceiling, or because its model request failed, gets one more turn in the same conversation, carrying a prompt that tells the model to resume where it stopped. A bounded budget caps those automatic turns and refills only on human input, so an unattended session stops after the cap. A completed, cancelled, or blocked turn is never continued. The package is opt-in: a deployment enables it with a profile patch row.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when a turn that stops early should resume on its own instead of waiting for the next human message.

### When to choose it

Choose it for long autonomous work where a truncated or failed turn leaves the task unfinished and the next human message may be far away. Avoid it where unattended token spend must stay flat, and where the failure that ended a turn should reach a human before the model tries again.

### Enabling it in a deployment

The package is opt-in: the shipped `dsh-base` bundle carries no row for it. A deployment enables it by adding a row to its profile patch, which applies after the bundles and inserts new rows into the composition:

```yaml
- insert:
    - id: turn-continuation
      name: '@deepseek-ai/dsh-turn-continuation'
      config:
        continueOn: [max-tokens, error]
        maxConsecutive: 2
```

### Config fields

| Field | Default | Meaning |
|---|---|---|
| `continueOn` | `['max-tokens']` | Turn-end reason kinds that open another turn; only `max-tokens` and `error` are accepted |
| `maxConsecutive` | `2` | Automatic turns this plugin may open between two human inputs; `0` disables continuation without unmounting the plugin |

Misconfiguration fails at plugin load with an error, never as a silent change of behavior. A `continueOn` entry outside `max-tokens` and `error` — `completed`, `aborted`, `blocked`, `interrupted`, or an unknown name — throws, and `maxConsecutive` throws unless it is a non-negative whole number.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the policy records a turn end, when it opens the next turn, and how the budget is spent; the observable behavior is covered in [Use this package](#use-this-package).

### Recording the turn-end reason

The plugin listens on `session/event` and stores the reason of each `turn/end` it observes for the session's live Agent, resolved through `ctx.agents`. It never enqueues input from that listener: a session append cannot reenter while another append is being published, so an enqueue there would be rejected and the rejection would be swallowed. An event whose session is not that Agent's current session is ignored, and the recorded reason waits in a `WeakMap<Agent, TurnEndReason>`.

### Acting on the idle edge

The `agent/status` transition to `idle` is the only place the plugin acts. It re-checks that the plugin fiber is active, that the agent registry still maps the Agent's id to this same object, and that the recorded reason kind is in `continueOn`. It then claims the Agent's true idle phase with `agent.runMaintenance()` and calls `agent.followup()` with the prompt for that reason, which opens a new turn: the turn that ended has already closed, so the continuation is an ordinary new turn in the same session. A busy phase throws synchronously from `runMaintenance()`, nothing is then spent from the budget, and the next idle edge retries.

### The budget and its refill

A per-Agent count holds the turns this plugin opened since that Agent last consumed human input. `agent/inbox/claimed` clears the count when the claimed message's source kind is `user`; a continuation is stamped `{kind: 'plugin', plugin: 'turn-continuation'}`, so claiming one never refills the budget it just spent. At the cap the plugin logs a warning and waits for human input. `agent/session-start` clears both the count and the recorded reason, so a resumed session and a same-session Agent replacement each start with a full budget. Disposal latches the plugin stopped, and the `ctx.effect()` installer owns every listener it registers.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, load-time validation, the `session/event` recorder, and the `agent/status` idle-edge action |
| — | No runtime invariant companion is published; the plugin owns no package-specific session event, no durable projection, and no independently derived state, so it has no observation that can diverge from another. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [Session subsystem reference](../../../docs/subsystems/session.md) — the `turn/end` event and the `TurnEndReasonMap` reasons that qualify for continuation.
- [Core subsystem reference](../../../docs/subsystems/core.md) — the `Agent` handle, `runMaintenance()`, `followup()`, and the `agent/*` lifecycle events this policy acts on.
- [repeat-tool-reminder package README](../repeat-tool-reminder/README.md) — the sibling advisory guard in the same `guard/` group.

-----

<a id="model-experience"></a>
## Model Experience

### Truncated turn continuation

#### What the model sees

When a turn ends `max-tokens` and `max-tokens` is in `continueOn`, the plugin appends the message below as a user-role message and opens a new turn with it. The package adds no tool schema, no system-prompt text, and no result of its own.

##### Truncation continuation prompt

```markdown
Your previous reply was cut off because it reached the output-token limit, before it finished. Everything you already produced is preserved in this conversation. Continue the same task from exactly where it stopped: do not repeat output you already produced, and do not restart work that is already done. Finish the task, then stop normally.
```

#### Token effect

One fixed-length message per automatic turn, retained as conversation history for the rest of the session; `maxConsecutive` bounds how many of these messages one human turn can add.

#### KV Cache effect

Append-only; the message follows the reusable request prefix and does not invalidate existing KV-cache entries. Provider cache availability and eviction remain outside the package.

### Failed turn continuation

#### What the model sees

When a turn ends `error` and `error` is in `continueOn` — it is not in the default — the plugin appends the message below as a user-role message and opens a new turn with it. The recorded failure details are not reproduced in this message.

##### Failure continuation prompt

```markdown
Your previous attempt ended when its model request failed, so the turn did not finish. The conversation so far is preserved. Resume the same task: retry whatever failed, and if the same failure happens again, stop and report the concrete error instead of retrying the same call.
```

#### Token effect

One fixed-length message per automatic turn, retained as conversation history for the rest of the session; the text does not vary with the recorded failure, so its token count is constant.

#### KV Cache effect

Append-only; the message follows the reusable request prefix and does not invalidate existing KV-cache entries. Provider cache availability and eviction remain outside the package.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the policy is a poor fit. They are current package constraints, not a task backlog.

- **Process-local continuation** — the recorded reason and the spent count live in `WeakMap`s keyed by the live Agent, so continuation never survives a session restart: a resumed session observes no `turn/end` in the new process and never continues on its own.
- **Budget refills only on human input** — the cap counts automatic turns since the last human-authored message, so an unattended session stops after `maxConsecutive` continuations and parks until a human writes again.
- **Two continuable reasons only** — `max-tokens` and `error` open another turn; an `aborted`, `blocked`, `completed`, or `interrupted` turn is never continued, and an unknown or non-continuable `continueOn` entry throws at load instead of continuing nothing silently.
- **No independent evaluator** — the plugin reacts to the loop's recorded turn-end reason and does not judge whether the work is actually finished, so a turn that hit the token ceiling after the task was complete still receives another turn.
- **No context duplication** — a continuation appends one new user-role message to the same session and copies no history, so the next request carries the whole conversation again as ordinary prefix growth.
- **Fixed prompt text** — neither prompt interpolates the recorded reason's data, so the continuation message names no tool, error code, or token count, and the model reads the failure from the conversation instead.
- **Budget keyed by the live Agent** — the spent count is stored per Agent object, so a same-session Agent replacement starts with a full budget and never inherits the previous Agent's spent turns.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Note.

The [turn-continuation policy Agent Note](../../../.agents/notes/implemented/feature/2026-09-20-turn-continuation-policy.md) records the design, which turn-end reasons are continuable, and the budget rule.

</details>
