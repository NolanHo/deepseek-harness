# Agent Note: 截断或失败的轮次之后继续

Status: implemented

[English](2026-09-20-turn-continuation-policy.md) | 中文

## 问题

达到输出 token 上限的轮次会让会话停下：循环记录原因为 `max-tokens` 的 `turn/end`，而 `max-tokens` 是轮次的终态结果，随仓库发布的组合中没有任何东西依据它行动，因此未完成的回答只能等待人类输入"继续"。既有的轮次结束继续策略各有用途——[`goal-round-driver`](../../archived/feature/2026-07-19-same-session-goal-round-driver.md) 只继续自己的 Goal Round，并在 `max-tokens` 上解除激活；Claude Code 与 Codex 钩子桥接仅在用户编写的外部钩子要求时强制继续，且没有上限（`packages/hooks/hooks-claude-code/src/index.ts` 与 `packages/hooks/hooks-codex/src/index.ts` 中的 `TODO(stop-loop-guard)`）。

## 决策

`@deepseek-ai/dsh-turn-continuation` 是 `guard` 分组中的选择性启用插件，没有任何随仓库发布的 profile 挂载它。它在轮次以配置的原因结束后再开一个轮次：`continueOn`（默认 `['max-tokens']`）选择这些原因，`maxConsecutive`（默认 `2`）限定其数量。`continueOn` 中出现可继续原因 `max-tokens` 与 `error` 之外的条目——包括 `aborted`、`blocked`、`completed` 和 `interrupted`——会让插件加载失败，`maxConsecutive` 不是非负整数时同样失败；`maxConsecutive: 0` 无需卸载插件即可关闭继续。

插件在 `session/event` 的 `turn/end` 观察者中记录原因，且不在那里入队：当另一次 append 正在发布时，`Session.append` 会拒绝重入，而 session 自身的 contained observer 包装器会以 warn 级别记录该拒绝并将其隔离，不再向外传播，因此从观察者发起的入队永远到不了队列。它改为在 `agent/status` 的空闲边上行动——把会话解析回其确切的实时 Agent，用 `agent.runMaintenance()` 领取空闲阶段，再调用 `agent.followup()`，后者排队一个普通 follow-up 轮次并唤醒驱动器；维护任务持有该阶段期间唤醒被暂存，并在其结算时重放。被截断的轮次保留其 `max-tokens` 原因，继续是一个独立的普通轮次；忙碌阶段会同步抛出，因此不消耗任何预算，下一个空闲边会重试。

预算以确切 Agent 为键存放在 `WeakMap` 中，统计每个人类轮次内的连续继续次数，且仅当 `agent/inbox/claimed` 报告 `source.kind === 'user'` 的消息时才回填——即 `tool-jobs` 随仓库发布的唤醒预算规则。每次继续都是一条持久 `user/message`，携带 `{kind: 'plugin', plugin: 'turn-continuation'}` 来源，因此 transcript 绝不把它呈现为人类输入，该消息也绝不回填自己刚花掉的预算。继续授权是进程本地的：`agent/session-start` 丢弃记录的原因与预算，而恢复的会话在本进程中从未观察到 `turn/end`，因此绝不会自行继续——[已记录的规则](2026-07-16-harness-level-loop.zh.md)是：打开会话是观察，不是花费资源的授权。

## 备选方案

每条否决都已对照实际发布的代码核查。

**在 `agent-loop` 中作为内建策略实现。** 不予采纳：已记录的设计拒绝向 `agent-loop` 添加通用循环抽象（[harness-level loop](2026-07-16-harness-level-loop.zh.md)），而该行为通过既有扩展点组合而成——会话事件流、Agent 空闲阶段与 Agent 队列——无需改动循环，也无需新增会话事件。

**在 `agent/turn-stopping` 上 steer，使同一轮次继续。** 本插件不予采纳：该轮次仍会读到 `max-tokens`，异步 evaluator 会让轮次保持打开，而要求的行为是轮次结束之后再开一个轮次。同步的同轮次继续正是钩子桥接的做法。

**现在就构建可插拔的 judge 或 evaluator 扩展点，包括读取 transcript 的模型。** 暂不予采纳：包规则要求每个抽象都有当前所有者与需求，而仅凭 transcript 的模型 evaluator 已被[记录为否决](2026-07-16-harness-level-loop.zh.md)，理由是其可信度不足，而非仅仅推迟；该扩展点应在第二个 judge 真正出现时随那次变更抽取。

**持久化预算，使继续在重启后仍然有效。** 不予采纳：已记录的规则是打开或恢复会话必须等待人类输入，而持久状态记录的是状态，不是花费资源的新授权（[同一会话目标域](2026-07-19-persisted-same-session-goal-domain.zh.md)）。

**fork 一个子 agent 来评估轮次。** 本版本不予采纳：base 与 headless 组合让 fork 出的子 agent 保持一次性（[Fork child 保留 parent 请求前缀](../architecture/2026-08-10-fork-children-stay-one-shot.zh.md)），此时发给父级的 `send_message` 会被拒绝，结果只能经委派工具结果返回；fork 还会把保留的历史复制进子会话与其请求；而基于规则的策略不需要模型调用。随仓库发布的 CLI preset 可以把 fork 绑定到可继续生命周期，此时常驻子 agent 能写进源会话——这条路径仍要花一个子会话和一次模型调用，去决定记录的原因本就决定的事。

## 影响

被截断的轮次无需人类输入即可恢复，并按每个人类轮次限定在 `maxConsecutive` 次继续之内；注入的消息是一条持久 `user/message`，携带 `{kind: 'plugin', plugin: 'turn-continuation'}` 来源，因此 transcript 绝不把它呈现为人类输入，回填规则也能区分它；`turn/end` 原因契约不变，因为被截断的轮次仍然读作 `max-tokens`；该策略不添加 `agent-loop` 代码，也不新增会话事件。

代价是在没有人类提示的情况下花费模型调用，上限为每个人类轮次配置的额度，并且决策只依据记录的原因，而不是对回答是否完整的判断。

已知缺口：没有独立 evaluator；goal-round driver 仍会独立地在 `max-tokens` 上解除激活，因此目标任务不会从本插件获得 Goal Round 继续；钩子桥接仍会从外部钩子强制无上限继续，这是既有的漏洞，带有 `TODO(stop-loop-guard)` 标记。

## 测试

`packages/guard/turn-continuation/tests/turn-continuation.spec.ts` 通过真实 agent loop 对脚本化 adapter 驱动该策略，钉住 `max-tokens` 与 `error` 的原因门禁（被插件继续的截断轮次，其持久原因为 `[{kind: 'max-tokens'}, {kind: 'completed'}]`）、`maxConsecutive` 上限、后续人类轮次的回填、插件自身消息不回填、配置的失败即报错、保留截断记录的零预算，以及资源释放。
