# Agent Note：OnePlus 13 移动端体验一轮治理——溢出、触控目标、portal 化弹层

Status: implemented

[English](2026-08-27-oneplus-13-mobile-ux-pass.md) | 中文

> 范围：Web 客户端手机视口质量一轮治理（目标设备 OnePlus 13，412×915 CSS 视口），在真实浏览器中以该视口往返验证。建立在[移动外壳三档位](2026-08-23-transcript-turn-fold-and-mobile-shell.zh.md)之上；不涉及布局档位或 store 变更。

## 问题

412px 视口下，会话 header 把面包屑压到 16px（只剩内边距盒），因为 header actions（`flex: none`）从不退让；composer 行与侧栏/工作区控件保持 28px 的桌面命中区；设置弹层渲染在移动抽屉内部——抽屉常驻挂载且用 transform 动画，因此成为 `position: fixed` 后代的包含块，把全屏弹层挤进 320px 抽屉；job 徽标弹层锚定在 header 右缘，超出视口；HoverCard（工作区行预览/复制）只认 hover，触屏不可达。

## 决策

**CSS 断点增量、一处 portal、一行 manifest——不重写组件。** 复用 `ui-conversation` 已有的 ≤560px/≤767.98px 断点语汇，各兄弟包各自追加 ≤560px 块：

- **Header 挤压优先级**：面包屑是会话主标识。≤560px 下 `.crumbs` 获得 88px 最小宽度底线；`.headerActions` 改为可收缩（`flex: 0 1 auto`、`min-width: 0`、`overflow: hidden`），slot 挂载点传递挤压（`min-width: 0; max-width: 100%`）；agent-preset 标签在 ≤560px 折叠为图标（全名在 title 提示里）；job 徽标 trigger/count 省略号化。
- **拇指底线**：composer 附加按钮 36px、发送 40px、选择芯片 32px、上下文计量 36px；goal 暂停/编辑/清除 36px；侧栏/工作区独立按钮 36px；会话溢出行与搜索条 36px；设置/Modal 关闭按钮 36px；视图标签 35px；框架移动抽屉入口 40px。≤560px 分界使 28px 桌面节奏在其上保持不变。
- **设置弹层 portal 到 `document.body`**（`createPortal`；`react-dom` 加入 `ui-settings-general` devDependencies，对齐 `ui-primitives`）：渲染在带 transform 的抽屉内的 fixed 覆盖层会被钉在抽屉里。≤560px 下面板全屏，配 48px 纯图标导航轨与 36px 关闭按钮。
- **job 弹层**在 ≤560px 变为 fixed 底部内嵌面板（12px 内边距，位于 composer 之上）。
- **HoverCard** 增加长按路径（`touchstart` 停留时长 = hover 延迟，移动/抬起取消；卡片显示期间抑制 contextmenu），并把 fixed 卡片 clamp 在视口内，不再无条件锚在 wrapper 右侧。
- **浮动镀铬 token 修复（追加）**：移动抽屉入口与 details sheet 关闭按钮此前不可见——浅色主题白底配白图标，因为把 `--dsw-alias-button-floating-fill` 与 `--dsw-alias-label-primary-inverted`（深色底配对）组合。两者现对齐桌面「回到底部」按钮的配对：`--dsw-alias-label-primary` 图标 + `border-l2` 细描边 + `--dsw-shadow-lv2`；sheet 关闭按钮同时 24→32px。双主题验证：浅色 = 白色圆上深墨图标加细描边/阴影；深色 = 850 填充上近白图标。
- **移动端精简（追加）**：手机 chrome 去掉两块桌面专属表面——header utilities 里的 session log 导出胶囊（≤560px `display: none`；`/export` 命令与共享弹窗仍可用），以及侧栏品牌行的 commit hash 徽标（≤560px `display: none`；开发者遥测信息，非用户 chrome）。工作区行拖拽无需改动：HTML5 DnD 在触屏上从不激活，行在手机上本来就是惰性的。
- **测试契约**：`ui-workspace` 的 browser-styles 套件钉住顶层 CSS 声明值；其解析器现在跳过 `@media` 块（括号配平扫描），因为断点覆盖不属于被钉住的契约。

## 后果

- 桌面布局不变：每条新规则都在 ≤560px（或已有 header 让位规则使用的 ≤767.98px）之下，1280px 回归检查无溢出。
- `ui-settings-general` 现在导入 `react-dom`；其 devDependencies（连同 lockfile）新增 `react-dom`/`@types/react-dom`。client bundle 保持 react/react-dom 对 shell 外部化，bundle 体积不变。
- 想要自身不可收缩控件的 `.headerActions` slot 消费方必须自行局部退出；移动端挤压是外壳默认行为。
- job 弹层的移动形态是 `position: fixed`，相对 trigger 测量的调用方必须按视口分支。

## 备选方案

- **免 portal 的设置修复（抽屉改用 `left` 动画）**：拒绝——layout 节流动画替代合成器友好的 transform，且抽屉的 `overflow: hidden` 仍会在后续层叠上下文变化下裁剪 fixed 后代。
- **全局 `@media (hover: none)` 抑制 hover**：拒绝——一刀切会与每个组件的 hover 镀铬冲突；唯一要紧的触屏缺口（HoverCard）走定向长按路径。
- **所有控件就地放大到 48px**：拒绝——composer 行在 412px 下会折行；32–40px 目标配合现有间距节奏保持单行且拇指可用。

## 验证

- 412×915 下对线上构建的多轮浏览器验证：header 面包屑 16→88px，hero/会话/trajectory/设置各面零文档溢出，抽屉/搜索/设置/菜单逐一实操，长草稿 composer 增长，横屏 915×412，桌面 1280 回归。
- 十个受影响包 `pnpm vitest run`：94 文件 / 1487 测试全绿（ui-workspace browser-styles 解析器同变更内更新）。
- `tsc -b tsconfig.client.json` 全绿；变更 TS 文件 oxlint 全绿。
