# Agent Note: 手机端设置弹窗与会话 header

Status: implemented

[English](2026-09-12-phone-settings-dialog-and-header.md) | 中文

> 范围：手机视口（≤560px CSS 像素）下让设置弹窗不可用、并让会话 header 出血的两处缺陷，以及修复它们的 fork 规则。[ui-settings-general](../../../../packages/client/ui-settings-general/README.zh.md) 与 [ui-conversation](../../../../packages/client/ui-conversation/README.zh.md) 的 README 拥有各自包的契约；[移动端外壳笔记](../architecture/2026-08-23-transcript-turn-fold-and-mobile-shell.zh.md) 拥有手机态本身。

## Problem

在 412×905 CSS 像素的手机视口（一加 13：1440×3168 @ DPR 3.5）下打开设置，模态层被渲染在 ui-layout 的移动抽屉内部。抽屉是 `position: fixed` 且打开时携带 `transform: translate(0)`，而 transform 非 none 的元素会成为其 `position: fixed` 后代的包含块，于是该层的 `inset: 0` 解到 320px 的抽屉而非视口。抽屉打开时实测：overlay 319×905、panel 宽 319、导航轨 188、内容列 131——内容列每个标签都折成一两个词一行，panel 的 `overflow: hidden` 裁掉右侧控件，关闭按钮被挤到 16×28，panel 在抽屉里而非视口里居中，遮罩只盖住抽屉，使"模态"背后的页面仍可交互。

同一个 header 在带有后台任务的会话上会长到 78px：job 徽标的文案（"9 background jobs"）在收缩后的操作盒里折成四行列、lineage chip 与 preset chip 被截断在词中、会话标题只剩两个字符。任务开始或结束时该行重新折行，因此有任务运行时 header 高度持续变化。

会话 header 在每个手机宽度上都恒定溢出 4px。`.headerCorner` 带 `margin-right: -16px`，让角落控件探入桌面 header 的 28px 右内边距（28 − 16 = 视口内缩 12px），而 fork 的 ≤560px 块把该内边距设为 12px（12 − 16 = 越出视口 4px）。同一个块还用 `display: none` 隐藏了会话面包屑，使标题行只剩 agent-preset chip。

## Decision

设置模态层经 fork 自有 portal（`packages/client/ui-settings-general/src/client/fork/portal.tsx`）挂载到 `document.body`，以模块顶部一处带标记的 import，加 `SettingsRoot` 中 `SettingsPanel` 调用点的一处带标记包裹完成注入，面板自身函数体未改。`react-dom` 与 `@types/react-dom` 进入该包的 devDependencies（与 ui-primitives 的声明一致），因为客户端 bundle 把它们当作平台外部依赖。

≤560px 时设置面板以单列铺满视口（`width`/`height` 100%、`max-width`/`max-height` 100%、`border-radius: 0`、`flex-direction: column`）：导航轨变成一行，标题固定、单元横向滚动；关闭控件提升到 36px 拇指底线；导航与选项区带上 `env(safe-area-inset-*)` 内边距。

会话 header 的手机块保留 56px 前导内边距以避开抽屉入口，并预留与抽屉按钮固定 `top` 相同的顶部安全区内边距（≤767.98px 为 `padding-top: calc(10px + env(safe-area-inset-top))`，560px 块并入 `padding` 简写）：没有它时，34px 的状态栏内边距会让固定按钮比标题行低 33px，同时标题绘制在系统栏之下。两个块随后把尾部控件之外的空间交给标题行：`.crumbs` 保持可见、没有宽度底线，纯计数 chip 保持自身固有宽度，各自 `.countCompact` 让数字保持单行（`white-space: nowrap`：否则被压缩的计数会在数字内部断行，叠成两行的计数便压到尾部控件上）；`.headerActions` 保持内容宽度（`flex: 0 0 auto`）且不裁切，因为 job 徽标的菜单就绝对定位在这个盒子里；`.headerCorner` 把 `margin-right` 归零，使角落控件落在视口内缩 12px 处，与桌面一致。手机行因此有了元信息预算：560px 以下 lineage chip 与 job 徽标各自只渲染计数，本地化文案被隐藏但仍是触发按钮的可访问名称，于是标题拿回两份文案原先占用的宽度（412×915、9 子代理的 mint 会话实测：标题 88 → 172px，lineage chip 108 → 35px）。会话 header 的 agent-preset 标签在 560px 以下不渲染任何内容：它是无控件的静态上下文，图标对每个 preset 都相同，而 `title` 携带的是 preset 描述而非名称，所以加宽度上限等于两者都看不到（`.label { display: none }`）。lineage chip 保留：对子代理会话它承载该会话自己的标题，且它是进入子代理目录的唯一手机入口。会话标题的面包屑吸收该行的宽度缺口，并经 `.crumb` 的省略号截断。

## Alternatives considered

