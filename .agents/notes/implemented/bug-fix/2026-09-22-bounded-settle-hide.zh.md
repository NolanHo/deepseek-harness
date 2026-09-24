# Agent Note: 会话 composer 的 settle 隐藏加时限

Status: implemented

[English](2026-09-22-bounded-settle-hide.md) | 中文

> 范围：会话 composer 座位因 settling 触发的隐藏，以及 fork 给它加的上限。[ui-conversation](../../../../packages/client/ui-conversation/README.zh.md) README 拥有该包的 composer 与 shell 契约。

## Problem

桌面端会出现 composer 无故消失、只有刷新页面才回来的情况。在部署实例上复现（1440×900，独立浏览器会话）：把 GUI 恢复到一个 continuable 子代理会话，同时让父目录读取失败一次（`POST /api/subagents/list` 返回 `gateway/internal`）——`data-phase` 一直停在 `settling`，136px 的 `[data-composer-seat]` 一直 `visibility: hidden`（占位保留，列不会重排），转写完整渲染（133 轮），该状态在 +4/+6/+8 秒后依然如此；重新点选同一个子会话不会发起新的目录读取；在读取恢复正常后刷新，phase 变为 `active`、座位重新可见。

隐藏本身只有一条规则：`.root[data-phase='settling'] .composerSeat { visibility: hidden }`（`ConversationRoot.module.css`），而 `settling` 的两个输入都是**不保证会落定**的异步事实：

- **父可用性未解析。** `parentAvailable` 只由**成功**的 `subagents.list` 读取写入：成功分支通知该父会话的每个已寻址子会话，两个失败分支最多保留旧值、不通知任何人（`packages/api/session-controller/src/client/sessions/manager.ts`）。重新点选子会话刷新的是子会话自己的目录，永远不是父会话的，因此导航既不会重试该读取也不会修复该状态；读取挂起还会占住 manager 的 single-flight 条目，而 RPC 层没有超时。于是恢复进 continuable 子会话的页面会一直等待一个可能永不落定的读取。
- **历史打开未落定。** `Session.doOpen` 等待日志首帧时没有超时，且对非 remote 异常直接 rethrow、不改 `openState`，把它留在 `loading`（`packages/api/session-controller/src/client/sessions/session.ts`）。

这两条路径都只是把座位藏起来；界面其他部分完全正常，而拥有该座位的选举方（`packages/client/ui-subagent/src/client/index.ts` 的 `selectReadOnlySubagent`）本来就刻意在父可用性未知时保留正常 composer——只有父会话**已知离线**时才接管。

## Decision

`packages/client/ui-conversation/src/client/skeleton/settle-hide.ts` 新增 `useSettleHide(pending, resetKey, limitMs)` 与 `SETTLE_HIDE_LIMIT_MS = 5000`：一段连续的 pending 期间最多隐藏 5 秒，切换 Session 会重开窗口，条件清除后重新计时。`ConversationRoot` 把它的 `settlePending`（两个分支合一）交给该 hook，因此窗口到期后 `data-phase` 回落到 `hero` 或 `active`——对已有转写的 Session 即 `active`，也就是正常停靠的 composer。

这样隐藏对亚秒级 settle 仍保留原本的防闪烁作用，但不再比一个永不落定的读取或打开活得更久。5 秒高于所有观测到的健康 settle，也低于本部署自测的大父会话冷 `subagents.list` 成本（冷投影缓存下 7–8 秒），因此即便那种情况也会在读取完成前先还回 composer。

## Alternatives considered

**在 session manager 里重试父目录读取。** 它能修好失败的情况，但修不了挂起的读取（RPC 层没有超时，single-flight 条目会一直返回那个挂起的 promise），而且 UI 仍然没有自己的活性保证。留作后续工作，并记入包 README 的限制条目。

**把父可用性分支从 `settling` 中整个删掉。** 这样会丢掉读取落定为 `false` 时的防闪烁保护，也无法解决历史打开分支的无上限问题；加上限同时保住两者。

**移植上游基于摘要的父可用性。** 上游已把该事实换成 Host 摘要投影（`agentAvailable` + `updateParentAvailability`）；fork 落后于这次迁移，其摘要 wire 并不携带该字段，因此移植属于下一次上游同步，而不是一次客户端缺陷修复。

**给 Remote RPC 层加超时。** 那同样能让挂起的读取落定，但它是传输层的全局策略决定（所有 RPC、所有消费者），而不是针对该症状的修复。

## Consequences

composer 不会再因为一个永不落定的 settle 而丢失：最坏情况是座位不可见持续到上限，之后正常停靠的 composer 回来并接受输入。父目录未知的 continuable 子会话保留正常 composer——与选举方本来就选择的面一致——而父会话已知离线时仍会随时换上只读接管。窗口内 phase 仍是 `settling`，因此健康加载下抓取的快照不变。

## Testing

`packages/client/ui-conversation/tests/skeleton.client.spec.tsx` 新增两个假定时器用例：`parentAvailable` 为 undefined 的 continuable 子会话在 `SETTLE_HIDE_LIMIT_MS - 1` 时保持 `settling`、到上限时变为 `active`；打开永不落定的空白 Session 同理。两者在改动前的树上都失败（`expected 'settling' to be 'active'`）。实机检查在本修订构建的隔离实例上进行（3099 端口、独立 `DSH_HOME`，其 profile 指向生产会话库的 `VACUUM INTO` 快照，经 `/proc/*/fd` 证明单一所有权）：在父目录读取持续失败的情况下，phase 在 1.5 秒、3.0 秒、4.8 秒读到 `settling`/隐藏，在 5.6 秒、7.0 秒、9.0 秒读到 `active`/可见。
