# Agent Note: released v0 的 descriptor 版本可达当前 schema

Status: implemented

[English](2026-09-11-released-v0-descriptor-admission.md) | 中文

## Problem

released-v0 边界只接受版本 3 的 `subagent/descriptor` 载荷，而版本 3 是 v0 格式发布时的当前版本。当前安装的 `@deepseek-ai/dsh-subagent` 写入版本 4（`SUBAGENT_DESCRIPTOR_VERSION`），因此只要 v0 Session 里存在以其他版本写下的 descriptor，`@deepseek-ai/dsh-session-format-v0-to-v1` 就会在其所属存储授予写权限之前拒绝它：`persistence.open(id, 'write')` 抛出 `SessionFormatUnsupportedMigrationError`，该 Session 无法迁移，其中的新一轮对话失败。生产库中有 791 个这样的 Session——569 个为 descriptor 版本 4，222 个为版本 2，其中 437 个存有超过 1,000 条事件。版本 2 的载荷携带 mode、provider、label 以及解析后的子代理 provider 与 model，这些成员全都是版本 4 schema 的成员，因此该拒绝并未保护任何已存信息。

## Decision

- `packages/session/session-format-v0-to-v1/src/fork/subagent-descriptor-compat.ts` 持有 released descriptor 的兼容逻辑：`CURRENT_SUBAGENT_DESCRIPTOR_VERSION`、released 成员清单，以及 `upgradeReleasedSubagentDescriptor`。`dispositions.ts`、`migration.ts`、`payload-validation.ts`、`validation.ts` 只保留带 `// Fork patch (FORK_SURFACE.md)` 标记的委托。
- 该常量即 `packages/subagent/subagent/src/descriptor.ts` 导出的 `SUBAGENT_DESCRIPTOR_VERSION` 的值；本边界在此读取它，而不导入该包。每一次 released 格式恢复都会加载本边界，而导入 subagent seam 会把它的产品同级（含 agent、tools、jobs、sandbox、llm）带进历史 Session 的恢复路径。`tests/descriptor-compat.spec.ts` 以相对路径导入拥有该值的定义并断言相等，因此 descriptor 版本一旦提升，该测试即失败，而不会静默漂移。
- released 成员清单在既有可选成员之外接受 `cwd` 与 `skillFilter`，`payload-validation.ts` 对两者都做校验：`cwd` 为非空字符串，`skillFilter` 为 `toolFilter` 已在使用的 `allow`/`deny` 记录形式。因此当前构建写出的载荷可原样通过冻结的成员与载荷规则。
- v0 规范化器把 `CURRENT_SUBAGENT_DESCRIPTOR_VERSION` 盖在携带 released 旧版本、且其成员为当前 schema 按其模式所声明的 descriptor 上。它不添加任何成员：那些世代早于新版本引入的组合输入，因此升级精确保留已声明的组合。one-shot 载荷在其必需成员之外只接受 `label`，携带 continuable 专有成员的 one-shot 载荷会被拒绝。
- 声明了当前 schema 未知成员、版本高于当前版本、或版本低于版本 2 的 descriptor，一律以 `SessionFormatUnsupportedMigrationError` 拒绝——这正是该边界此前对所有非 3 版本抛出的错误。不静默丢弃任何成员，也不虚构任何取值。
- `assertReleasedEventPayload` 接受版本 3 与当前版本；released-v1 边界与之前一样，对其他版本一律原样放行。

## Alternatives considered

**从 `@deepseek-ai/dsh-subagent` 导入 `SUBAGENT_DESCRIPTOR_VERSION`。** 该值将只有一个归属且无需一致性测试，也不会产生导入环。代价是：在一个 released 格式编解码包与 subagent seam 之间引入运行时依赖，且该依赖位于每一个历史 Session 的恢复路径上，另外还需要声明它的包 manifest 与 tsconfig 引用。一致性测试以相同代价换来同样的告警，且不需要这两者。

**继续拒绝该边界未冻结的所有 descriptor。** 拒绝是响亮的，也不在读取侧丢弃任何东西。它同时让所属 Session 永久不可写——存储在授予写权限之前就发布了迁移后的日志——于是 791 个生产 Session 无法接受新一轮对话，这正是本次改动要移除的状态。

**迁移时把载荷版本降盖为 3。** 当前 fold 把版本 3 读作不支持，于是子代理仍不可恢复，而它自己的载荷却声称一个其读取方拒绝的版本；迁移后的日志会自相矛盾。

**升级所有低于当前版本的版本，不论多旧。** 本边界从未见过的世代可能以其他含义使用这些被接受的成员名。版本 2 是 released v0 日志携带的最旧世代（生产库只有版本 2 与 4，没有更低者），其成员的含义与版本 4 相同。

**让 `foldSubagentDescriptor` 读取版本 2 与 3。** descriptor 的版本规则要求组合输入的变化必须是显式的版本变更，而冷恢复通过当前读取器重建组合。磁盘兼容归迁移所有，当前 schema 归 fold 所有。

## Consequences

- released v0 Session 无论持有哪个 released descriptor 版本都能迁移，并重新接受对话轮次。其日志携带当前版本，也就是当前 fold 能够归类的版本。
- 迁移会重写早于当前版本的 descriptor，因此迁移后 Session 的载荷与其写入者存下的字节不同。已存版本号本就不该从迁移后的日志中读回；所属 Session 此时已迁至当前格式。
- 一个 fork 自有模块与四处带标记的委托位于一个上游所有的包中。descriptor 版本再次提升时，只需在该模块中移动常量与成员清单，而一致性测试会最先失败。
- released-v1 边界现在会校验当前 descriptor 版本的成员，而此前它会跳过所有版本 3 之外的载荷。v1 Session 中版本 4 的载荷若声明了未声明成员，现在会被拒绝而不再原样放过；当前构建写出的合规载荷与之前一样通过校验。

## Testing

`packages/session/session-format-v0-to-v1/tests/descriptor-compat.spec.ts` 迁移携带 `cwd` 与 `skillFilter` 的版本 4 载荷，升级生产库持有的版本 2 载荷与版本 3 的 one-shot 载荷，把每个迁移后的载荷交给 `foldSubagentDescriptor` 折叠，并逐一断言各拒绝情形（未声明成员、更高版本、低于 released 下限的版本）的错误类型与消息。`packages/session/session-persistence-sqlite/tests/sqlite.spec.ts` 以写模式打开一个子代理 descriptor 为版本 4 的 v0 夹具并读回发布后的 Session——这正是本次改动移除的生产症状，改动前该测试复现为 `subagent/descriptor 2 uses unsupported descriptor version 4`。录制通道的输出在改动前后完全一致（本 fork 上均为 99 failed / 16 passed / 2 skipped）；其余失败来自被禁用的沙箱组合，而非 descriptor 处理。

## Related

[in-process 子代理的 per-child cwd 与 skill 过滤](../feature/2026-08-29-subagent-child-cwd-skillfilter.zh.md) 拥有版本 4 descriptor、其 `cwd` 与 `skillFilter` 成员，以及本次迁移兼容所跟随的版本 3 → 4 提升。