**保留原位覆盖层并把抽屉加宽。** 抽屉的 `overflow: hidden` 仍会裁掉 `position: fixed` 后代，而铺满视口的抽屉已不再是抽屉。

**改用 `inset-inline-start` 而非 `transform` 做抽屉动画。** 这能消掉这一处的包含块，却让每一帧抽屉都触发一次布局，而 sidebar-right 面板探测观察的正是外壳的 `transform` 过渡。

**不做 portal、只用 CSS 手机变体。** 弹窗于是填满抽屉而不是视口：遮罩仍只覆盖抽屉，背后页面仍可交互，桌面弹窗也仍带着错误的包含块。

**继续在手机上隐藏面包屑。** 抽屉会给会话命名，但 header 是唯一的上下文标签；可截断的标题加上内容宽度的操作簇在 360px 下放得下。

**继续用省略号处理计数文案，而不是纯计数。** 这是本笔记最初的选择，理由是纯计数 chip 需要新的 locale 键与随视口变化的文案；2026-09-22 的手机 header 一轮替换了它——组件把计数渲染进独立 span、手机块隐藏文案，纯 CSS 即可，而词句正是两个 chip 里最宽的部分。

**在手机宽度隐藏 lineage chip。** 对普通会话它是最大的元信息，但同一个 slot 在子代理会话里渲染该会话自己的标题，而它同时是进入子代理目录的唯一手机路径：抽屉树与会话搜索都把子代理子节点过滤掉，隐藏它等于同时删掉一个标题和一项能力。

**保留 lineage chip 并把标题截到两个字符。** 标题是会话唯一的上下文标识，而那个状态正是本次要修掉的缺陷。

## Consequences

设置模态层在任何宽度都相对视口定位，其手机形态是一整列全宽面板，既不折行也不裁切控件。会话 header 在手机上把该行的剩余宽度交给会话标题、让尾部控件留在视口内，并在后台任务运行时保持 30px 的单行：徽标在手机上只显示计数、既不折行，其菜单也不被裁切。

portal 把弹窗移出侧栏子树，因此依赖该 DOM 邻近关系的选择器或查询必须从文档根访问它；弹窗自身的标记、角色、焦点处理与 slot 渲染都未改变。由于该层是 `document.body` 的子节点，它落在 onboarding 标记为 `inert` 的 `#root` 之外：设置触发按钮在 `#root` 内，因此 onboarding 进行时弹窗仍不可达；两者同时打开时 onboarding 表面（z-index 1100）绘制在弹窗（z-index 1000）之上。

手机 header 的宽度分配顺序是：会话标题、lineage chip、job 徽标。560px 以下 lineage chip 与 job 徽标只显示计数且完全可点，子代理会话自己的标题仍渲染在 chip 的 `switcher` 变体里。preset 标签不进入手机 header，因此给出 preset 名称的是设置页（新建会话处的座位在自身标签没有空间时会退化为纯图标）。操作盒仍不裁切，所以徽标菜单在任何宽度都可达；360px 下徽标仍是一个数字、触发按钮仍可操作。当徽标带本身就宽过整行时——约 ≤411px 下四个徽标、≤360px 下三个——chip 仍可能压到尾部控件上：CSS 无法整块丢掉一个 chip，而那里标题宽度已经归零。

header 与抽屉按钮共享的顶部安全区预留、560px 断点与 36px 拇指底线并入 fork 的手机语汇；fork 的客户端 CSS 断点仍是 560px 与 767.98px。`FORK_CHANGES.md` 记录的 2026-08-27 移动端治理所描述的规则在本版本树中并不存在，因此承载实际交付的手机 header 与设置弹窗规则的是本笔记，而非那条记录。

## Testing

`settings-root.client.spec.tsx` 打开弹窗并断言模态层的父节点是 `document.body`、触发区子树不含它，且弹窗保留 `role="dialog"`、`aria-modal="true"` 与其 slot 提供的可访问名称。多个 CSS 契约测试用括号配平的提取器解析媒体块并钉住手机声明：`settings-root-phone-styles.client.spec.ts`（全屏面板、横向导航轨、36px 关闭）、`header-phone-styles.client.spec.ts`（面包屑吸收该行宽度缺口且没有宽度底线、两个手机块的顶部安全区内边距、内容宽度且不裁切的操作簇、角落外边距，以及「手机块不得隐藏 lineage slot」守卫）、`job-list-action-phone-styles.client.spec.ts`（纯计数 span 与其手机开关、数字单行、触发按钮宽度约束、可收缩且不裁切的徽标盒子）、`subagent-header-lineage-phone-styles.client.spec.ts`（lineage chip 的同一套纯计数与单行契约，外加「手机块不得隐藏 `switcher` 标题」守卫）与 `agent-preset-label-phone-styles.client.spec.ts`（手机上标签不渲染）。实机校验以 412×915 运行第二个 dsh 实例、针对重建后的客户端 bundle，并通过 DevTools 协议模拟顶部安全区内边距。
