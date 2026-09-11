# Fork patch surface — 上游差异面清单与合并 runbook

[English](FORK_SURFACE.md) | 中文

fork 与上游的维护契约：每处差异要么是 fork 自有模块（零合并成本）、配置开关、小型行为补丁，要么是语义级核心修改。本文件盘点每个差异面、其隔离层级、以及上游同步时的重放流程。任何触及上游自有文件的改动都要同步更新本清单。

## 为什么需要这份文件

0.1.2-alpha.1 同步（上游 1079 提交）解决了 123 个冲突。痛点集中在上游自有文件中的 fork 语义。下面的清单把每个差异面分类，让下一次同步变成机械的重放清单，而不是考古挖掘。

## fork 模块约定

凡超过一行的 fork 逻辑都住在 `<pkg>/src/fork/`（client 面：`<pkg>/src/client/<area>/fork/`）的 fork 自有模块里。上游文件只带一个标记注入点——一个 import 加一个调用——前面配 `// Fork patch (FORK_SURFACE.md): ...` 注释。同步操作 = 原样搬移所有 `fork/` 目录 + 重放下方登记的注入点。内在一行式改动（常量、单 hook 互换、CSS 块、配置字段）按政策保持内联；抽取它们只会增加间接层而不会缩小合并面。

## 双路径

双路径指同一行为两边都改了——同一文件、同一算法，或同一结果的两套实现。双路径一律归上游：删除 fork 版本、采用上游实现，并在 `FORK_CHANGES.md` 记录退役，即使 fork 版本略优。保留的 fork 版本必须写明上游无法服务的生产消费者或未修复的已复现缺陷。

### 已解决与保留的双路径

