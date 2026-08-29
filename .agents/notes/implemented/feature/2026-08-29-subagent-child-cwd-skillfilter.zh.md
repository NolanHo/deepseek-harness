# Agent Note: in-process 子代理的 per-child cwd 与 skill 过滤

Status: implemented

[English](2026-08-29-subagent-child-cwd-skillfilter.md) | 中文

> fork 差异：两个上游增量补丁（纯加法、保持可重放），让被委派的子代理运行在自己的 workspace 并只看到 skill 目录的被允许切片。上游对每个子代理保持单一继承 workspace 与不过滤的目录。

## 问题

in-process 子代理子会话无条件继承两样东西。其一是父会话的 `cwd`：被委派去做某个项目的子代理总是在父的 workspace 运行，bash 工作目录、相对路径基、skill 项目根发现全部指向父的检出。其二是完整的继承 skill 目录：`toolFilter` 可以连 `skill` 工具一起移除，但一个需要该工具且只要部分 skill 的角色无法表达这种选择——frontmatter 的 `modelInvocable` 是 per-skill 数据，不是 per-child 决策。而 skill 注册表当时没有任何限制面，工具注册表的 `restrict()` 已经确立了 scoped 过滤的模式。

## 决策

- `SkillRegistry.restrict({ allow | deny })`（`packages/skill/skill/src/index.ts`）把编译后的过滤写入调用 scope 的层，语义镜像 `ToolsRegistry.restrict`：限制作用于继承面（全局层加查看 scope 链上的每个祖先层），限制 scope 自己的注册保持可见，限制沿链相交，被限制的名字经 `snapshot`/`list`/`get` 读作不存在——一处过滤同时约束 skill 目录工具的注入与加载，因为两者读同一个 `snapshot`。与 `tools.restrict` 的两处分歧是刻意的并在其 JSDoc 写明：`allow` 与 `deny` 互斥（skill 目录的保留清单和移除清单按角色配置，不做组合），且过滤名不对照目录校验——provider 发现是异步的，restrict 时点看不到尚未应答的 provider；过滤作用于目录随后产出的任何内容。
- `SubagentStartRequest` 增加 `cwd`（绝对路径，`childSessionMeta` 校验，子创建时覆盖父的 header 值）与 `skillFilter`（由 `applyChildComposition` 在子创建窗口作为 scoped `skills.restrict()` 应用，与既有 `tools.restrict` 并列）。`ChildComposition` 携带 `skillFilter` 供创建与冷恢复两处使用；驱动与 continuation manager 透传两个请求字段。
- continuable descriptor 记录这两个字段（`SUBAGENT_DESCRIPTOR_VERSION` 3 → 4）。冷恢复从 descriptor 重新应用 `skillFilter`（resume 复原创建时的组装，不是调用方当前配置）；descriptor 中的 `cwd` 是声明组装的持久记录，恢复会话自身的持久 header 仍是 workspace 权威——创建元数据被恢复、从不重盖。v3 descriptor 读作不支持（本运行时不可恢复该子代理），而不是部分应用。
- subagent seam 保持独立于 skill 注册表的声明：`types.ts` 的 `SkillFilter` 是注册表 `SkillRestriction` 的结构镜像，`applyChildComposition` 经 `childCtx.get('skills')` 收窄到它需要的唯一方法。组装中无注册表时的 `skillFilter` 请求让 start 失败而非静默展示全部 skill。这避免扩大 fork 的 `dsh-subagent` → `dsh-skill` 依赖边（补丁保持在两个包的源码树内）。

## 后果

- 被委派的子代理可以按角色隔离运行：自己的 workspace（bash、fs、LSP、AGENTS.md 发现、skill 项目根全部跟随会话 header）、自己的 skill 切片（目录与加载一起过滤）。这是注意力与上下文隔离，不是权限隔离——sandbox 策略未变。
- one-shot 子代理不在磁盘记录新内容（无恢复）；continuable 子代理在版本化 descriptor 中持久化两个字段，v3 continuable 子代理在本构建下不可恢复——pre-release 阶段，仓库拒绝旧的磁盘格式而非部分应用。
- fork 的 Tier C 上游冲突面增加两个文件（`skill/src/index.ts`、`subagent/src/{types,child-agent,descriptor,continuation}.ts` 加驱动与两处测试树）；上游重构周边代码的冲突是上下文级的，descriptor 版本号若与上游同期 bump 需手动做字段并集。
- `applyChildComposition` 中的 `ctx.skills` 访问是结构化的（`ctx.get`），注册表 `restrict` 的签名漂移会在 fork 自己的组合测试处暴露，而不是 `dsh-subagent` 的编译期。

## 备选方案

- **在 `SubagentCapabilities` 上为 `cwd`/`skillFilter` 加 capability 旗标**：旗标门控 provider 分发，但这两个字段是共享 in-process 驱动与 continuation manager 应用的组装输入，不是 per-provider capability；out-of-process provider 直接忽略（在请求字段上写明）。门控会为本补丁写集之外的每个 provider 包带来改动，却没有行为收益。
- **`dsh-subagent` 依赖 `@deepseek-ai/dsh-skill`**（type-only import 换取真实 `SkillRestriction` 类型与 `ctx.skills` 增强）：作为 fork 补丁成本被否决——它引入 `package.json`/`tsconfig` reference 改动、超出源码树、扩大上游冲突面；结构镜像保持补丁纯加法。运行时侧反正走可选的 `ctx.get` 模式（`agentPresets` 先例）。
- **冷恢复时从 descriptor 应用 `cwd`**：会话 header 已持久化子代理的创建 workspace 且 `resume` 会重建它；第二条应用路径会让一个事实有两个家。descriptor 字段保持为记录。
- **在请求层先于注册表校验 `allow`/`deny` 组合**：注册表自身的 `restrict()` 是唯一执法点（空过滤、双向、非 scoped context 都在那里抛错），descriptor 解析只校验结构，组合窗口以注册表自己的诊断 fail loud。
- **`tools.restrict` 式的 skill 未知名校验**：工具名同步注册、restrict 时可查；skill 目录按 provider 异步发现，restrict 时点的校验看不到尚未应答的 provider。过滤名字作用于目录随后产出的任何内容。

## 测试

`packages/skill/skill` 覆盖限制语义（allow/deny 双向、双向与空过滤与非 scoped 的拒绝、own 层豁免、链上相交、dispose 恢复、collect 缓存失效）。`packages/subagent/subagent` 覆盖 `childSessionMeta` 的 cwd 覆盖与拒绝、descriptor v4 往返加 v3 不支持读加解析拒绝、continuable descriptor 记录与冷恢复重应用。`packages/subagent/subagent-in-process-driver` 覆盖 spawn 路径端到端：header 盖章、父 workspace 回归、相对 cwd 拒绝、经子 scope 视图的双向目录过滤、无注册表时的 fail loud。`out-of-process.spec.ts` 的目录搜索权限失败是长期存在的沙箱环境问题（root 运行），先于本次改动且无关。
