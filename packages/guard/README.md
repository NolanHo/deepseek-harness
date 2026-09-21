---
description: "Package map for the loop-hygiene guard family: the advisory repeat-tool reminder, the per-call tool-call timeout policy, and the opt-in turn-end continuation policy, for users and maintainers choosing or composing the guards."
kind: "package-group"
---

# guard/ — loop-hygiene guard family

English | [中文](README.zh.md)

## Summary

The `guard/` group keeps the agent loop productive by watching for three common failure patterns. `repeat-tool-reminder` reminds the model when it repeats the same tool call, so it changes approach or finishes. `timeout-policy` times out tool calls that declare a limit, returning a clear error instead of waiting forever. `turn-continuation` opens a new turn when one ends with a configured reason, `max-tokens` by default, bounded per human turn and refilled only by human input. The first two ship enabled in the `dsh` base bundle; `turn-continuation` is opt-in, enabled by a profile patch row naming `@deepseek-ai/dsh-turn-continuation`.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Three small plugins cover the three patterns; each README below explains when to keep, tune, or remove it.

| Package | What it provides |
|---|---|
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.md) | Reminds the model when it repeats the same tool call, so it changes approach or finishes |
| [`timeout-policy/`](timeout-policy/README.md) | Times out tool calls that declare a limit, so the model gets a clear error instead of waiting forever |
| [`turn-continuation/`](turn-continuation/README.md) | Opens a new turn when one ends with a configured reason (`max-tokens` by default), so an answer cut off at the output-token ceiling continues the task |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the tools subsystem reference for the tool-call pipeline, then the reminder's configuration and the timeout-library decision behind the policy.

- [Tools subsystem reference](../../docs/subsystems/tools.md) — the tool-call pipeline and decisions the two tool-call guards build on.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-repeat-tool-reminder) — every accepted field of the repeat-call reminder.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-turn-continuation) — every accepted field of the turn-end continuation policy.
- [Timeout deadline library Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md) — the timing/termination split `timeout-policy` enforces.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