| 双路径 | fork 侧 | 结论 |
| --- | --- | --- |
| TurnProcess 折叠标签 | `ui-chat/src/client/chat/fork/turn-process-summary.ts` + 视图 import | **已退役** —— 上游在同一视图内联构建同样的折叠标签；模块及其 `message.turnProcess.collapsed` 键删除，视图恢复上游实现 |
| 历史分页 | `session-controller/src/fork/page-boundary.ts` + `history.ts` 注入 | **保留** —— 上游 `paginate` 没有轮次对齐切点，页窗口可能从轮次中间打开并渲染半个轮次头；fork 把切点扩到所属轮次的开场事件 |
| 冷开窗口 | `session-controller/src/fork/open-window.ts` + `history.ts` 分支 | **保留** —— 上游折叠整段日志再裁剪（最大会话要数秒 CPU 与数百 MB 堆）；fork 通过自有 seek 面只读一个索引窗口 |
| 回流稳定滚动锚点 | `ui-chat/src/client/chat/fork/scroll-anchor.ts` + 6 处 ChatView 注入 + `overflow-anchor: none` | **保留** —— 上游的 ResizeObserver 只重跟尾部、结算 effect 清空锚点，且其台账把原生锚定的写入误判为读者移动；fork 实测阅读行上方展开 8,460 px 而补偿为零 |
| 移动端 frame 组合 | `ui-layout/src/client/fork/mobile-shell.tsx` + AppFrame 与 store 字段 | **保留** —— 上游 frame 在 1024 px 以下只折叠成窄轨且没有手机形态，手机宽度无法重新展开左栏 |
| 沙箱组合 | `bundle/base/cordis.patch.yml` 执行器替换 + `permission` 禁用 | **保留** —— 上游的约束型执行器需要 bwrap 或 Landlock；本容器内核早于 Landlock 且 `bwrap` 探测失败，采用上游组合会让每条 bash 调用 fail-close。在支持 Landlock 的内核上需重新评估 |
| 活动与重建抖动 | `sessions/fork/coalesced-refresh.ts`、`snapshot-identity.ts`、`ui-workspace/src/client/fork/order-stability.ts`、`session-query-sqlite/src/fork/live-observation-memo.ts`、空转 identity 契约 | **保留** —— 上游对每个活动事件立即应用、每次重建都新造 subagent/job 投影与快照对象、每次同步重排提升集合、每次搜索克隆并哈希全部挂载会话；每个 fork 模块都修复了已复现缺陷。局部重叠（entry/items identity、reconcile/recency 辅助函数）是下一步采用上游辅助函数的方向 |
| 打开文件路由 | `ui-chat/src/client/chat/fork/open-file-routing.ts` | **保留** —— 路由优先已安装的 `dsh-better-sidebar`，再回落上游右侧栏 |
| 通用品牌 `DSH` | 语言字典 + `apps/web` 默认值 | **保留** —— 本部署的品牌选择；上游为 `DSH Local Build` |

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
| `ui-chat` TurnProcess 折叠标签 + 时长 | 已退役（双路径） | — | 上游 0.1.5-rc.2 在 `TurnProcessNodeView` 内联构建同一折叠标签；fork 的 `src/client/chat/fork/turn-process-summary.ts`（分类计数 + 墙钟时长 + 折叠前缀）已删除，视图恢复为上游实现，fork 自有的 `message.turnProcess.collapsed` 字典键随之移除。时长仍在轮次页脚的用量详情中可见。`TurnProcessNodeView.tsx` 与 `locale.ts` 现与上游完全一致。 |
| `ui-chat` ChatView 读者输入归因 | 已退役 | — | 上游自己的修复已落地（observed-top 几何台账覆盖全部输入设备，无需监听器）；fork 的设备标记补丁在 0.1.2-rc.1 同步时移除 |
| `ui-conversation`/`ui-chat` CSS overflow-anchor + 安全区 | C | ~40 行 | 滚动容器锚定；局部规则 |
| `api/session-controller/src/history.ts` 快路径注入 | C | `page()` 约 10 行，`follow` 约 60 行 | 分页注入委托给 fork 自有 `src/page-boundary.ts`（边界游走、梯子、快路径计划）：`page()` 一次调用加 `paginate` 的委托。打开注入增加同步服务检查、带观测回落的窗口快照分支，以及第二个构造器回调（按 id 激活窗口化 Session）。两条快速路径都通过 `seekSurface` 辅助函数取得持久化方法，并绑定到 `ctx.get` 返回的 tracker 代理：未绑定的提取方法会以包装对象为 `this` 运行，在任何读取自身状态的提供方里抛错 |
| `api/session-controller/src/fork/open-window.ts` 冷打开窗口 | C | 约 110 行 + `history.ts` 分支 | 打开快照的窗口化读取：基于 `readIndexedSuffix`（`page-boundary.ts`，新增窗口化读取、可选计划字段 `throughSeq`/`windowFloor` 与回合截断检查）的读数计划、检查点门槛、闭合尾部证明与折叠。上游的 `follow` 折叠整段日志再裁剪，在最大会话上要花数秒 CPU 与数百 MB 堆；上游没有可委托的索引寻址面（fork 的 `seekable`/`messageCut`/`readFrom` 在自己的持久化后端上）。窗口化读取先调用 `seekable`，返回 false 时在任何切点查询或读取之前就退出。`history.ts` 只保留带标记的 try、观测回落与按 id 的激活交接 |
| `session-projection-cache/src/fork/checkpoint-read.ts` 检查点读取与写回 | C | 约 90 行 + `index.ts` 注册 | 窗口化打开需要按会话 id 读取已存检查点行，首次冷打开还要装上供下一次折叠的记录。上游的公有折叠面只返回视图值而非可播种的行，其 `hydratePrepared` 刻意不写任何东西；fork 增加一个 symbol 键注册的服务私有查找（WeakMap 不可行：cordis 交给调用方的是 tracker 代理而非注册对象）、`readCheckpoint` 读取，以及持久前缀写回。`readColdSessionLog` 报告 `durableEventCount`，使写回的行绝不越过已存日志末端（`observation.ts` 负责透传）|
| `session-persistence-sqlite` 整包 + 寻址面（`seekable`/`messageCut`/`readFrom`） | A（0.1.2-rc.1 起 fork 拥有） | 8 个文件 | 上游按 JSONL-only 决策删除该包但为 out-of-tree 提供者保留接缝；fork 保留并移植到 handle-based `PersistenceBackend`/coordinator，采用上游最终 SCHEMA_VERSION 20（`ignorable` 列兼作 packed 行判别符；一次性 19→20 原地迁移；`seed_length` 承载继承切点）。`seekable(id)` 是快速路径的门槛：仅当前格式行返回 true，且只读元数据。它之所以存在，是因为 `loadStoredFrom` 的历史分支会用格式目录恢复整段日志再切片，而切片用的 `fromSeq` 来自存储物理空间，恢复出的序号已重排、不在该空间里——生产库绝大多数行正是这种，窗口计划在那里每次尝试都要读完整段日志却拿到空页 |
| `session-query-sqlite` 活动观察记忆化 | C | `index.ts` 内约 13 行 | 指纹 memo（`length:tailSeq:tailTime`）在 `src/fork/live-observation-memo.ts`；`index.ts` 只留字段与 3 行委托 |
| `client/ui-layout` AppFrame 移动端抽屉 | C | import + 组合 + 2 个 store 字段 | **0.1.5-rc.2 状态：已重放** —— 上游 frame 在其 1024px 自动折叠以下只提供窄轨，故 fork 保留自己的手机断点（768px，与右侧栏自身的全屏阈值一致）：左栏变为固定覆盖抽屉，frame 只渲染一条流内轨道。详情面板退役——上游右侧栏在 768px 以下本就全屏覆盖并提供自己的退出入口。 | 视口机制 hook 与抽屉 chrome 在 `src/client/fork/mobile-shell.tsx`（自带 `MOBILE_VIEWPORT`，因上游 `columns.ts` 去掉了该常量）；AppFrame 的 diff 为 import、一次 `useMobileRegime` 调用、抽屉分支、单轨模板、`RightbarColumn` 的 `mobile` 属性（使其不占该轨道）与两处手柄守卫；`stores.ts` 增加 `mobile`/`drawerOpen` 及 `setMobile`/`setDrawerOpen` 与 `toggleSidebar` 的移动分支；抽屉标签是 fork 加入 `common` 字典的 `sidebar.open` 键 |
| 通用客户端品牌读作纯 `DSH` | C | 2 个字典值 + 2 处构建默认值 + 测试断言 | 上游通用品牌为 `DSH Local Build`，fork 读作 `DSH`（两个语言字典的 `brand.localBuild` 驱动侧栏品牌名与文档标题兜底，`apps/web/index.html` 与 `vite.config.ts` 的 `DEFAULT_CLIENT_TITLE` 承载静态默认值）。部署标题（`DSH_CLIENT_TITLE`）仍可覆盖，品牌下方构建版本行不变 |
| 对话头部移动端精简（session-log 胶囊 + 面包屑） | C | ~10 行 | `max-width: 560px` 媒体块在手机宽度隐藏 Session log 下载胶囊（`session-log-export`）与会话标题面包屑（`ui-conversation`） |
| `api/session-controller` `openWorkspacePath` 桌面门控 + `ui-chat` 文件打开路由 | C | 门控保持内联（5 行）；路由 = 标记+import+2 处调用 | 打开 RPC 查询 `canOpenPath()` 并快速失败（内在一行式）；路由决策与拒绝文案映射在 `src/client/chat/fork/open-file-routing.ts` |
| `client/modules` + `client/web` 延迟启动批次 | C | 3 个文件约 120 行 | `WebBootBatchPhase 'deferred'` + `Config.defer` 切分 + 两段式 boot；上游形态（增量线格式字段、空默认）；defer 名单是部署配置而非仓库状态 |
| `ui-workspace` 提升头部稳定 | C | 标记+import | `nextSessionOrderAccount`/`reconciledSessionOrder` 在 `src/client/fork/order-stability.ts`；WorkspaceBrowser 直接调用 |
| `ui-chat` StatsLine 绘制后测量 | C | 1 行 + 注释 | 省略号测试从 `useLayoutEffect` 移到 `useEffect`（绘制后）；行为零变化 |
| `skill` 注册表目录限制 | C | `index.ts` 内 17 行 | 全部逻辑在 `src/fork/skill-restrict.ts`（编译、按作用域存储、链式过滤）；`index.ts` 只留 import、一个字段、两个标记的委托调用；allow/deny 互斥记录在模块 JSDoc |
| `subagent` 子代理 cwd + skillFilter | C | 接缝 + `child-agent.ts` 内 2 个注入点 | 逻辑在 `src/fork/child-scoping.ts`（`stampChildCwd`、`applyChildSkillFilter`）；贯穿 `childSessionMeta`/continuation/驱动的请求字段是保留的接缝；descriptor v3→4（同步遇上游 bump：字段取并集）；冷恢复的 cwd 权威仍在会话 header |
| `ui-chat` ChatView 重排稳定滚动锚点 | C | import + 1 个回调分支 + 3 处捕获/重持编辑、移除 1 个上游 effect | `chat/fork/scroll-anchor.ts` 在每次流列尺寸变化时（折叠塌陷、图片加载、展开）重新断言持有的读者行，并在滚动写入之后测量锚点使连续回调保持幂等，配 observed-top 台账保证读者输入归因正确；锚点行被隐藏时回退到其上方最近的存活可见行。ChatView 在每次离开底部的滚动采样上武装锚点，在每次前插补偿后重新持有读者行，在保存位置恢复时捕获恢复的行，并在 load-earlier 结算后保留锚点（上游清空 effect 已移除） |
| `api/session-controller` 失败会话窗口的重置恢复 | C | `manager.handleConnected` 内 9 行 | 载体重置会中止所有逻辑流；error 态会话经 `resync()` 重开，而不是冻结在最后一帧直到整页刷新 |
| `api/session-controller` 环境活动合并 | C | import + 字段 + `manager.ts` 内 1 处调用、空转身份契约 | 其他运行中会话的连续 `api-session/activity` 流按会话缓冲（最新时间戳胜出），由 `sessions/fork/coalesced-refresh.ts` 大约每秒冲刷一次；单独活动立即应用，保留同步 staging 契约。`applyMutation` 在变更不翻转任何字段时返回输入数组引用，`recordMutation` 在该引用不变时跳过脏冲刷，未变化的 status/activity 帧不再重建列表 |
| `api/session-controller` 客户端选择通知 + 快照身份 | C | `manager.ts` 内约 9 行 | 身份/稳定性逻辑（entry/items/subagents/jobs 缓存、内容相等复用前快照）在 `src/client/sessions/fork/snapshot-identity.ts`；选择仍走 `markDirty`，`open`/`openSubagent` 经 `followCurrent` 同步 stage |
| `api/gateway` Remote stream mux permessage-deflate | C | ~35 行 | `RemoteStreamMuxServer` 接受 `Config.websocketPerMessageDeflate`（默认关）的 `perMessageDeflate` 参数；RFC 7692 协商配 `threshold: 1024`，journal `opened` 整窗帧压缩、实时帧原样；mux 帧处理本身未动
| `ui-workspace` order store 引用稳定 | C | 标记+import+3 行守卫 | `sessionOrderChanged` 在 `src/client/fork/order-stability.ts`；store action 在 order 未变时保留旧数组引用（时间戳照常推进） |
| `bundle/base/cordis.patch.yml` 沙箱禁用 + 本地 provider 换挂 | C | 6 行 + 注释 | Fork 决策 2026-09-05（仅 danger-full-access 部署，见 FORK_CHANGES.md）：行 `sandbox`、`sandbox-policy`、`permission` 置 `disabled: true`；执行器行 `bash-sandbox`/`pwsh-sandbox`/`fs-sandbox` 保留 id 与平台 `!!js` 门，但改挂 `@deepseek-ai/dsh-bash-local`/`dsh-pwsh-local`/`dsh-fs-local` 取代沙箱包。同步重放：按文件内 fork 注释回退 name/flag；`permission` 必须跟随沙箱行（其构造器拒绝非约束执行器之上的组合） |
| 根 `vitest.config.ts` 沙箱套件禁用 | C | 2 份名单 + 展开 | `forkDisabledSandboxTests` 把 `packages/sandbox/*`、bash-sandbox、pwsh-sandbox、fs-sandbox 单元套件移出收集；`forkDisabledSandboxCoverageExclusions` 把对应源码移出 per-file 覆盖率门。恢复路径（恢复 base 行后删除名单）见文件内注释 |
| `vitest.e2e.config.ts` sandbox 族与 ACP escalation e2e 排除 | C | 2 份排除名单 | Fork 决策 2026-09-05（见 FORK_CHANGES.md）：sandbox 族 e2e 套件（`packages/sandbox/*`、bash-sandbox、pwsh-sandbox、fs-sandbox，`*.e2e.ts`）与 ACP escalation 套件（`apps/cli/tests/profiles/acp/tests/escalation.e2e.ts`，denial→escalation 流程；保留 keyless smoke 的拆文件提示见注释）探测的都是 fork 不再挂载的机制。恢复路径见文件内注释 |
| `vitest.web.config.ts` 权限面浏览器套件排除 | C | 1 份排除名单 | Fork 决策 2026-09-05（见 FORK_CHANGES.md）：`settings-chrome`、`permission-policy-context`、`access-confirmation`、`seeded-history`、`approval-composer` 浏览器套件断言的 Permission 设置行 / 访问模式选择器 / `/permission read-only` chip 均为 fork 不再挂载的面——approval-composer 重放 `snapshots/web/approval-composer/` 下录制的审批接管会话，但必须先经 Access chip 进入 Read Only 才能触及其审批接管主体，而无宿主 permission 服务的 `permissions` 投影时该 chip 不渲染。金样保持上游形态；恢复路径见文件内注释 |
| `vitest.expected.config.ts` 沙箱形态 expected 排除 | C | 1 份排除名单 | Fork 决策 2026-09-05（见 FORK_CHANGES.md）：`subagent-inheritance` 与 `image-offload` 钉死的 read-only 委派事件、sandbox-policy prompt 上下文、拒绝输出与 `Current DSH file policy` 句均非 fork 产出；`goal`、`headless`、`semantic-checkpoint`、`subagent-diagnostic`、`workspace-context-resume` 对整段归一化会话与上游组合录制的金样做全等比较——其 `permission/preset`、`sandbox/mode`、`approval/policy` 行与 sandbox:policy 运行时上下文消息在 fork 日志中从不出现（排除前该 lane 25 项测试中 12 项在 fork 上失败）。金样保持上游形态；恢复路径见文件内注释 |
| `vitest.snapshot.config.ts` ACP snapshot 语料排除 | C | 1 份排除名单 | Fork 决策 2026-09-05（见 FORK_CHANGES.md）：`snapshots/acp/acp.snapshot.ts` 重放上游录制的沙箱 denial→escalation→approval 语料（escalation 三件套及其 sidecar 关联的 cancel/approval 与 schema-pin 用例）；实测 8 个重放中 6 个在 fork 组合下失败，且套件 pin/清单不变式禁止按场景名单排除，故整个文件不再收集。恢复路径见文件内注释 |
| `apps/web/tests/shipped-composition.e2e.ts` 沙箱缺席断言 | C | 1 段断言 | Fork 决策 2026-09-05（见 FORK_CHANGES.md）：以 `ctx.get(...)` 解析为 `undefined` 的缺席断言取代上游 `sandboxPolicy`/`permissionPresets` 模式钉（approval 仍为 `ask`）。恢复路径见文件内注释 |
| `apps/cli/tests/windows-shell.spec.ts` 权限行断言 | C | 1 段断言 | Fork 决策 2026-09-05（见 FORK_CHANGES.md）：上游「permission 面永不移动」循环断言 sandbox/permission 行保持启用；fork 断言其为 `disabled: true`，而 ui-permission/fs-sandbox/approval 保持启用。恢复路径见文件内注释 |
| `apps/cli/tests/github-webhook-real.e2e.ts` permission 预设钉移除 | C | 1 个合取项 | Fork 决策 2026-09-05（FORK_CHANGES.md）：带 key 真测不再要求 `permission/preset read-only` 事件（唯一生产者 permission-presets 随沙箱行禁用）；标题 + webhook 来源 provenance 保留。沙箱行恢复时加回合取项 |

