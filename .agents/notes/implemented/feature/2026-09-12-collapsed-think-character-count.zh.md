# Agent Note: 折叠的 Think 行显示推理字符数

Status: implemented

[English](2026-09-12-collapsed-think-character-count.md) | 中文

## Problem

对话转录中折叠的 Think 行预览推理正文——首行，或块仍在运行时的流式尾部。这段预览是转录过程扫读中最密、变动最频繁的文字，并且与回答正文争夺注意力。该行只需报告发生过推理、以及推理有多少。

## Decision

折叠摘要渲染推理块的字符数、不渲染任何推理文本，形态为一条 locale 所有的字符串：位数按区域分组的精确整数加单位。推理流式到达期间计数随块长度实时增长，因此运行中的行仍表现为在动；该行保留其扫光动画、`data-state` 属性与视觉隐藏的运行中标签。

展开时逐字节渲染完整推理文本，包括模型输出的任何 `**`——双星号剥离只存在于折叠预览中；展开入口为行标题与计数本身。

计数取块文本的 UTF-16 码元长度（`text.length`），与本包既有 `json.truncated` 文案同一约定。

## Surface

- `packages/client/ui-chat/src/client/chat/ReasoningRow.tsx`——折叠摘要为 `t('message.think.chars', { count: formatExactCount(text.length, t) })`；两个取行辅助函数已删除；摘要 span 不再携带 `data-follow-end` 属性；展开后的 `thinkBody` 渲染完整文本。
- `packages/client/ui-chat/src/client/chat/ReasoningRow.module.css`——上游那两条 `[data-follow-end]` 规则随该属性一并删除，留下一处 `/* Fork patch (FORK_SURFACE.md) */` 标记。
- `packages/client/ui-chat/src/client/chat/token-format.ts`——`formatExactCount(value, t)` 经 `number.groupSeparator` 负责按区域分组的精确整数格式化；`formatExactTokens` 委托给它。
- `packages/client/ui-chat/src/client/locale.ts`——新增的 `message.think.chars` 为 `{count} characters`（en）与 `{count} 字符`（zh）。
- 测试——`tests/reasoning-row.client.spec.tsx` 覆盖计数、分组、流式期间实时增长，以及从标题或计数展开；`tests/coverage-tails.client.spec.tsx` 与 `tests/chat-view.client.spec.tsx` 中过期的折叠预览断言已替换，`tests/chat-branch-tails.client.spec.tsx` 删除一个过期用例，`apps/web/tests/lifecycle-chrome.e2e.ts` 去掉 `[data-follow-end]` 视口钉住轮询，选择性压力泳道 `apps/web/stress-tests/reasoning-chunks.stress.ts` 断言显示计数等于 fixture 实际发出的推理长度（`packages/client/connection/src/client/fixture.ts` 中 fixture storm 状态上的 `reasoningCharacters`）。19 个可比较、含 Think 行的 `snapshots/web/**/*.expected.md` golden 只取一次 `DSH_SNAPSHOT=refresh` 运行中这些行的计数，使该刷新夹带的无关注成差异（被移除的访问模式 chip、TurnProcess 标签、与本机相关的会话行）留在本次改动之外。
- Fork 登记——这一处对上游的有意分叉登记为 `FORK_SURFACE.md` 的 Tier C 行与 `FORK_CHANGES.md` 的一条记录。

## Alternatives considered

- **紧凑计数（`1.2K`）。** 否决：折叠行是精确大小唯一可见的地方，而在这里精确不付代价。
- **保留文本预览并追加计数。** 否决：那会留下正被移除的正文噪声。
- **只给数字、不带单位。** 否决：locale 所有的文案必须说明数字度量的是什么。
- **在同一次改动里一并改轨迹视图的思考预览。** 否决：那是独立实现（`ui-trajectory`）、位于对话转录之外，因此范围保持在 Chat 转录。
- **让计数在悬停或 tooltip 中揭示推理文本。** 否决：仅悬停可得的入口在密集转录扫读中不可见，对非指针读者也不可见。

## Consequences

- 展开后的行仍是推理文本唯一可读之处。
- 因为折叠行不渲染任何推理文本，Think 行处于折叠状态时浏览器页内查找无法定位推理正文。接受：计数仍报告其存在与大小，展开即恢复文本。
- 折叠行能报告推理仍在到达，却无法显示哪段正文到了：该信号只由扫光动画与 `data-state` 属性承载。
- 选择性压力泳道在当前树上无法执行：`vitest.web-stress.config.ts` 是唯一缺少共享 `standardDecoratorPlugin` 的浏览器配置，套件在加载阶段即报 `SyntaxError: Invalid or unexpected token`（用未改动的文件复现）。其断言已改为显示的字符数，但在该配置补上插件之前保持未执行状态。
- 归档的上游注记 [`2026-08-02-web-thinking-tail-scroll`](../../archived/feature/2026-08-02-web-thinking-tail-scroll.md) 与 [`2026-08-14-web-turn-process-folding`](../../archived/feature/2026-08-14-web-turn-process-folding.md) 作为本次分叉所替代的上游折叠预览与尾部跟随行为的冻结历史保留。
- [帧合并的推理块发布与浏览器压力验证](../testing/2026-08-03-opt-in-reasoning-chunk-browser-stress.zh.md) 对发布调度仍然有效；其钉住水平尾部的对齐方式由本注记取代。
