# persona-1-arch-proposal.md

## 方案标题：可寻址按需投影（Lazy Transcript Projection）

核心：首屏 wire 上把 tool 密集区间**投影**为「折叠 span + 确定性摘要」，展开时用同一事件寻址窗口无损还原——不改 session log 事实源，不建带外缓存。

## 一、wire 形态

`pageEntries` 新增记录类型 `{kind:"folded", fromSeq, toSeq, summary}`，替换连续 tool 事件区间（含 tool/call、tool/code-dispatch、tool/result、对应 chunk-delta）。session log 原样保留；fold 只发生在读取投影层，是可逆表示，不是 mask。

## 二、摘要计算与校验

- 由 BFF/api-proxy 在 fold 时从权威 log 事件**确定性派生**：工具调用次数、结果数、中间回复数、错误标记、耗时（首/末事件 ts 差）。
- 附 `sha256(canonicalSpan)` 内容哈希；展开后客户端重算比对，失败即提示「内容已变，重载」。
- canonical 序列化规则随 `SESSION_FORMAT_VERSION` 固定，snapshot 覆盖确定性。

## 三、展开读取面

`getEventRange({sessionId, fromSeq, toSeq})`：返回 [fromSeq,toSeq] 的**同一 wire 形态**（走 `packChunkRuns` 打包 + 原始事件），客户端复用 `expandEntries` 对称解码。契约：按 seq 有序、含端点、幂等、越界返回空/404；每次一个 span，支持批量合并。

## 四、衔接

- **chunk-rows**：保持无损行打包不变；fold 在其后计算，展开输出再过一遍 packChunkRuns。
- **surface**：首屏仅投影 surface 类型 + folded span；展开返回该区间全类型。
- **分页寻址**：folded span 用 fromSeq/toSeq 稳定寻址，不影响 cursor 分页与现有事件序。
- **搜索索引**：索引始终消费权威 log，不消费投影 wire；加测试证明折叠的 tool I/O 仍可全文命中。
- **投影缓存**：缓存键=session log 投影+SCHEMA_VERSION，log 追加/compaction 即失效；缓存只是读视图，禁止成为第二事实库。

## 五、降级路径

展开失败/超时 → 客户端回退走现有 `pageEntries` 整页读取并给进度反馈，span 仍显示摘要与「重试/加载全文」，不白屏、不重算整页。

## 六、首屏量化目标（需基线实测定版）

- 解压后首屏 payload 降 ≥40%（样本 6.35MB→≤3.8MB，工具 I/O 及重复表示合计约 27%+，另含 sourceEventSeqs 17.6% 可并入治理）。
- 首帧渲染冷开 p50≤1.2s（现状待测基线）；展开单 span p95≤300ms+骨架屏；降级不劣于现状。

## 优缺点

**优点**：单一事实源不变、可逆对称、哈希可校验、搜索/缓存同源、复用寻址与解码、降级安全。
**缺点**：服务端 fold+摘要+哈希新增 CPU 与 canonical 序列化复杂度；新增投影读取面有版本与一致性成本；展开仍有 RTT。

LEAD-SUMMARY: 可寻址按需投影：wire 用折叠 span+哈希摘要投影，展开按 seq 窗口无损还原，搜索/缓存同源、带降级。
