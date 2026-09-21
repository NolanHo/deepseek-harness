# Agent Note: catalog listing 的冷读有了上限

Status: implemented

[English](2026-09-21-subagent-listing-cold-read-bound.md) | 中文

> 范围：`SubagentRuntime` 为何暴露 `coldReadConcurrency` 与 `coldReadBudget`、单次 listing 的预算花在什么上、超预算的子会话报什么，以及预算为何计会话读取而不计冷候选。

## 问题

在一个有 422 个子会话、且投影缓存为冷的 workspace 上打开 Web 客户端，会让 Host 完全不可用。`subagents.list` 为解析每个非 live 子会话的身份，都要读取并解码该子会话的完整存储会话日志（`loadStoredLog`）——每个子会话一次整日志 zstd 解码——而首次 GUI 加载每一遍要跑 423 次这样的解码，共 4–5 遍。在与生产同构的隔离实例上，这会把单核钉在 100% 约 8 分钟；共享同一事件循环的所有 RPC 与流全程挂起，客户端超时并反复重连。

缓存热时同一次 listing 的会话读取为零，因此这是尾部风险而非日常成本：只要缓存答不出来它就会回来——新的 `DSH_HOME`、某个投影单元 `stateVersion` 变化、rewrite 的 `discard`，或 storages 丢失。上游只用硬编码的 `COLD_READ_CONCURRENCY = 4` 限制同时进行的冷读数量；单次 listing 发起多少读取没有任何上界，也没有任何部署设置。

## 决策

**两个经校验的 `Config` 字段限制单次 listing。** `coldReadConcurrency`（`z.natural().min(1).default(4)`）限制在飞冷读数，`coldReadBudget`（`z.natural().min(1).default(64)`）限制单次 listing 发起的读取数。`SubagentRuntime` 在构造时把两者一次性解析为 `listingLimits`，传给 `listChildren` 与 `listDescendants`，两个方法再转发给 `src/list-children.ts` 中的共享 listing 核心。两个默认值都复现某一可服务状态：`4` 是移植过来的硬编码常量，`64` 让该规模的 workspace 在单次 listing 内解析完。

**预算计的是会话读取，绝不是候选。** 能由投影缓存回答的候选在选择之前就已解析成行（`cachedColdIdentity`），因此既不花预算也不占并发槽。仍需读取的候选按 corpus 顺序取用（`selectColdReads`），由 `coldReadConcurrency` 个工作单元排空（`observeColdIdentity`）。

**被延后的候选复用 listing 既有的词汇。** 超出预算的每个候选在其 corpus 位置上产出可重试的 `{kind:'diagnostic',reason:'unavailable'}` 行——与「观察缺失或短暂失败」此前产出的完全一致。不新增 wire 取值、错误码或排序规则：客户端既有的 `unavailable` 处理直接适用，后续 listing 会接上该候选。因终局原因失败的读取仍照旧报 `corrupt`；取消语义不变，`signal` 仍在每次持久化读取周围被观察。

**推进在构造上就是单调的。** 由于被缓存服务的候选从不进入读取队列，重复 listing 会把预算花在尚未解析的子会话上，而不是同一个队首。listing 之后新建的子会话出现在下一次 listing 中，且只有当它前面的子会话仍需读取时才会被延后——绝不会永久排在缓存已服务的行之后。

**没有「无上限」设置。** 两个字段都按 `min(1)` 校验；必须在更少 listing 内解析超大冷 workspace 的部署应调高 `coldReadBudget`，而不是关掉上界。无上限的 listing 正是被复现的缺陷。

## 备选方案

**在缓存档之前、按冷候选计预算。** 字面理解的预算——「每次 listing 的前 N 个冷候选」——每次都会花在同一个队首上：这些候选一旦被缓存服务，仍会继续消耗预算，于是队尾永远读不到，而排在缓存已服务队首之后新建的子会话会永久 `unavailable`。先把缓存档解析掉，才让上界能够推进。

