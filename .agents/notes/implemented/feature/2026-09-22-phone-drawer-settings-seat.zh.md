# Agent Note: Phone drawer settings seat — the entry moves into the brand row

Status: implemented

[English](2026-09-22-phone-drawer-settings-seat.md) | 中文

> 范围：Web 客户端手机抽屉（低于 768px `MOBILE_VIEWPORT` 断点）内 Settings 入口的位置。[移动外壳笔记](../architecture/2026-08-23-transcript-turn-fold-and-mobile-shell.zh.md) 拥有手机形态，[手机端设置弹窗笔记](../bug-fix/2026-09-12-phone-settings-dialog-and-header.zh.md) 拥有弹窗与会话 header，[ui-sidebar](../../../../packages/client/ui-sidebar/README.zh.md) 与 [ui-layout](../../../../packages/client/ui-layout/README.zh.md) 的 README 拥有各自包的约定。

## 问题

在手机抽屉中，Settings 入口此前是侧栏列的最后一行：一条 42px 通栏行固定在 300px 覆盖层底部，它与可滚动会话列表之间没有任何缓冲。412×915 下这行正落在滚动列表时拇指停留的位置，于是落在该处的滚动或点选会话会打开 Settings，而不是用户本来要点的目标。桌面侧栏保留页脚位置；误触属于抽屉形态。

## 决策

frame 把抽屉形态报告给侧边栏占用方，设置席位随该报告移动。

`SidebarOwnerProps` 新增必填的 `mobile: boolean`。AppFrame 在抽屉分支置真（`{ collapsed: false, width: DRAWER_WIDTH, mobile: true }`），桌面列置假。`mobile` 为真时，`SidebarRoot` 把 `sidebar.settings` 席位渲染在品牌行中品牌的正后方，并传入紧凑 owner 参数 `{ wide: false }`，让注册方渲染纯图标触发行；页脚此时只保留 `sidebar.footer.action`。抽屉品牌行从行首开始排布（`.drawerLogoRow`），品牌不再伸展（`flex: 0 1 auto`），折叠按钮用 `margin-left: auto` 保持在行尾，因此席位紧贴品牌而非落在行尾，品牌旁的空白也不再是 New Session 的点击目标。抽屉之外，标记结构、owner 参数与 CSS 均不变。

两种形态下该席位都只渲染一次。设置弹窗保留 fork 的 portal，因此从品牌行打开时，弹层仍挂载在 `document.body` 下。

## 备选方案

**在品牌行再挂一个触发按钮，同时保留页脚席位。** `sidebar.settings` 是 `single` slot，每次挂载都带自己的弹窗状态，两个触发按钮会挂载两个弹窗实例；而且产生误触的页脚行仍然留在原处。

**所有宽度都把握到品牌行。** 否决：这会改动无人反馈的桌面侧栏，而收起轨道在其 36px 行里没有放第二个控件的位置（轨道的品牌行只有折叠按钮）。

**让侧边栏自己读视口（媒体查询）来决定。** 否决：断点由 frame 通过 `useMobileRegime` 拥有，客户端业务组件不自行读取外部状态。

**把席位放在品牌行行尾、紧邻抽屉折叠按钮。** 否决：这会把设置目标放到抽屉关闭控件旁边，只是把一种误触换成另一种；行首位置也符合「放在 logo 右边的空白处」这一诉求。

**通过渲染两次席位、或把连接指示器移入页脚操作席位，来给抽屉保留连接控件。** 暂否决：这需要第二次注册外加指示器的位置约定，而宽版页脚席位在桌面上已经拥有该控件（见后果）。

## 后果

- 手机上 Settings 入口是品牌旁的紧凑图标，抽屉页脚只保留页脚操作：会话列表末端不再与设置行相邻。
- 页脚操作仍堆叠在抽屉页脚：有动态插件面板处于活动状态时（`ui-cordis`）会在该处渲染自己的 42px 通栏行，因此页脚对其他控件仍保持该行形态，只是设置入口不再位于其中。
- 手机抽屉失去连接控件，既包括状态胶囊，也包括它的手动重连操作；自动重连仍然继续。该指示器属于宽版席位——`SettingsRoot` 渲染的是 `<ConnectionIndicator state={wide ? connectionState : undefined}>`——因此紧凑抽屉席位不显示断连、重连中与已连接胶囊，抽屉唯一的连接状态面在断点以下消失。桌面展开列保留它；收起轨道的紧凑席位从来没有携带过它（其自身用例钉住了这一缺席）。若要恢复手机端表面，需要第二个更小的连接呈现（页脚操作贡献），而不是加宽品牌行。
- 品牌旁的空白不再是 New Session 按钮的一部分，因为品牌在抽屉行中不再伸展。
- `SidebarOwnerProps` 是 `sidebar` slot 的公开 owner 参数：替换占用方必须接受 `mobile`。生成的客户端 slot catalog 会逐字嵌入该声明文本，同一次改动内已重跑生成。

## 测试

- `packages/client/ui-layout/tests/app-frame.client.spec.tsx` 钉住形态传递（抽屉内 `mobile: true`；桌面列与重新越过断点之后为 `false`），并在类型检查期钉住该字段必填（`expectTypeOf<SidebarOwnerProps['mobile']>()`）。
- `packages/client/ui-sidebar/tests/sidebar-root.client.spec.tsx` 钉住位置：席位恰好一个，是折叠按钮的兄弟节点、紧随品牌按钮之后且在文档顺序上先于折叠按钮，owner 参数为 `{ wide: false }`；桌面形态下页脚席位为 `{ wide: true }` 且不在品牌行内。`sidebar-styles.client.spec.ts` 钉住抽屉行的声明：从行首排布、品牌不再伸展、折叠按钮留在行尾。既有 `sidebar-snapshot` DOM 快照不变，因为它们渲染的是非抽屉形态（`mobile: false`）。
- `pnpm exec vitest run packages/client/ui-layout packages/client/ui-sidebar`（路径过滤同时收集同族的其余 sidebar 包）：61 文件 / 600 用例全绿。`pnpm run test:gui` 除两条在未改动 master 上同样失败的 `ui-tool` 用例外全绿（已记录在本次改动交接中）。
- 在 3097 端口的第二个 `dsh web` 实例（独立 `DSH_HOME`，不碰生产会话数据库）上、针对重新构建的产物做 412×915 浏览器验证：用 frame 浮动按钮打开抽屉、用遮罩与 Escape 关闭、从品牌行图标打开 Settings，并检查桌面 1280px 列与收起轨道的页脚位置保持不变。
