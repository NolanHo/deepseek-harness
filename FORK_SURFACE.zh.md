# Fork patch surface — 上游差异面清单与合并 runbook

[English](FORK_SURFACE.md) | 中文

fork 与上游的维护契约：每处差异要么是 fork 自有模块（零合并成本）、配置开关、小型行为补丁，要么是语义级核心修改。本文件盘点每个差异面、其隔离层级、以及上游同步时的重放流程。任何触及上游自有文件的改动都要同步更新本清单。

## 为什么需要这份文件

0.1.2-alpha.1 同步（上游 1079 提交）解决了 123 个冲突。痛点集中在上游自有文件中的 fork 语义。下面的清单把每个差异面分类，让下一次同步变成机械的重放清单，而不是考古挖掘。

## 隔离层级

- **A 层 — fork 自有包**：上游永远不会有的文件。零合并成本。
- **B 层 — 配置开关**：上游文件中的一个常量或经校验的 `Config` 字段。重放分钟级。
- **C 层 — 小型行为补丁**：每个上游文件约 40 行以内、局部块。冲突小、可解。
- **D 层 — 语义级核心修改**：上游自有算法内的 fork 行为。这是合并成本所在；尽量压缩注入面。

## 当前清单（相对 0.1.2-alpha.1 同步时的 upstream/master）

| 差异面 | 层级 | 规模 | 性质 |
| --- | --- | --- | --- |
| `packages/web/web-search-{academic,bocha,brave,zhihu}` | A | 20 文件 | fork 搜索提供方，完全隔离 |
| `.agents/notes`、文档、快照、测试更新 | A | — | 随源更新；与对应源一起重放 |
| `session.ts` PAGE_MESSAGES 8（上游 50） | B | 8 行 | 客户端页大小 |
| `client/connection` browserAuth 开关 | B | ~50 行 | 配置字段后的可选认证关闭 |
| `ui-chat` TurnProcessNodeView 标签+时长、ChatNodeSeat 门移除、locale、CSS | C | ~60 行 | 折叠增强；局部块 |
| `ui-chat` ChatView 读者输入归因 | D | 32 行 | 上游滚动跟随 bug 的修复（钳位误判）；关注上游自行修复以缩小该 diff |
| `ui-conversation`/`ui-chat` CSS overflow-anchor + 安全区 | C | ~40 行 | 滚动容器锚定；局部规则 |
| `api/session-controller/src/history.ts` 快路径注入 | C | ~60 行 | 委托给 fork 自有 `src/page-boundary.ts`（边界游走、梯子、快路径计划）；`page()` 一次调用加 `paginate` 的委托 |
| `session-persistence-sqlite` messageCut | C | ~24 行 | 具体存储的索引切点；上游抽象、coordinator、jsonl 桩已回归原状 |
| `session-query-sqlite` 活动观察记忆化 | C | 30 行 | 单函数内的局部记忆化 |
| `client/ui-layout` AppFrame 移动端 shell | C | ~62 行 + fork 自有 `mobile-shell.tsx` | 视口机制 hook、抽屉 chrome、详情面板在 fork 模块里；AppFrame 组合 |
| `api/session-controller` `openWorkspacePath` 桌面门控 + `ui-chat` 文件打开路由 | C | ~30 行 | 打开 RPC 查询 `canOpenPath()` 并以 `desktop unavailable` 快速失败；Chat 打开接口在第三方 `betterSidebar` 插件安装时把核心文件表面路由到其侧栏编辑器（`ctx.get` duck 检查），拒绝映射为 `fileOpen.desktopUnavailable` 文案，原生打开器保留为回落 |
| `client/modules` + `client/web` 延迟启动批次 | C | 3 个文件约 120 行 | `WebBootBatchPhase 'deferred'` + `Config.defer` 切分 + 两段式 boot；上游形态（增量线格式字段、空默认）；defer 名单是部署配置而非仓库状态 |
| `ui-workspace` 提升头部稳定 | C | ~20 行 | `nextSessionOrderAccount` 共流式时保持头部相对顺序；每个活跃突发一次提升 |
| `ui-chat` StatsLine 绘制后测量 | C | 1 行 + 注释 | 省略号测试从 `useLayoutEffect` 移到 `useEffect`（绘制后）；行为零变化 |
| `api/session-controller` 客户端选择通知 + 快照身份 | C | manager/service 约 60 行 | 选择走 `markDirty` 通知（列表投影渲染在交互之外）；`open`/`openSubagent` 经 `followCurrent` 读 manager 快照同步 stage；`buildListSnapshot` 内容未变返回上一个对象，`subagentsByParent`/`jobsBySession` 引用稳定 |
| `ui-workspace` order store 引用稳定 | C | ~10 行 | `syncSessionOrderAccount` 在 order 未变时保留旧数组引用（时间戳照常推进） |

## 优化方案（按优先级）

1. **DONE — 从 `history.ts` 抽出分页核心** — 把 `nthMessageCut`、`turnAlignedCut`、`paginateSuffix` 和 `tryIndexedPage` 的纯函数部分移入 fork 自有模块（如 `src/page-boundary.ts`，上游永远不会有的文件）。`history.ts` 只留约 10 行注入点：import、`page()` 里的 `tryIndexedPage` 调用、`paginate` 对共享游走的委托。上游重构 `page()` 时冲突面是十行而不是两百行。
2. **DONE — 把 `messageCut` 移出上游持久化接口** — fork 自有服务（独立包或 `session-query-sqlite` 内的扩展）暴露索引切点；`history.ts` 的快路径已经是可选能力发现（`SeekablePersistence` duck-typing）。上游的 `SessionPersistence` 抽象和 coordinator 回归原状；SQL 随 fork 服务走。
3. **改动时即写合并 runbook，而非同步时补** — 每个 C/D 层改动在本清单记下注入点；同步重放从头到尾照单执行。
4. **保持 D 层 diff 紧凑并带标记** — 滚动归因块带原理解释注释；上游若自行修复同一钳位 bug，该 diff 缩为零（在上游发布中关注）。
5. **DONE — AppFrame 移动端 shell** — 最大面积。现实上保持 patch（布局是上游核心组件），但把 fork 的视口机制放进 `columns.ts` 式的叶子模块，让 AppFrame 的 diff 保持 import-and-delegate 形态。
6. **PAGE_MESSAGES** — 一行；若常变可改 build 时 env（`DSH_CLIENT_PAGE_MESSAGES`）。

## 同步流程（runbook）

1. 在 worktree `git fetch upstream && git merge upstream/master`。
2. A 层：无操作（上游没有这些文件）；只解决 `pnpm-workspace`/tsconfig 聚合与 `cordis.patch.yml`。
3. B 层：重放开关/常量；预期平凡的上下文冲突。
4. C 层：按本清单逐块重放局部补丁；跑所属包的测试套件。
5. D 层：重放注入点（完成上面 1–2 后，它们是 history.ts/persistence 仅剩的 diff），fork 自有模块整体拷贝。
6. 跑 `pnpm run test:gui`、session-controller 套件、`DSH_SNAPSHOT=replay pnpm run test:web`；仅在有意输出变化时刷新金样。
7. 在 `FORK_CHANGES.md` 记录本次同步。
