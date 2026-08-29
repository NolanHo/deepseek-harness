# Agent Note：启动不再凭空创建会话——干净存储的浏览器停留在 hero 页

状态：已实施

[English](2026-08-28-startup-reuse-only-session-selection.md) | 中文

> 范围：Web 客户端一次性启动选择策略 `WorkspaceRuntime.startInitialSelection`。不涉及 host 侧、持久化或线上格式变更。

## 问题

任何无法恢复"已保存当前会话"的浏览器连接（手机 PWA 重装、内嵌 webview、存储被系统回收、新设备）都会让 `startInitialSelection` 连接最近工作区，并在没有可复用空白会话时**创建**一个。每次这样的连接都会在侧栏留下一个纯种子会话（permission/sandbox/approval 预设事件 + `session/end-seed`，无任何内容），标题取工作区名——用户没做任何操作，左侧却凭空出现空的 "deepseek-harness" 会话；手机重连几次，几秒内就会冒出好几个。

## 决策

**启动只复用，创建保留为手势。** 复用扫描从 `connectWorkspace` 中提取为私有方法 `blankSessionOf(workspace)`（成员关系/规范 cwd/归档规则不变）。`connectWorkspace` 保持"复用或创建"契约——新建会话按钮、品牌快捷入口、hero 工作区选择器仍会创建会话。`startInitialSelection` 现在只在最近工作区存在可复用空白会话时打开它，否则停留在空态 hero 页面、不调用 host；随异步创建一起消失的还有失败重试机制。

测试面钉住两个分支：

- runtime 用例：最近工作区无空白会话时启动零创建、保持未选中；有可复用空白会话时启动直接打开、零创建。
- assembled `built-boot` 快照与四个 fixture 快照（`todo-row`、`search-card`、`image-display`、`max-tokens-notice`）显式展开工作区组——此前由启动自动打开的会话替它们展开。
- `startup-auto-selection` e2e 保留其"持有 `session.history`"的复用流程（可观测行为不变），文件头注释记录新策略；无空白分支由单元用例 + assembled 快照钉住（e2e 宿主难以造出无空白会话的工作区）。

## 后果

- 干净存储的连接落在 hero 页（wordmark + composer），不再凭空生成会话。
- 空白会话复用被两条路径共享，新建会话手势会与启动策略此前的复用去重。
- 删除此变更前遗留的空白会话后，下一次干净连接将永久停留在 hero 页。

## 备选方案

- **保留创建路径、事后清理**（host 侧或 cron 删除过期空白会话）：清理是补救不是预防——两轮清理之间幻影行依旧出现，且 host 侧改动需要重启。
- **只复用 + 自动展开最近工作区组**：树的展开状态派生自当前会话；为一个尚未打开的会话解耦展开状态，只为纯装饰收益引入启动期专用状态。
- **永远创建、从不复用**：两条轴都否决——它破坏新建会话手势依赖的复用契约，且每次重载都会再造一个空白会话。
