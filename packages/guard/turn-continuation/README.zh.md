---
description: "轮次结束续接策略：轮次因截断或模型请求失败而结束时再开一个轮次，由只有人类输入才会补充的预算封顶，供选择、配置或排查此插件的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-turn-continuation

[English](README.md) | 中文

## 概述

本包在轮次提前结束时让任务继续推进。轮次因某一步达到输出 token 上限而结束，或因其模型请求失败而结束时，本包会在同一会话中再开一个轮次，并携带一条要求模型从停下的位置继续的提示词。有界预算为这些自动轮次封顶，且只由人类输入补充，因此无人值守的会话在达到上限后停止。已完成、已取消或被阻止的轮次绝不会被续接。本包为可选启用：部署方通过一行 profile patch 启用它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当提前结束的轮次应当自行续接、而不是等待下一条人类消息时，挂载此插件。

### 何时选择

当长时间的自主工作中，被截断或失败的轮次会让任务停在中途、而下一条人类消息可能很久以后才到时，选择它。当无人值守阶段的 token 消耗必须保持平稳，或结束轮次的失败应当先由人类看到、再让模型重试时，避免使用它。

### 在部署中启用

本包为可选启用：随产品发布的 `dsh-base` 组合中没有它的行。部署方通过在自己的 profile patch 中添加一行来启用它；patch 层在组合之后应用，并向组合插入新行：

```yaml
- insert:
    - id: turn-continuation
      name: '@deepseek-ai/dsh-turn-continuation'
      config:
        continueOn: [max-tokens, error]
        maxConsecutive: 2
```

### 配置字段

| 字段 | 默认值 | 含义 |
|---|---|---|
| `continueOn` | `['max-tokens']` | 会开启另一个轮次的结束原因种类；只接受 `max-tokens` 与 `error` |
| `maxConsecutive` | `2` | 两次人类输入之间本插件可开启的自动轮次数；`0` 在不卸载插件的情况下禁用续接 |

配置错误会在插件加载时以错误失败，绝不会静默改变行为。`continueOn` 中出现 `max-tokens` 与 `error` 之外的条目——`completed`、`aborted`、`blocked`、`interrupted` 或未知名称——会抛出错误；`maxConsecutive` 不是非负整数时同样抛出错误。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节说明策略如何记录轮次结束、何时开启下一个轮次、以及预算如何花费；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 记录结束原因

插件监听 `session/event`，对每个观察到的 `turn/end` 通过 `ctx.agents` 解析出该会话的活跃 agent，并保存其结束原因。它绝不在该监听器中入队输入：当一个会话追加正在发布时，另一次追加无法重入，因此在那里的入队会被拒绝，且该拒绝会被吞掉。会话不是该 agent 当前会话的事件会被忽略，记录的原因保存在 `WeakMap<Agent, TurnEndReason>` 中等待。

### 在空闲边沿行动

`agent/status` 转入 `idle` 是插件唯一的行动点。它会重新确认插件 fiber 处于活动状态、agent 注册表仍把该 agent 的 id 映射到同一个对象、且记录的原因种类在 `continueOn` 中。随后它用 `agent.runMaintenance()` 认领 agent 的真正空闲阶段，并用该原因对应的提示词调用 `agent.followup()`，从而开启一个新轮次：已经结束的轮次早已关闭，因此这次续接是同一会话中的一个普通新轮次。忙碌阶段会让 `runMaintenance()` 同步抛出，此时不花费预算，下一个空闲边沿会重试。

### 预算与补充

每个 agent 一份计数，记录自该 agent 上次消费人类输入以来本插件开启的轮次数。当被认领消息的来源种类为 `user` 时，`agent/inbox/claimed` 会清除该计数；续接消息被标记为 `{kind: 'plugin', plugin: 'turn-continuation'}`，因此认领它绝不会补充刚刚花掉的预算。达到上限时，插件记录一条警告并等待人类输入。`agent/session-start` 会同时清除计数与记录的原因，因此恢复的会话与同会话中替换的 agent 都从满预算开始。dispose（资源释放）会把插件锁定为停止状态，`ctx.effect()` 安装器负责它注册的每个监听器。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、加载时校验、`session/event` 记录器与 `agent/status` 空闲边沿动作 |
| — | 不发布运行时 invariant 伴随；该插件不拥有包自有 session 事件、持久投影或独立派生状态，因此不存在可能与另一处观测发生分歧的对象。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。

