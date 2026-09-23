# Agent Note: 窗口化打开会话不再激活该会话

Status: implemented

[English](2026-09-23-lazy-windowed-open-activation.md) | 中文

> 范围：窗口化打开为何不再挂载它打开的会话、被移除的后台读取在本部署最大已存会话上的代价，以及 GUI 在第一次写入或显式解析之前放弃了什么。

## 问题

经窗口化快速路径打开一个已存会话时，历史页由一次索引后缀读取提供，随后该会话在后台被激活。激活无法复用这段后缀：`sessionQuery.observeSession` 通过持久化句柄读取整段日志，`sessions.prepare` 构建每个投影都从 seq 0 开始折叠的密集零基会话，247 行的后缀永远无法为它播种。因此只要会话必须存在，这次读取就不可避免——而打开操作无论后续是否会写入，都会让会话存在。

在本部署那条 67,358 事件的会话上于隔离实例实测：窗口化打开读 247 行耗时 0.55 ms，随后的激活对全部 67,358 行执行 `select-events`（241 ms SQL），再解码、校验并冻结日志，阻塞唯一的 Node 事件循环 3,650.9 ms。共享该事件循环的每个 RPC、流与轮次都在等待一次读取者从未要求的读取；为阅读历史而打开会话本就是只读手势。

Host 的其余部分早已把激活当作「使用的结果」而非「打开的结果」：`commands.ts` 在命令需要时才解析 Agent，Typert 查找按需解析，agents facade 对并发 resume 去重。只有 fork 的窗口化打开会按 id 调用 `resolveAgent`——快照之后那个 fire-and-forget 的 `this.activate(target)`。

## 决策

**窗口化打开分支交付快照后即结束。** `SessionHistoryController` 只保留上游的构造器——上下文与那个交接「已读观测」的 `promote` 回调——`follow` 不再在窗口快照之后调用任何激活回调。`SessionController` 删除 `activate(sessionId)` 方法及其构造器参数；打开路径的其余部分不变。

**整段日志读取与 Agent 挂载发生在第一次显式解析时。** 发送消息、追加、Typert 查找，或任何其他 `resolveAgent` 消费方，都会走 GUI 对其他所有会话早已使用的那条路径挂载该会话。仍然打开的 follower 会通过 `session/created` 与 `session/event` 收到挂载时的构造器种子后缀与之后的追加，与急切激活时的行为完全一致；快照仍先于任何实时帧，因为窗口分支在 follower 循环开始之前就已交付。

## 延迟挂载的代价

第一次解析现在要支付打开原本支付的读取。对于读取者只读的会话，没有任何一方支付它。

GUI 的实时指示——队列、job、状态、标题与检查点投影——从打开后立即出现改为在首次激活时出现。`session/control` 的基线只报告已挂载会话，而从未被激活的会话没有队列也没有 job 可报，因此打开时本为空的指示会一直为空，直到有东西解析该会话。

失败的暴露也随挂载一起推迟。被删除的 `activate` 会在窗口快照之后立即发出 `api-session/error`，因此无法挂载的会话现在会正常绘制转写，直到第一次发送消息才失败；两条激活路径中，只有观测路径的 `promote` 仍立即报告其失败。

`api-session/added` 同样不再在打开时触发：`src/index.ts:146-148` 从 `session/created` 发出它，而打开不挂载任何东西，因此客户端的列表行会保留 `summarizeCold`（`src/list.ts:146-158`）构建的冷路径摘要，直到首次激活将其替换。

## 备选方案

**保留急切激活但让读取更便宜。** 激活的读取不是 fork 能跳过的工作：`prepare` 在观测存在之前就构建密集零基会话，且每个投影都从 seq 0 折叠。缓存仍要为每次打开支付一次整段日志读取，还会引入 fork 自己必须维护的保留策略。

**只在实时状态消费方接入时激活。** 唯一观察挂载状态的打开路径消费方是 `session/control` 基线，而它本来就只报告已挂载会话。把基线变成挂载触发器只会挪动卡顿而非消除它：GUI 为它渲染的每个会话都打开这条流。

**把激活放进配置字段。** fork 的约定偏好 `Config` 字段而非补丁，但这里的开关只是在两种行为间选择，急切那一种没有消费方，而本部署自己的测量正是反对它的理由。

**把激活推迟到空闲回调而非移除它。** 读取仍会执行、仍会阻塞同一个事件循环，只是发生在不可预期的时刻，因此并不能限制读取者看到的卡顿。

## 影响

只读的窗口化打开不再阻塞共享事件循环：最大已存会话的打开以不足一毫秒的持久化工作提供其页面，且不发起任何整段日志读取。被推迟的读取仍是同一次读取，第一次写入或显式解析支付打开原本支付的代价。

`promote` 与观测回落未动：无法走窗口的请求仍读取其观测并把它交给与从前相同的后台激活，因此非窗口路径的实时指示保持当前时序。

移除激活回调后，`SessionHistoryController` 的构造器与上游完全一致，因此 fork 清单登记的注入不再包含它，未来的同步只需重放窗口分支。surface 行记录了延迟激活这条契约。

## 测试

`packages/api/session-controller/tests/session-open-window.host.spec.ts` 承载改写后的用例。`never reads the whole log for a windowed open` 经真实控制器的 Remote 面打开，断言持久化恰好回答一次后缀读取——没有能力 `stat`、没有整段日志 `inspect`——并且在 follower 停驻、两个宏任务加一个微任务轮次排空之后整段日志读取仍未被调用。`keeps the windowed Session out of the live store until something asks for it` 断言同一次排空之后会话存储与 Agent 注册表都不持有该 id。`mounts the windowed Session on demand when a later request resolves it` 在窗口化打开之后经控制器解析该 id，断言整段日志读取确实为该会话发生，且 Agent facade 被要求挂载它。`replays frames after the snapshot cursor when the Session mounts later` 发布延迟挂载的种子后缀与随后的一次追加，断言已经打开的 follower 按 seq 顺序交付两者。`streams an append after the windowed opening through the real controller` 经 Remote 面复现同一连续性主张。`leaves the still-open follower healthy when the deferred resolution fails` 让延迟解析失败，断言其调用方收到该失败且没有任何东西被挂载，随后再次解析成功，断言这次挂载发布的帧仍能到达跨越失败保持打开的 follower。`replays the constructor suffix when the Session is created during the window read` 在窗口读取进行中发出 `session/created`——此时 follower 还没有游标——断言前插的后缀从挂载的 `firstLiveSeq` 开始，并按 seq 顺序接上页面尾部。

变异轮（每处变异事后还原）：把 `this.activate(target)` 加回窗口分支会让 `never reads the whole log for a windowed open` 与 `keeps the windowed Session out of the live store until something asks for it` 失败；用 seq 0 而非挂载的 `firstLiveSeq` 重放会让 `replays the constructor suffix when the Session is created during the window read` 失败；把被拒绝的 resume 留在 facade 的 single-flight 映射里会让 `leaves the still-open follower healthy when the deferred resolution fails` 失败。包套件通过：43 文件 / 822 用例。`npx tsc -b packages/api/session-controller/tsconfig.host.json` 退出 0；仓库级 `tsconfig.host.json` 聚合仍因未触及的客户端测试文件里既有的三个 `BrowserAuth` TS2345 错误而失败。

## 相关

- 本次改动移除其急切激活的窗口化打开：[冷会话的窗口化打开快照](../architecture/2026-09-11-windowed-session-open.zh.md)
- 该表面登记的 fork 清单行：[FORK_SURFACE.md](../../../../FORK_SURFACE.md)
