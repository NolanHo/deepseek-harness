# Agent Note: 原地重写历史不再表现为会话被移除

Status: implemented

[English](2026-09-13-rewrite-removal-hold.md) | 中文

> 范围：原地历史重写在拆除 Agent 时产生的客户端可见生命周期边（`SessionController` 的 `api-session/removed` 中继），以及用于抑制它的 hold。重写设计由[特性注记](../feature/2026-09-12-in-place-history-rewrite.zh.md)承载；传输契约由 [session-controller 包](../../../../packages/api/session-controller/README.zh.md)承载。

## Problem

通过原地重写发送编辑后的消息时，GUI 会退回新会话画面——工作区 chip 显示 "Choose workspace"、输入框变为不可用的 "Choose a workspace to start"、转录消失——持续到重写结束，随后又跳回对话。

重写需要先拆除该会话的 Agent 以释放持久化写入所有权，然后才能截断（`AgentHandle.dispose()` 会停止循环、注销 agent，并**把它的 session 从 store 中移除**）。Session 层为这次移除配对发出 `session/disposed`，本控制器把它中继为 `api-session/removed`。客户端据此认为该会话离开了列表：摘要被删除，`sessions.list` 把 `current` 掩为 `undefined`，会话-current 绑定变为 absent，于是 `ConversationRoot` 渲染 `hero = sessionId === undefined`——即新会话画面。同一请求随后以相同会话 id 重新 resume 一个 Agent，`api-session/added` 恢复摘要，对话回来了，而 selection 从未被清除。在第二个实例（干净数据库）上实测：该画面每次重写占据 62–132 ms；这个窗口就是重写自身的时长（agent 拆除、截断、投影缓存丢弃、resume），因此在部署环境里一个体积较大的活跃会话上，它明显更久。

## Decision

`SessionController` 现在在整个重写窗口内**持有**移除公告，而不是先发布再在片刻后撤回。重写是一个操作：会话 id 与它的持久日志都存活，Agent 在同一请求内重建，任何客户端都不应把这次内部拆除观测为生命周期边。

`SessionCommandController.prompt` 在 `rewriteHistory` 之前进入 hold，在 `resolveAgent` 结算之后离开，因此窗口覆盖 disposal 到 rebuild 的整段；`api-session/removed` 中继在发送前向同一控制器询问（`deferRemoval`）。被推迟的公告会在释放时检查：若窗口结束时没有活跃 Agent，就重新发布——在 disposal 之后失败的重写（截断写入出错）仍必须告知客户端该会话已消失——因此这条回退路径保持公告的真实性，而不会泄漏一个客户端到不了的会话。

## Alternatives considered

- **不拆除 Agent。** 活跃会话拥有其循环正在追加的内存日志；在它下面截断持久存储会让下一次追加失步（seq 游标与 handler revision 都假设日志只增不减）。要让**活跃**会话原地重写，需要 Session 层能同时在内存与存储中丢弃已提交的尾部，而现有 seam 不提供该能力。
- **直接抑制 `session/disposed`。** 其他消费者会因各自原因响应该事件（持久化句柄关闭、投影缓存退役行、已暂存上传丢弃），而且该窗口内 store 里确实没有该会话；缺陷只在**面向客户端**的公告这一层。
- **改客户端，让它渲染穿越 masked gap。** `ConversationRoot` 把 absent 的 current 绑定读作"根本没有会话"，而数据层本就区分 masked gap；让每条客户端渲染路径都保留上一段对话，只会掩盖"宿主发布了一条并不描述该会话命运的移除"这一事实，并让其他客户端继续共享这个谎言。

## Consequences

- 从未见过该移除的客户端保留其列表行、selection 与已渲染的对话；从此处编辑并重发变为就地替换转录（编辑后的消息渲染时被替换的消息消失），而不是把整个应用清空。
- hold 的作用域是单个会话 id 与单次重写请求；对所有其他 disposal 路径，中继行为不变，其他所有者观测到的事件也没有变化。
- 这个延迟不是撤回协议：在窗口**期间**连接的客户端读到的是普通列表（此时该会话确实不在 store 中），与任何客户端在一次 disposal 与其 rebuild 之间加载时看到的状态相同。

## Testing

- `packages/api/session-controller/tests/session-rewrite.host.spec.ts` 钉住生产组装（真实 sqlite 持久化、生产 Agent 循环、真实投影缓存）：对**活跃** Agent 的重写返回 `rewrote: true`，且该会话从未发出 `api-session/removed`。在未打补丁的源码上同一用例失败，实测 `["session-rewrite-quiet"]`。
- `packages/api/session-controller/tests/rewrite-hold.spec.ts` 钉住 hold 的四种状态迁移，包括"重写失败仍公告移除"的回退路径。
- 真实浏览器在第二个隔离的 `dsh web` 实例（127.0.0.1:3097，自有 `DSH_HOME` 与自有数据库）上驱动同一次"从此处编辑并重发"，以 20 ms 的 DOM 探针采样：改动前新会话画面在 t=62 ms 出现且输入框被卸载；改动后不再出现该画面、任何采样都没有空的对话状态，转录从被替换的消息直接切到编辑后的消息。
