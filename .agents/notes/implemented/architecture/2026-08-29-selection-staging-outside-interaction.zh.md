# Agent Note: 会话选择同步 stage，其列表投影渲染在交互之外

Status: implemented

[English](2026-08-29-selection-staging-outside-interaction.md) | 中文

> Scope: the client sessions service (`dsh-client-api-session-controller` browser half) and the workspace sidebar's order store. No wire, host, or persistence changes.

## 问题

字段 INP 数据显示会话行点击 240 ms、其中处理用时 185 ms：`SessionManager.select` 用 `notifyNow` 同步 flush 通知器，整个侧栏与会话切换渲染都跑在交互的处理窗口内。点击前后，共同流式的会话带来第二重放大：每次列表重建都铸造全新快照对象（即使内容相同），侧栏的账号同步每个活动 tick 写入新 order 数组——每个 tick 让树派生与 order 派生 memo 跑两遍。

## 决策

**staging 与投影在 service 接口分离。** manager 的选择路径（`select`、`selectSubagent`、`clearSelection`）改为 `markDirty` 通知：面向 React 订阅者的列表 store 投影落在 manager 既有的微任务批次里，在调用交互之外。`ClientSessions.open`/`openSubagent` 随后直接调用 `followCurrent` 同步 stage——`followCurrent` 改读 manager 快照（投影的数据源，经通知器读路径 rebuild 即时新鲜），每次 open 仍在本次调用内触达其会话窗口，连续多次 open 每个 selection 都被 stage，而不是只有最后一个。

**身份稳定的列表快照。** `buildListSnapshot` 在所有可观察字段未变时（items 引用、current、state、phase、error、稳定的 `subagentsByParent`/`jobsBySession` 产物、address）返回上一个快照对象；两个 `Object.fromEntries` 产物在 catalog/jobs 条目未移动时保持引用。等内容重建不再触发订阅者重渲染。

**order 引用跨未变的账号同步存续。** 工作区视图 store 的 `syncSessionOrderAccount` 在 order 未变时保留上一个数组引用（时间戳照常推进并持久化），order 派生 memo 只在真实重排时重跑。

## 后果

- 会话行点击的处理器时间 ~2-3 ms（实测 185 ms → 2.6 ms）；切换渲染在微任务批次中同帧完成。
- controlled-input 的同刻契约留给真正需要它的 `notifyNow`（草稿回显）；选择是导航，从来不是。
- 在 `open()`/`clear()`/`openSubagent()` 之后立即读 `list.getSnapshot()` 的 service 测试改为一个微任务后读投影；staging 测试（scope 窗口、地址路由）保留同步断言。
- 共同流式会话的环境噪声下降（无操作重建跳过通知；未变 order 跳过 memo 重跑）；活动驱动的重建按设计保留（实时时间标签）。

## 备选方案

- **保留 `notifyNow` 并在 uSES 层延迟**：快照 store 引擎是上游核心，改其通知语义影响所有 store。
- **staging 也异步（全部 mark）**：连续 open 只会 stage 最后一个 selection——scope-tree 测试钉住了逐次 open 的 staging，stage 就是 open 信号。
- **改为节流 activity 变更**：实时相对时间标签是产品行为；延迟它是在用可见正确性换余量。

## 验证

`packages/api/session-controller` 客户端套件全绿（420 测试：manager、service、notifier、lineage）；`test:gui` 291 文件 / 3854 测试全绿；新增 manager 测试钉住快照引用复用、等内容对照、以及带同步 staging 的微任务通知。