- [会话子系统参考](../../../docs/subsystems/session.zh.md)——`turn/end` 事件与可续接的 `TurnEndReasonMap` 原因。
- [核心子系统参考](../../../docs/subsystems/core.zh.md)——本策略所依据的 `Agent` 句柄、`runMaintenance()`、`followup()` 与 `agent/*` 生命周期事件。
- [repeat-tool-reminder 包 README](../repeat-tool-reminder/README.zh.md)——同一 `guard/` 组中的兄弟建议性 guard。

-----

<a id="model-experience"></a>
## 模型体验

### 截断轮次的续接

#### 模型看到什么

当轮次以 `max-tokens` 结束且 `continueOn` 包含 `max-tokens` 时，插件把下面的消息作为 user 角色的消息追加，并用它开启一个新轮次。本包不添加工具 schema、系统提示词文本或自己的任何结果。

##### 截断续接提示词

```markdown
Your previous reply was cut off because it reached the output-token limit, before it finished. Everything you already produced is preserved in this conversation. Continue the same task from exactly where it stopped: do not repeat output you already produced, and do not restart work that is already done. Finish the task, then stop normally.
```

#### Token 影响

每个自动轮次一条固定长度的消息，作为会话历史保留到会话结束；`maxConsecutive` 限制两次人类输入之间能添加多少条这样的消息。

#### KV Cache 影响

仅追加；该消息位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。提供方缓存的可用性与回收不在本包约定之内。

### 失败轮次的续接

#### 模型看到什么

当轮次以 `error` 结束且 `continueOn` 包含 `error`（默认不含）时，插件把下面的消息作为 user 角色的消息追加，并用它开启一个新轮次。该消息不会复现记录的失败细节。

##### 失败续接提示词

```markdown
Your previous attempt ended when its model request failed, so the turn did not finish. The conversation so far is preserved. Resume the same task: retry whatever failed, and if the same failure happens again, stop and report the concrete error instead of retrying the same call.
```

#### Token 影响

每个自动轮次一条固定长度的消息，作为会话历史保留到会话结束；文本不随记录的失败变化，因此其 token 数是恒定的。

#### KV Cache 影响

仅追加；该消息位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。提供方缓存的可用性与回收不在本包约定之内。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明该策略何时不合适。它们是当前包约束，不是任务积压。

- **续接仅限进程内**——记录的原因与已花费计数保存在以活跃 agent 为键的 `WeakMap` 中，因此续接绝不会跨会话重启存活：恢复的会话在新进程中没有观察到任何 `turn/end`，也就不会自行续接。
- **预算只由人类输入补充**——上限统计自最后一条人类撰写的消息以来的自动轮次，因此无人值守的会话在 `maxConsecutive` 次续接后停止，并停在那里直到人类再次输入。
- **只有两种可续接原因**——只有 `max-tokens` 与 `error` 会开启另一个轮次；`aborted`、`blocked`、`completed`、`interrupted` 的轮次绝不会被续接，未知或不可续接的 `continueOn` 条目会在加载时抛出错误，而不是静默地什么都不续接。
- **没有独立评估者**——插件只对循环记录的结束原因作出反应，不判断工作是否真的完成，因此任务已经完成却仍触及 token 上限的轮次同样会再得到一个轮次。
- **不复用上下文**——一次续接向同一会话追加一条新的 user 角色消息，不复制任何历史，因此下一次请求会以普通前缀增长的方式再次携带整个会话。
- **提示词文本固定**——两条提示词都不插值记录的原因数据，因此续接消息不包含工具名、错误码或 token 数，模型需要从会话中读取失败信息。
- **预算以活跃 agent 为键**——已花费计数按 agent 对象存放，因此同会话中替换的 agent 从满预算开始，绝不会继承前一个 agent 已花费的轮次。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文、包代码和相关 Agent Note 为准。

[turn-continuation 策略 Agent Note](../../../.agents/notes/implemented/feature/2026-09-20-turn-continuation-policy.zh.md)记录了设计、哪些结束原因可以续接与预算规则。

</details>
