# Agent Note: 部分历史下的 Turn Process 折叠

Status: implemented

[English](2026-08-29-turn-process-fold-with-partial-history.md) | 中文

> fork 相对上游 Turn Process 折叠的本地化差异（上游决策见 [2026-08-14-web-turn-process-folding](2026-08-14-web-turn-process-folding.zh.md)）。

## 问题

上游的折叠在仍有更早历史可加载时（`ChatNodeSeat.processWindowReady` 的 `historyIncomplete` 门）不显示折叠控件、也不隐藏任何成员。被服务的页按构造就是局部的（`session.ts` 的 `PAGE_MESSAGES = 8`），因此真实会话的 `hasMore` 几乎恒为真，折叠从不出现——已关闭回合把中间的 Tool 调用、Context 行与 Assistant 消息全部内联展开。

## 决策

- `ChatNodeSeat` 既不再声明也不再读取 `historyIncomplete`：`processWindowReady` 去掉该门，`hasMore` 为真时已关闭回合同样默认折叠；`ChatView` 停止传递该 prop。注入点带 `// Fork patch (FORK_SURFACE.md)` 标记，对应行登记在 [FORK_SURFACE.md](../../../FORK_SURFACE.md)。
- 折叠标签与回合时长采用上游的内联形式：fork 的分类折叠前缀与墙钟时长已退役给它，时长仍在轮次页脚的用量详情中可见。
- 测试：`folds a closed Turn even while history is partial` 与 `folds final-page groups while history is partial` 断言 `hasMore` 为真时折叠生效，且在翻回 `false` 后保持。

## 后果

- 无论剩余历史多少，已关闭回合默认折叠；局部页显示折叠控件，且折叠在页面首绘即稳定。
- 被服务的页按回合对齐（`session-controller/src/fork/page-boundary.ts` 把上游切点展宽到所属回合的开场事件），因此折叠跨度是整个回合，控件计数覆盖它隐藏的每个成员。
- 除此之外没有其他变化：被隐藏的成员就是已加载页携带的那些行。

## 备选方案

- **保留 `historyIncomplete` 门控**：与分页矛盾——被服务的页按构造就是不完整的，折叠只会在短会话出现。
- **仅在用户显式操作时折叠**：中间的 Tool/Assistant 行仍会占据每个长会话的默认视图。

## 验证

`pnpm run test:gui`；两个部分历史折叠测试在无此改动时失败（`expected null not to be null`）、有此改动时通过；seeded-history 浏览器金样已刷新；`pnpm run typecheck` 干净。
