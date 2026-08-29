# Agent Note: 部分历史下的 Turn Process 折叠与更丰富的摘要

Status: implemented

[English](2026-08-29-turn-process-fold-with-partial-history.md) | 中文

> fork 相对上游 Turn Process 折叠的本地化差异（上游决策见 [2026-08-14-web-turn-process-folding](2026-08-14-web-turn-process-folding.zh.md)）。

## 问题

上游的折叠在仍有更早历史可加载时（`historyIncomplete` 门）不显示折叠控件、也不隐藏任何成员。真实会话几乎总是超过一页历史，导致折叠实际从不生效——已关闭回合的中间工具调用和 Assistant 消息全部内联展开。fork 合并前的折叠没有此门，且额外显示回合时长。

## 决策

- `ChatNodeSeat` 不再读取 `historyIncomplete`：`processWindowReady` 与折叠布局键集去掉该门，`hasMore` 为真时已关闭回合同样默认折叠；`ChatView` 停止传递该 prop。
- `TurnProcessNodeView` 增加回合墙钟时长（取自回合位置 `turn/start` 与 `turn/end` 边界），并采用折叠前缀标签（`Collapsed {counts}` / `已折叠 {counts}`）；计数为零时保留 `Thought for a while` 并追加时长（若存在）。控件由通栏分隔线改为圆角胶囊样式。
- 测试：两个部分历史折叠测试改为断言折叠生效；标签断言覆盖前缀与时长段；chat-scroll 锚点测试的页数上限适配 8 消息分页。

## 后果

- 无论剩余历史多少，已关闭回合默认折叠；部分页显示胶囊控件，且每页首绘折叠即稳定（与回合完整边界工作配套）。
- 回合时长与已折叠前缀标签来自客户端已派生的位置数据；无新增事件。

## 备选方案

- **保留 `historyIncomplete` 门控**：与分页矛盾——被服务的页按构造就是不完整的，折叠只会在短会话出现。
- **仅在用户显式操作时折叠**：中间的 Tool/Assistant 行仍会占据每个长会话的默认视图。


## 验证

`pnpm run test:gui` 全绿；seeded-history 金样已刷新；提高页数上限后 chat-scroll-contract 锚点测试全绿。
