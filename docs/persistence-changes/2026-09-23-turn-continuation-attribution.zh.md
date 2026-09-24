---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-23-turn-continuation-attribution

[English](2026-09-23-turn-continuation-attribution.md) | 中文

## 概述

将本 fork 自有的 `turn-continuation` 消息来源 kind 限定为归因（attribution）。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

既有记录仍然有效，不修改任何已存字节。该 kind 标记的是续跑策略自己打开的 user 角色消息，因此模型自己的续跑回合不会被误认为人类输入。不认识该 kind 的读取方仍会保留该消息及其 JSON 元数据：校验从不枚举来源 kind，回放直接从已存日志推导消息而不需要写入方，唯一涉及权威的读取是补满预算时对核心 `user` kind 的判断，而未知 kind 与 `turn-continuation` 一样都不满足该判断。恢复重复抑制也不需要该 kind 的投影。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/guard/turn-continuation：2 个文件、20 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