## 优化方案（按优先级）

1. **DONE — 从 `history.ts` 抽出分页核心** — 把 `nthMessageCut`、`turnAlignedCut`、`paginateSuffix` 和 `tryIndexedPage` 的纯函数部分移入 fork 自有模块（如 `src/page-boundary.ts`，上游永远不会有的文件）。`history.ts` 只留约 10 行注入点：import、`page()` 里的 `tryIndexedPage` 调用、`paginate` 对共享游走的委托。上游重构 `page()` 时冲突面是十行而不是两百行。
2. **DONE — 把 `messageCut` 移出上游持久化接口** — fork 自有服务（独立包或 `session-query-sqlite` 内的扩展）暴露索引切点；`history.ts` 的快路径已经是可选能力发现（`SeekablePersistence` duck-typing）。上游的 `SessionPersistence` 抽象和 coordinator 回归原状；SQL 随 fork 服务走。
3. **改动时即写合并 runbook，而非同步时补** — 每个 C/D 层改动在本清单记下注入点；同步重放从头到尾照单执行。
4. **保持 D 层 diff 紧凑并带标记** — 滚动归因块带原理解释注释；上游若自行修复同一钳位 bug，该 diff 缩为零（在上游发布中关注）。
5. **DONE — AppFrame 移动端 shell** — 最大面积。现实上保持 patch（布局是上游核心组件），但把 fork 的视口机制放进 `columns.ts` 式的叶子模块，让 AppFrame 的 diff 保持 import-and-delegate 形态。
6. **PAGE_MESSAGES** — 一行；若常变可改 build 时 env（`DSH_CLIENT_PAGE_MESSAGES`）。

## 同步流程（runbook）

1. 通读 fork 基线 tag 到目标 tag 之间的全部 release note，列出其中点名的协议、会话格式与 API 破坏性变更，并规划对应适配。
2. 在 worktree `git fetch upstream && git merge upstream/master`。
3. **平价复核（AGENTS.md 政策）**：对照新 tag 逐行核对清单；上游已提供等价功能时，删除该 fork 行并采用上游版本（退役记入 `FORK_CHANGES.md`）；保留行更新「上游为何不能满足」的理由。
4. A 层：无操作（上游没有这些文件）；只解决 `pnpm-workspace`/tsconfig 聚合与 `cordis.patch.yml`。
5. B 层：重放开关/常量；预期平凡的上下文冲突。
6. C 层：按本清单逐块重放局部补丁；跑所属包的测试套件。
7. D 层：重放注入点（完成上面第 3 步后，它们是 history.ts/persistence 仅剩的 diff），fork 自有模块整体拷贝。
8. 跑 `pnpm run test:gui`、session-controller 套件、`DSH_SNAPSHOT=replay pnpm run test:web`；仅在有意输出变化时刷新金样。
9. 在 `FORK_CHANGES.md` 记录本次同步。
