# Agent Note: Restored children keep their descriptor identity

Status: implemented

[English](2026-09-23-restored-child-descriptor-identity.md) | 中文

> 范围：`subagent` identity 投影如何读取被恢复子会话日志所携带的 descriptor 世代，以及 resume 折叠为何刻意保持严格。[subagent](../../../../packages/subagent/subagent/README.zh.md) README 拥有该包的 descriptor 与投影契约。

## Problem

打开一个被迁移的历史子代理会话时得到 `RemoteError: subagent descriptor is corrupt`（`packages/api/session-controller/src/history.ts` 的 `validateAddress`，错误码 `subagent/catalog-diagnostic`），尽管父会话自己的目录已列出该子会话、`listChildren` 也连同模式与标签一起返回了它。`dsh-v0.1.7-rc.1` 合并后，`apps/web/tests/preset-migration.snapshot.ts` 的两个用例都在该调用上失败，这是那次同步剩下的最后一个 fork 适配缺口。

根因是本 fork 自己的 descriptor 世代。本 fork 为 per-child `cwd` 与 `skillFilter` 组装输入，给每个新 `subagent/descriptor` 打上版本 4（FORK_SURFACE 的 `subagent` per-child cwd + skillFilter 行）；而从磁盘恢复的 released 日志保留它写入时的世代——复现夹具里是版本 3。released-v3 目录边界早已为父会话成员关系解释 1 至 4 世代，因此父会话列出了该子会话。子会话自身的 `subagent` identity 投影则没有：`foldSubagentDescriptor` 只对安装版本返回 descriptor，而投影折叠绝不能抛错，于是不可读的世代折成那个交付 `null` 哨兵的状态——`validateAddress` 将其报告为损坏的 descriptor。对失败路径插桩后可见，子会话自身事件 `{"version":3,"provider":"spawn","mode":"one-shot","label":"historical child"}` 在 `inheritedEventCount` 为 0 时折成 `subagent: null`。

## Decision

`subagent` identity 投影会读取 released descriptor 世代：`packages/subagent/subagent/src/fork/released-descriptor-identity.ts`（`foldReleasedDescriptorIdentity`），经 `projection.ts` identity 折叠中的一处标记委托接入。该模块接受 `version` 为安全整数、低于安装版本且不低于 2 的载荷，把副本盖上安装版本，再交给 `foldSubagentDescriptor` 折叠——因此 identity 出自严格折叠所用的同一套 schema，未声明成员或损坏的 identity 字段建立不了任何东西，版本 1（没有 `mode` 字段）依旧不可读。`subagent` projection 的 `stateVersion` 从 2 提到 3，使已经缓存为 `null` 哨兵的行重新折叠而不是躲过这次改动。

两条边界是刻意的。`foldSubagentDescriptor` 继续拒绝 released 世代，因为 resume 组装需要版本 4 新增的输入，而 released 载荷提供不了：被恢复的 continuable 子会话可以打开、列出、转向，冷 resume 仍报 unsupported。且不重写任何已存载荷：上游「被迁移子会话的主体在 V3→V4 中原样保留」的契约——其自有 `preset-migration` 规格所断言者——保持完整。

## Alternatives considered

**像 released-v0 边界用 `upgradeReleasedSubagentDescriptor` 那样，在 V3→V4 迁移边界给 released descriptor 盖上安装版本。** 那会让已存的子会话日志字面上就是安装世代的日志，identity 与 resume 都能工作，而且它正是 fork 在另一条边界上已登记的约定。它落选，因为它为补偿这条接缝去改写属于另一条接缝的载荷，也因为它与一条 fork 从未偏离的上游期望冲突：迁移原样保留子会话事件，夹具自己的后继主体被逐字段断言。

**放宽 `foldSubagentDescriptor` 使其接受 released 世代。** 所有读取方共用一次折叠，不需要第二条规则。它落选，因为 resume 组装会据此重建出一个早于 `cwd` 与 `skillFilter` 的载荷，静默以该 descriptor 从未声明过的组装恢复子会话——正是 descriptor 版本存在所要阻止的结果。

**改从父会话的 `subagent/catalog` 事实读取 identity。** 该事实已带模式与标签，fork 的 SQLite 与 JSONL 恢复路径正是为此构建它。它落选，因为地址栅栏的证据必须是子会话自己的声明：目录是父会话对子会话的主张，而地址授权的是向子会话投递，不是投向父会话对它的记忆。

**保持 released 世代为不支持、保留现有诊断。** 那是对单一日志诚实的读法，且无需代码。它落选，因为本部署自己的恢复早已解释同一载荷以列出该子会话，于是 `listChildren` 承诺了一个可打开的子会话，而应用随后拒绝它——同一事实的两个读取方互相矛盾。

## Consequences

自身 descriptor 携带世代 2 或 3 的被恢复子会话，现在交付与原生子会话相同的 identity：地址栅栏接受它，`listChildren` 的实时 identity 路径与它的目录事实一致，queue 操作看到目录早已报告的模式。改动的只有 identity：resume 折叠、descriptor schema、descriptor 版本与每一个已存字节都未动，等于或高于安装版本的世代、低于 2 的版本、以及安装 schema 拒绝的载荷，全都仍然折不出 identity。投影缓存版本提升会一次性丢弃缓存的 identity 行，因此本次改动后的首次观测会从持久日志重新折叠。

## Related

[in-process 子代理的 per-child cwd 与 skill 过滤](../feature/2026-08-29-subagent-child-cwd-skillfilter.zh.md) 拥有版本 4 descriptor 以及本次兼容所绕开的 per-child `cwd`、`skillFilter` 成员。[Released v0 descriptor 版本抵达安装 schema](2026-09-11-released-v0-descriptor-admission.zh.md) 拥有 released-v0 边界在迁移时对这些载荷所做的自有升级，[保留子目录证据不完整的 V3 会话](2026-09-19-v3-incomplete-child-catalog-evidence.zh.md) 拥有父会话目录为同一子会话记录的内容。

## Testing

`packages/subagent/subagent/tests/released-descriptor-identity.spec.ts` 覆盖 released 的一次性与 continuable identity、安装世代、版本 1、比安装版本更新的世代、携带未声明成员或非法模式的 released 载荷、非 descriptor 事件、非数值版本，以及严格折叠仍然拒绝 released 世代用于 resume。`packages/api/session-controller/tests/session-cold.host.spec.ts` 增加应用级用例：自身 descriptor 携带世代 3 的冷子会话经 `SessionHistoryController.page({ address: subagent })` 成功分页。把该委托注释掉时两者都是红的——单元用例红在投影值，冷子会话用例红在 `RemoteError: subagent descriptor is corrupt`——打开后转绿；`apps/web/tests/preset-migration.snapshot.ts` 通过。