**改为调高并发常量。** 成本是「子会话数 × 日志长度」：对 423 个子会话并发做 4 份整日志解码，在任何并发度下都是同样的八分钟工作量。并发限制的是单次 listing 能索取的峰值，而不是总量；裸常量也不是部署设置（[规则](../../../../AGENTS.md#conventions)）。

**按耗时或字节数设界。** 两个量在一次读取开始前都不可知：存储日志的大小随读取一起到来，而墙钟预算会让 listing 的产出取决于主机速度与负载。读取次数在每次读取开始前即可核对，因此单次 listing 的最坏情况可以事先算清。

**为被延后的子会话报一个专门的诊断。** 新的 reason 必须对每个客户端与 wire contract 都有意义，而「尚未读取」恰恰就是既有可重试 `unavailable` 已经表达的含义。客户端无需区分「被延后的读取」与「失败的读取」。

**把 listing 做成流式——先返回 live 与缓存行，冷行边解析边发。** 那会改动 listing 的 wire contract，并需要客户端处理排序与重新 listing；契约本就携带的逐候选诊断已足以承载这个上界。

**不动冷路径，依靠 `asyncCodec`。** 兄弟开关把 zstd 解压移到 libuv 池上，但读取照旧发生、次数不变，观察与投影折叠仍在事件循环上执行；上界与「解码在哪里跑」是正交的（[异步编解码记录](../feature/2026-09-20-async-session-codec.zh.md)）。

## 影响

冷 workspace 现在分 ⌈子会话数/64⌉ 次 listing 解析完，而不是一次；期间被延后的子会话渲染的是客户端本就会重试的那条诊断行。换来的是一次 listing 再也无法把事件循环占住数分钟：其峰值工作量是 64 次读取、最多 4 个在飞。预算之内的 workspace 行为与改动前完全一致——被缓存服务的候选根本不进读取队列，而并发默认值就是移植过来的常量。两个上界都是部署可调项，因此服务更大的 workspace 是配置决定而非改代码。

代价：`src/list-children.ts` 现在承载 fork 自有的上界——贯穿 `prepareListing` 的 limits 参数、抽成 `cachedColdIdentity` 的投影缓存档，以及 `selectColdReads`——上游同步时必须重新施加；`src/index.ts` 承载 `Config`、解析后的 `listingLimits` 与两个调用点。[FORK_SURFACE.md](../../../../FORK_SURFACE.md) 中的行登记了这些位置。

## 测试

`packages/subagent/subagent/tests/list-children.spec.ts` 新增 `SubagentRuntime cold-read bounds` 块：它把 runtime 挂载在一份经 mock 的 `sessionQuery` 提供的合成冷 corpus 上（不涉及任何持久化后端与 Agent runtime），并统计每一次观察：

- 随产品交付的默认值（`4`、`64`）、小于 1 的上界在 schema 与挂载两处都被拒，以及直接构造插件时套用同样的默认值（六个候选下峰值为 4）；
- 5 个候选、预算 2 时恰好读取前两个，其余三个按 corpus 顺序报 `unavailable`；
- 能装进默认预算的 corpus 会被全部解析；
- `coldReadConcurrency: 2` 加六个候选时，把两个已准入的读取挂起即可证明第三个不会开始，随后六个全部解析；
- 缓存服务了已读取的两个子会话之后，下一次 listing 把预算花在剩余两个上并解析完整个 corpus——观察顺序证明了这次推进。

`npx vitest run packages/subagent/subagent/tests/list-children.spec.ts` 该文件全部 69 个用例通过，新增块在其中。生产规模的那次复现（422 个子会话、约 8 分钟单核满载）是在改动前于与生产同构的隔离实例上测得，本次未重跑：上界的效果是在 listing 单元层面被证明的——读取次数与并发峰值——而不是靠墙钟冷加载测量；也没有浏览器测试渲染超预算行，因为该路径就是既有的 `unavailable` 诊断，其客户端处理未变。

## 相关

- 包 README 承载面向运维的字段表与启动行为：[subagent](../../../../packages/subagent/subagent/README.zh.md)
- 子系统页承载 listing 在委派面中的位置：[subagent](../../../../docs/subsystems/subagent.zh.md)
- 该差异面登记所在的 fork 清单行：[FORK_SURFACE.md](../../../../FORK_SURFACE.md)
- 本上界限制 listing 多久支付一次的解码成本：[异步编解码记录](../feature/2026-09-20-async-session-codec.zh.md)
