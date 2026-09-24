---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-23-turn-continuation-attribution

English | [中文](2026-09-23-turn-continuation-attribution.zh.md)

## Summary

Qualifies the fork-owned `turn-continuation` message-source kind as an attribution.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-23-turn-continuation-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-16-session-format-v4"
    after: "5cd74cdd0e3e659939e0ef3f250ee101fb30851989379ea1aef54ff15911d09c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "e706910007619bbe32cd2cb13e884e01315305df76d8af77796970f3b94b8d6a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "20fe8c3f04c8fbd73b2302ccfa9fc52412525160c7e446bedfab55b30603d13c"
    decision: same-version
  - root: "event:subagent/descriptor"
    previous: "2026-09-11-initial"
    after: "4982de141b95c30189ce5488ffbd694a6a6d4bb4a9a8127575b05e1976a0f0b1"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "ec9a201e6cfe3d91447a7057dea85af8c28043169c92123a479781a8581578c5"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid; no stored byte changes. The kind labels a user-role message the continuation policy opened itself, so the model's own turn is never mistaken for human input. Readers that do not know the kind preserve the message and its JSON metadata: validation never enumerates source kinds, replay derives the message from the stored log without the producer, and the only authority read is the refill check for the core `user` kind, which an unknown kind leaves unsatisfied exactly as `turn-continuation` does. No projection needs the kind to resume duplicate suppression.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/guard/turn-continuation: 2 files, 20 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
