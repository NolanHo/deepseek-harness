# Agent Note: Session hover card removal — the sidebar keeps only the Workspace card

Status: implemented

[English](2026-09-22-session-hover-card-removal.md) | 中文

> 范围：fork Web 客户端侧栏 Session 行的悬浮卡片。[ui-workspace README](../../../../packages/client/ui-workspace/README.zh.md) 拥有该包的当前行为；[FORK_SURFACE.md](../../../../FORK_SURFACE.md) 拥有该差异面的重放流程。

## 问题

左侧栏的 Session 行在停留 500 ms 后会打开一张经 portal 的悬浮卡片：完整显示标题、套用「…前」模板的相对时间（「1分钟前」／「1min ago」），以及每个实时状态各一行状态文案（「空闲」「已完成」「进行中」、子代理数量、待处理交互）。卡片可被指针抵达——它距行 8 px，指针停在卡片上时保持打开——而它整个表面就是一个复制操作：把完整标题写入剪贴板。

本部署的会话列表不需要这个弹层。它重复了行本身已经呈现的内容（标题、紧凑相对时间、带读屏标签的状态点），并会随指针在列表中移动。Workspace 行的卡片是需要的，保留。

## 决策

`SessionNodeItem` 直接返回自己的行元素。`HoverCard` 包装、`SessionHoverContent` 卡片主体与 `hoverTimeLabel` 辅助函数一并删除，`.hoverStatus` CSS 块与两个字典中的 `time.ago` 条目同时删除。返回处用 `// Fork patch (FORK_SURFACE.md)` 标记记录这次删除。

行本身不变：状态点、标题、活动 Schedule 标识、紧凑相对时间，以及 Rename／Fork／Archive 菜单。`menuOpen` 仍在该行上标记打开的菜单。

Workspace 行保留其卡片及其使用的全部部件：`WorkspaceHoverContent`、`createdLabel`、`abbreviateHomePath`、`.hoverContent`／`.hoverTitle`／`.hoverPath`／`.hoverTime` 规则，以及 `hover.created`／`hover.copied`／`date.ymd` 键。`HoverCard` 及其指针宽限留在 `ui-primitives` 供该消费者使用。

去掉包装也去掉了 HoverCard 此前套在每个 Session 行外的 `display: block` span。该行现在直接是所属分组 section（分组视图）或 `role="tree"` 列表（平铺视图）的子元素，`.groupSection > * + *` 继续提供原先由包装 span 承担的 2 px 行距。会话拖拽标识本就相对行自身定位（`.sessionRow.dropBefore`／`.dropAfter` 设置 `position: relative`），因此拖放指示不受影响。

## 备选方案

**用部署开关或 CSS 隐藏保留卡片。** 类型化字典与卡片代码都会留下，而按文件 100% 覆盖率门禁会继续为一个部署从不渲染的表面索要用例。所有者要的是这个表面消失，而不是被藏起来。

**只在选中行或空白行上保留卡片。** 反对的不是卡片内容，而是会话列表里一个停留即开的弹层。

**把复制操作搬进行菜单。** 这会给一个行自身的 Rename 对话框已经完整显示的值新增菜单行与语言键，而诉求是移除卡片，不是给它的操作另找位置。

**两张悬浮卡片都删掉。** Workspace 卡片不是被反馈的表面：其行截断的目录路径没有其他完整路径展示处，且所有者要求保留。

## 后果

- Session 行不再预览完整标题，也不能再通过点击行卡片复制它；该行自身的点击、菜单、拖拽与选中行为不变。
- 任何以 Session 行父元素为锚的消费者会少一层 `span`：该行的父元素现在是分组 section（分组）或 tree（平铺）。第一方用例与侧栏 e2e 都直接以 `[role="treeitem"]` 定位行，而向上走到 tree 的组装用例仍然成立，因为它们停在 `tree` role。
- `time.ago` 不再有消费者，包括类型化 workspace 字典的键联合——两个字典互相声明完整，因此未使用的键会被拒绝。
- 该差异面登记为 `FORK_SURFACE.md` 及其中文孪生文件中的一条 Tier C 行，并附上游同步的重放流程；`FORK_CHANGES.md` 携带仅追加的双语记录。
- 上游的 session 卡片在原语包中不变：日后某次同步若恢复了 `SessionHoverContent` 及其行包装，就是这次删除的重放，对应行与该文件中的标记都写明了这一点。

## 测试

- `packages/client/ui-workspace/tests/rows.client.spec.tsx` 删除三条 session 卡片用例与另外四条用例中的卡片部分，保留全部行级断言与 Workspace 卡片断言；平铺行、待处理交互、拖拽与菜单用例不变。该文件报告 26 条用例。
- `apps/web/tests/workspace-management.e2e.ts` 删除停留并复制的用例；`seededSessionRow()` 及使用它的行菜单用例保留。
- `pnpm vitest run packages/client/ui-workspace` —— 10 文件 / 159 用例全绿。
- `npx tsx scripts/verify-fork-surface.ts` 在新增 Tier C 行后全绿（中英行数对齐、标记普查、反向检查）。
- `pnpm run verify-client-ui-i18n` 在两个字典删除 ago 模板后对本包零违规；它仅剩的一条违规是既有的 `packages/client/ui-chat/src/client/chat/fork/open-file-routing.ts` 字面量（"path open failed:"），把本次改动 stash 后原样复现。
- `pnpm run test:docs` 在 README 双语对更新并重录一致性记录后全绿。
