# Agent Note: Reflow-stable reader position across fold and image height changes

Status: implemented

[English](2026-09-05-reflow-stable-scroll-anchor.md) | 中文

> Scope: `ui-chat` ChatView 滚动锚定。fork 模块 + 一个 ResizeObserver 回调分支。

## 问题

历史加载导致页面跳动：Turn Process 折叠要在异步投影到达后才隐藏中间行，历史图片在行落定后才加载 intrinsic——两者都在没有前插的情况下改变读者上方的高度，而分页锚点（只覆盖前插的恢复）从不补偿它们，读者内容每次可见地移位。

## 决策

`chat/fork/scroll-anchor.ts` 泛化了持有的读者锚点：在每次列尺寸变化时（与动态高度尾随共用的同一个 ResizeObserver——布局后、绘制前触发），`restoreAnchorOnReflow` 把持有行的流偏移位移写入 `scrollTop` 重新断言其位置，将写入记入 observed-top 台账（读者输入归因不会把补偿误判为用户滚动），并重新捕获锚点。折叠隐藏锚点行本身时，其上方最近存活可见行保持原位，其下内容全部保持对齐。ChatView 的注入为 import + 一个回调分支（持有锚点且无跳转进行中时执行）。

不选原生 `overflow-anchor`：fork 移除了它，因为原生调整在几何读者台账中无法与用户滚动区分；fork 自有的补偿显式写台账。不选首帧即折叠（历史行首帧就渲染为折叠态）：那要把折叠与投影管线同步，改动大得多。

## 备选方案

- **原生 `overflow-anchor`**：fork 已移除——原生调整在几何读者台账中无法与用户滚动区分，会误判并杀死尾随。
- **首帧即折叠**：同步折叠与投影管线，让历史行首帧即为折叠态；源头正确但改动大得多。
- **组件级折叠补偿**：由 disclosure 开关自行调整滚动容器；只覆盖折叠，图片加载与未来的高度变化仍无锚定。
## 验证

`scroll-anchor.client.spec.ts`（jsdom、桩几何）：行持守补偿方向与台账写入、隐藏锚点回退、零位移无操作、无存活行时清空锚点。文件覆盖率 100%；ui-chat 套件 322 通过，GUI 道全绿。

## 后果

- 折叠、图片加载与 disclosure 切换不再在历史落定过程中移动读者内容；尾随路径不受影响（补偿仅在持有锚点、即读者未钉在底部时运行）。
- 补偿成本为每次列尺寸变化一次 rect 读取加一次滚动写入——按尺寸变化频率计，而非渲染频率。
