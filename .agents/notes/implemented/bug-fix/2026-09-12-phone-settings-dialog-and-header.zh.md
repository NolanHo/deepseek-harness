# Agent Note: 手机端设置弹窗与会话 header

Status: implemented

[English](2026-09-12-phone-settings-dialog-and-header.md) | 中文

> 范围：手机视口（≤560px CSS 像素）下让设置弹窗不可用、并让会话 header 出血的两处缺陷，以及修复它们的 fork 规则。[ui-settings-general](../../../../packages/client/ui-settings-general/README.zh.md) 与 [ui-conversation](../../../../packages/client/ui-conversation/README.zh.md) 的 README 拥有各自包的契约；[移动端外壳笔记](../architecture/2026-08-23-transcript-turn-fold-and-mobile-shell.zh.md) 拥有手机态本身。

## Problem

在 412×905 CSS 像素的手机视口（一加 13：1440×3168 @ DPR 3.5）下打开设置，模态层被渲染在 ui-layout 的移动抽屉内部。抽屉是 `position: fixed` 且打开时携带 `transform: translate(0)`，而 transform 非 none 的元素会成为其 `position: fixed` 后代的包含块，于是该层的 `inset: 0` 解到 320px 的抽屉而非视口。抽屉打开时实测：overlay 319×905、panel 宽 319、导航轨 188、内容列 131——内容列每个标签都折成一两个词一行，panel 的 `overflow: hidden` 裁掉右侧控件，关闭按钮被挤到 16×28，panel 在抽屉里而非视口里居中，遮罩只盖住抽屉，使"模态"背后的页面仍可交互。

会话 header 在每个手机宽度上都恒定溢出 4px。`.headerCorner` 带 `margin-right: -16px`，让角落控件探入桌面 header 的 28px 右内边距（28 − 16 = 视口内缩 12px），而 fork 的 ≤560px 块把该内边距设为 12px（12 − 16 = 越出视口 4px）。同一个块还用 `display: none` 隐藏了会话面包屑，使标题行只剩 agent-preset chip。

## Decision

设置模态层经 fork 自有 portal（`packages/client/ui-settings-general/src/client/fork/portal.tsx`）挂载到 `document.body`，以模块顶部一处带标记的 import，加 `SettingsRoot` 中 `SettingsPanel` 调用点的一处带标记包裹完成注入，面板自身函数体未改。`react-dom` 与 `@types/react-dom` 进入该包的 devDependencies（与 ui-primitives 的声明一致），因为客户端 bundle 把它们当作平台外部依赖。

≤560px 时设置面板以单列铺满视口（`width`/`height` 100%、`max-width`/`max-height` 100%、`border-radius: 0`、`flex-direction: column`）：导航轨变成一行，标题固定、单元横向滚动；关闭控件提升到 36px 拇指底线；导航与选项区带上 `env(safe-area-inset-*)` 内边距。

会话 header 的手机块保留 56px 前导内边距以避开抽屉入口，并把尾部控件之外的空间交给标题行：`.crumbs` 保持可见并获得 88px 底线，经 `.crumb` 既有的省略号截断；`.headerActions` 可收缩（`flex: 0 1 auto`、`min-width: 0`），让自身子项让位——preset chip 省略、job 触发按钮收窄——且不裁切，因为 job 徽标的菜单就绝对定位在这个盒子里；`.headerCorner` 把 `margin-right` 归零，使角落控件落在视口内缩 12px 处，与桌面一致。

## Alternatives considered

**保留原位覆盖层并把抽屉加宽。** 抽屉的 `overflow: hidden` 仍会裁掉 `position: fixed` 后代，而铺满视口的抽屉已不再是抽屉。

**改用 `inset-inline-start` 而非 `transform` 做抽屉动画。** 这能消掉这一处的包含块，却让每一帧抽屉都触发一次布局，而 sidebar-right 面板探测观察的正是外壳的 `transform` 过渡。

**不做 portal、只用 CSS 手机变体。** 弹窗于是填满抽屉而不是视口：遮罩仍只覆盖抽屉，背后页面仍可交互，桌面弹窗也仍带着错误的包含块。

**继续在手机上隐藏面包屑。** 抽屉会给会话命名，但 header 是唯一的上下文标签；88px 底线加上可收缩的操作簇在 360px 下放得下。

## Consequences

设置模态层在任何宽度都相对视口定位，其手机形态是一整列全宽面板，既不折行也不裁切控件。会话 header 在手机上显示被截断的会话标题，并让尾部控件留在视口内。

portal 把弹窗移出侧栏子树，因此依赖该 DOM 邻近关系的选择器或查询必须从文档根访问它；弹窗自身的标记、角色、焦点处理与 slot 渲染都未改变。由于该层是 `document.body` 的子节点，它落在 onboarding 标记为 `inert` 的 `#root` 之外：设置触发按钮在 `#root` 内，因此 onboarding 进行时弹窗仍不可达；两者同时打开时 onboarding 表面（z-index 1100）绘制在弹窗（z-index 1000）之上。

窄宽度下优先保证面包屑底线而非尾部控件：360px 时操作盒收缩到约 74px，preset chip 因此省略、job 触发按钮收窄为很小的目标。操作盒不裁切，所以 job 徽标的菜单仍可达；320px 视口下该触发按钮过窄而难以稳定操作，而任何在售手机宽度都不会到这一步。

字面量 88px 底线、560px 断点与 36px 拇指底线并入 fork 的手机语汇；fork 的客户端 CSS 断点仍是 560px 与 767.98px。`FORK_CHANGES.md` 记录的 2026-08-27 移动端治理所描述的规则在本版本树中并不存在，因此承载实际交付的手机 header 与设置弹窗规则的是本笔记，而非那条记录。

## Testing

`settings-root.client.spec.tsx` 打开弹窗并断言模态层的父节点是 `document.body`、触发区子树不含它，且弹窗保留 `role="dialog"`、`aria-modal="true"` 与其 slot 提供的可访问名称。两个 CSS 契约测试用括号配平的提取器解析媒体块并钉住手机声明：`settings-root-phone-styles.client.spec.ts`（全屏面板、横向导航轨、36px 关闭）与 `header-phone-styles.client.spec.ts`（面包屑底线、可收缩操作簇、角落外边距、header 内边距）。实机校验在 3099 端口以 412×905 运行第二个 dsh 实例，针对重建后的客户端 bundle。
