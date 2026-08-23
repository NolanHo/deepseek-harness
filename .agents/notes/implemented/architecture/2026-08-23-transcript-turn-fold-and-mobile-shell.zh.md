# Agent Note：转录回合折叠与移动端外壳分档

Status: implemented

[English](2026-08-23-transcript-turn-fold-and-mobile-shell.md) | 中文

> Scope：web 客户端两项产品用户可见的 GUI 行为——聊天转录中的已定稿回合折叠（`ui-conversation`）与三档视口布局（移动端侧栏抽屉 + 详情 sheet）（`ui-layout`、`apps/web`）。组合模型由 [slot 系统标准](2026-07-22-slot-type-chain-implementation.zh.md)与 [web 客户端架构](2026-07-19-gui-web-client-architecture.zh.md)持有；本 note 记录建立其上的两个视图层决策。

## Problem

长 agent 回合把最终回答埋在成屏的工具调用与中间叙述之下；读者希望过程收成一行、按需展开。分组需要一个缝隙：转录在 ChatView 的有序行列表内部组装，而"整个视图 tab"（`conversation.view`，tab 列表）与"单行"（`conversation.chat.node`，按 kind 分发）之间没有槽位——逐行插件 shadow 无法把连续多行包进一个容器，因此外部插件表达不了"折叠用户消息与结束回答之间的全部内容"。

桌面外壳同时假设了指针与宽度充裕：让步求解器永远保留 ≥56px 侧栏 rail，412px 手机视口下对话列被挤压；`openDetails` 在 ~1000px 以下被求解器静默归零而失效。移动端适配需要纯宽度求解器刻意不持有的分档语义。

## Decision

**回合折叠是渲染期视图分组，不是投影变更。** 纯预遍历（`turn-fold.ts`）按 `location.turn` 对 `order` 的连续行分组；仅当 timeline 报告回合已定稿且其 `turn-tail` 携带 `closing` 回答时才折叠。可折叠行是除 user/steering、结束 `assistant-step`（按 `finalNode.seq` 匹配）、`turn-tail`、错误行之外的全部行。折叠行完全离开 DOM（而非隐藏），折叠头携带第一个隐藏行的锚点 key，展开状态是 ChatView 本地 state（`useState` Set）——刻意不用 store：它是单次阅读的视图状态，不跨条目共享、不值得跨挂载存活。运行中回合与无 closing 回答的回合渲染与折叠前逐字节一致。不新增 Chat Node kind、不改 Session：Conversation Node 纪律保持追加热路径无扫描，timeline 在回合定稿时重发布即自动出现折叠。

**外壳持有三档视口分档；求解器保持无断点。** `MOBILE_VIEWPORT = 768`（低于 SIDEBAR_AUTO_COLLAPSE 的 1024 rail 档）在 AppFrame 决断：mobile 跳过让步求解器（`0 minmax(0,1fr) 0`），侧栏渲染在常驻挂载的 fixed 抽屉内（scrim 点击、Escape、会话切换关闭），详情列渲染为 fixed 右侧 sheet 并带框架自有的关闭 chrome——在移动宽度上恢复 `openDetails`。分档标志与抽屉开合标志存于既有 layout store；`toggleSidebar` 先判 mobile（抽屉翻转）再判 narrow（rail 再展开）分支，既有调用方（ui-sidebar 注入的 face）无需服务面变更即获得移动语义。跨任一断点重置瞬态分档本地标志；宽度偏好始终存活。拖拽手柄在 mobile 不渲染。

对话列窄屏 CSS（≤560px 的 header/tabs/转录 padding，composer 的 `env(safe-area-inset-bottom)`）与 viewport meta（`viewport-fit=cover`、`interactive-widget=resizes-content`）完成手机端收尾。折叠刻意默认收起：过程行可从日志重导出，摘要行（工具数、中间回复数、回合时长）即阅读入口。

## Consequences

- 折叠状态是 ChatView 本地 state，视图 tab 切换或重挂载即重置：刻意取舍——持久化需要 store 席位（per-session、跨条目）而唯一消费者是这一个组件。若折叠状态必须跨视图切换存活再重新评估。
- 折叠行不在 DOM 中，转录 aria goldens 与任何按 `[data-chat-flow-kind]` 计数的消费方只看到可见行；回合定稿后断言 tool-call 行存在的浏览器 e2e spec 必须先展开折叠（或断言折叠头）。既有 goldens 已相应刷新。
- 想让自己那类行免于折叠的插件（例如未来的内联交付物卡片）无法选择退出：可折叠性在视图预遍历中按 Chat kind 封闭。豁免需要在 `chat-nodes.ts` 改契约并更新本 note——不得按注册方特判。
- 移动抽屉与详情 sheet 是框架自有 chrome：占用方（ui-sidebar、details 条目）对分档无感知。任何基于网格列定位自己的东西（未来的第三个 fixed 面板）必须从 store 或 owner props 读分档，不得假设网格轨道。
- `toggleSidebar` 现在依赖分档：调用方无法强制指定列结果，只有用户意图 toggle。显式开闭控制仍是 `openDetails`/`closeDetails`；刻意未增加抽屉专属服务 face。

## Alternatives considered

- **折叠作为 Chat Node kind**（投影把跨度折叠成一个节点）：否决——会把视图呈现放进会话投影，违反"如何绘制"绝不进入 session log 的 web 层纪律，且与回放重算相抵触。
- **通过插件 shadow `conversation.chat.node` 渲染器做逐行折叠**：否决——每行各自折叠；按 kind 的渲染器够不到连续跨度组容器，而本特性明确不为它加行组缝隙。
- **行组槽位扩展点**（新 `conversation.chat.rowGroup` 包装槽，折叠作为插件）：推迟——包装槽引入的组合缝隙当前唯一消费者就是折叠；在第二个分组消费者出现前 KISS 优先。
- **移动布局用纯 CSS 覆盖现有网格**：否决——网格轨道宽度由 JS 内联计算，CSS 无法重排；抽屉开合是 scrim/Escape/会话切换都要改写的状态，属于 layout store。
- **纯 CSS 详情 sheet**（仿 TrajectoryTable 的 760px overlay）：对外壳列否决——求解器先于 CSS 把第三轨归零，且 `openDetails` 语义必须在移动端保持有意义。

## Verification

- `pnpm run test:gui` 绿（285 文件）；包套件：`ui-conversation` 30 文件/488 测试含 7 个新折叠 spec（折叠/计数、展开/再折叠、运行中回合、无 closing、通用标签、无时长、定稿自动折叠），`ui-layout` + `ui-sidebar` 13 文件/95 测试含 mobile 套件（网格塌缩、toggle/scrim 开关抽屉、sheet 开关、Escape 分层、会话切换关闭、断点跨越）。
- 集成者修复（仅测试面）后 `pnpm run typecheck` 绿：SessionProvider stub 补类型、store actions mock 补全。
- 组装构建上运行浏览器快照回放；折叠的可见输出变更已刷新转录 goldens。
