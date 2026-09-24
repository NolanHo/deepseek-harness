# Agent Note: 会话行菜单贡献点 —— 插件在侧栏 `⋯` 菜单里加一行

状态：已实现

[English](2026-09-22-session-row-menu-contributions.md) | 中文

> 范围：fork Web 客户端里侧栏会话行的 `⋯` 菜单。[FORK_SURFACE.md](../../../../FORK_SURFACE.md) 拥有该差异的重放流程；[packages/client/AGENTS.md](../../../../packages/client/AGENTS.md) 拥有本贡献点遵循的 slot、hook 与服务纪律。

## 问题

会话行的 `⋯` 菜单是 `ui-workspace` 的 `Rows.tsx` 里一个硬编码数组——重命名、分叉、归档——分发写成 `if (id === …)` 链。没有任何 slot、服务或注册表能触及该数组：生成的客户端 slot 目录里没有行级键，而唯一的会话列表座位（`sidebar.workspaces`）是单占用座位，注册它等于替换整个浏览区。因此外部插件无法加行，而复制整个列表去拥有它也不是选项。

本部署的 `dsh-session-snooze` 插件正需要这一行：它的第一版把铃铛放在侧栏底部，所有者否决了——延后动作应当落在它作用的那个会话上。

## 决定

新增一个贡献点，由 `ui-workspace` 客户端 `fork/` 目录下的 fork 模块 `session-row-menu.ts` 拥有——该模块已随 `dsh-v0.1.7-rc.1` 同步退役，座位转到 `packages/client/ui-workspace/src/client/contract/slots.ts` 中上游的 `sidebar.workspaces.session.menu.item` 与 `sidebar.workspaces.session.row.action` list slot：

- `createSessionRowMenu()` 返回注册表：`register(contribution)`（重复 `id` 抛错，返回的 disposer 移除它）、`snapshot()`（在注册变化前返回同一数组引用）、`subscribe(listener)`。
- `SessionRowMenuContribution` 是 `{ id, label, icon?, submenu(sessionId), onSelect(sessionId, leafId) }`——是数据而不是 React：注册者自己本地化文案、按会话决定有哪些叶子（空数组即对该会话隐藏这一行），并在选择时收到会话 id 与所选叶子。

`packages/client/ui-workspace/src/client/index.ts` 把注册表作为客户端服务 `sessionRowMenu` 提供，并把它的源经浏览器注册的 inject `hooks` 舱位发布出去，于是 `WorkspaceBrowser` 以 `useSessionRowMenu` 读取它——与 `hostInfo` 同一条通道。`WorkspaceBrowser.tsx` 把快照下传到两处行渲染（分组 `SessionTree` 与扁平 `FlatList`）。`Rows.tsx` 把每条贡献追加在内置三行之后，`submenu(sessionId)` 返回空数组的贡献对该会话隐藏，并把交给 `Menu` 的叶子 id 命名空间化为 `<contributionId>\u0000<leafId>`；`onSelect` 处理函数把该前缀解析回所属贡献，并以贡献者自己的叶子 id 调用它。内置链保持"无未知 id 兜底"的形态——贡献 id 在它之后解析，绝不作为它的 `else` 兜底，因为那个兜底会把未来某个未知 id 交给归档分支。

`Menu` 的单层悬停子菜单无需改动：`MenuItem.submenu` 是上游能力，延后动作所需的第二层本就存在。

贡献的 `label` 接受 thunk，并在行构建菜单项处重新求值。注册者不能在注册时固化本地化文案：`apply` 运行时客户端 locale 服务仍持其 provisional 值，在那里读取的标签会冻结在引导语言上。该规则与 slot 的 `label` 选项一致。

## 考虑过的替代方案

**为菜单项开一个 slot。** slot 渲染 React 节点，而 `Menu` 渲染数据数组。slot 要么把行菜单推上它并不使用的 React 组合路径，要么要求注册者渲染原语无法消费的 `MenuItem` 形状节点。

**在 fork 里硬编码一行，去调用一个可选的插件服务。** 菜单侧更小，但 fork 的源码里会出现某个插件的功能名，而且该插件未安装时这一行仍须渲染（禁用或缺席）——差异会比它的消费者活得更久。

**用叶子 id 约定替代命名空间。** 要求全局唯一叶子 id 把撞车风险摊给每一个未来的注册者；而行可以免费给它们加前缀。

## 后果

- 贡献是每次渲染求值的数据：`submenu(sessionId)` 回调读取注册者的实时快照与行自身的时钟，因此只要行渲染，标签就是当前的。除此之外没有任何东西代注册者重渲染该行——这正是延后插件的「剩余时间」与侧栏自身时钟一样新鲜的原因。
- 消费者是本部署的 `dsh-session-snooze` 插件。卸载它之后，注册表保持 `register`/`snapshot`/`subscribe` 形态但不再贡献任何内容——没有死菜单行，fork 代码里也没有插件名。
- 同步时必须重放四处标记注入；注册表模块本身逐字复制。重放方式与消费者记录在 `FORK_SURFACE.md` 的清单行里。

## 验证

`npx vitest run packages/client/ui-workspace`——新增的 `tests/session-row-menu.client.spec.ts` 覆盖注册顺序、重复 id 拒绝、disposer 移除、空子菜单隐藏规则、`\u0000` 命名空间往返，以及内置行保持原有顺序与行为；`tests/rows.client.spec.tsx`、`tests/workspace-browser.client.spec.tsx` 与 `tests/apply.client.spec.ts` 承载注入的接线。`npx tsx scripts/verify-fork-surface.ts` 证明新行已在两种语言的清单文件中登记；第二个 `dsh web` 实例（端口 3097、独立 `DSH_HOME` 与会话库）在浏览器里走通了该行、悬停子菜单、预设延后、`取消延后（剩余 1 小时）` 叶子与自定义时长弹窗。
