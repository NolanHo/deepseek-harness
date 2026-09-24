# Agent Note: 推理（reasoning）分片的逐帧累计发布与浏览器压力验证

Status: implemented

[English](2026-08-03-opt-in-reasoning-chunk-browser-stress.md) | 中文

## 问题

长 reasoning stream 会在一个持久 settlement 前连续产生大量进程本地 `assistant/live-chunk` update。每个 update 都必须保持有序并折叠进 Assistant Definition，以保留实时完整性；settlement 则嵌入精确 stream 供 replay。React 只需要看到当前累计结果，不需要观察同一浏览器帧内每个中间态。

异步流的每次 `yield` 都可能形成新的微任务边界，因此仅靠微任务合批的 `Notifier.markDirty()` 会退化为每个分片重建一次 `ConversationSnapshot`、通知一次 `useSyncExternalStore` 并运行一次 React render。即使实时 Think 行保持折叠，100,000 个推理分片仍会让协调、提交和布局工作压住主线程。性能边界必须位于会话接收与 React 发布之间；测试必须保留每个原始事件，并区分单批渲染成本与无限累积的 transport backlog。

## 决策

Session Controller 把每个 Client-only live chunk 追加到 event source，Conversation 会立即把它折叠进每个匹配 Definition State。Chat 与 Trajectory Definition 为可见 `block-start`、`text-delta`、`reasoning-delta`、`tool-call-delta` 与 `block-end` chunk 请求 `animation-frame` publication；第一项变化调度一次 `requestAnimationFrame`，后续 chunk 继续更新 State，frame callback 再从最新 State materialize 一个累计 snapshot。`usage` 与 `finish` 不请求 publication。持久 `assistant/message` 或 `assistant/attempt` settlement 会立即发布，并在历史 replay 中复现同一最终 stream。

`BoundConversation` 为每个 Session 拥有一个 pending frame。普通结构 event 与持久 settlement 请求 immediate publication，flush 最新 assembled State，并让之后的 frame callback 因没有 dirty Context 而不产生影响。没有 `requestAnimationFrame` 的环境会立即发布。Settlement 可以跳过一个尚未显示的中间 partial，但发布的最终 content 与持久嵌入式 stream 保持完整。

折叠的 Think 行渲染推理字符数而非文本，因此其摘要宽度按行固定、内容至多随每个已发布的帧变化一次；发布路径上不存在横向滚动、同步布局读取或平滑滚动动画。Chat 正文滚动、历史 prepend 锚定与用户触发的 `scrollIntoView` 不受影响（见[折叠 Think 字符数](../feature/2026-09-12-collapsed-think-character-count.zh.md)）。

`pnpm run test:web:stress` 保留为无密钥、需显式启用的浏览器性能证据。测试持有的模型 adapter 通过真实 Host、Gateway、WebSocket、Session 归并和实时 Think 行发出 100,000 个 `reasoning-delta` chunk，实时 Think 行显示的字符数达到 adapter 实际发出的推理长度即证明事件经过生产会话归并并到达该行。每批 128 个 chunk 会等待一次浏览器 timer 轮次后再发下一批，因此 50 毫秒心跳与预先调度的 DOM 事件按 250 毫秒预算测量一个有界接收／渲染区间，而不是累积的 socket backlog。结尾标记证明所有 chunk 都已到达 UI。`DSH_WEB_STRESS_HEADFUL=1` 允许开发者在可见浏览器中使用 Performance 面板分析同一场景。该压力车道是手动性能诊断与修复验收的证据，不是默认 CI 门禁，也不替代确定性的调度单元测试。

聚焦测试固定 `Notifier` 的逐帧合并、结构事件抢占、失效回调和无 rAF 回退，并在 `Session` 层证明一帧只发布一次最新累计文本且定稿不会被旧帧回调重复通知。按需启用的浏览器用例持有 adapter 节奏、精确事件数和结尾标记交付，不把 100,000 分片工作负载带入默认测试套件。

## 曾考虑的替代方案

**在 React 内对快照使用 transition、deferred value 或组件节流。** 不予采纳：会话源仍会逐分片通知 `useSyncExternalStore`，React render 在组件决定延后展示之前已经发生，且多个消费同一快照的组件需要重复实现策略。

**在 Definition fold 前丢弃或抽样 live chunk。** 不予采纳：实时累计 State 会与持久嵌入式 stream 分歧，并可能省略可见中间内容。紧凑持久存储与逐 frame 合并 React publication 解决的是不同成本。

**只使用微任务合批。** 不予采纳：连续异步 `yield` 会在相邻分片间排空微任务队列，使微任务合批近似退化为每个分片通知一次。

**按动画帧控制测试生产方节奏。** 不予采纳：生产方会在渲染变慢时同步减速，使页面获得真实网络流不存在的隐式背压，并掩盖主线程饥饿。

**不等待确认就把原有浏览器本地速率发入 WebSocket。** 不予采纳：transport 工作的排队速度会超过模型可能达到的产出速度，使结果变成 socket backlog 测量。浏览器 timer 确认限制每批工作量，同时 heartbeat 仍能发现一批数据使页面饥饿。

**真实外部模型或录制的 HTTP 字节流。** 不予采纳：外部模型不具确定性，HTTP 录制还会增加第二种 fixture 格式，却不会改进目标断言。测试持有的 adapter 让每个 chunk 经过真实 Host 与浏览器 transport，同时控制工作负载。

## 后果

流式 `ConversationSnapshot` 的发布频率受浏览器绘制频率约束，React 每帧至多处理一个包含全部已接收文本的累计 partial；结构事件仍可更快发布。接收、排序、日志记录、字符串拼接和累积器更新仍按原始分片执行，因此该决策降低的是快照重建与 React 工作，不把原始流解析成本伪装成已解决。

折叠的 Think 摘要自身不持有横向位置：该行渲染的字符数宽度按行固定，摘要中没有任何部分依赖累计文本的布局。React 仍按累计快照正常提交，正文滚动与用户交互保持其即时性。

浏览器压力车道继续提供真实组装应用与载体上的响应性信号和可见 profiling 入口，但硬件与调度差异使其只适合作为显式性能证据。确定性的 focused tests 负责守住发布次数、累计内容与抢占顺序，默认测试车道保持快速。
