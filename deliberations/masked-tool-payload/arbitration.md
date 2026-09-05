# arbitration.md — 事实仲裁（只标注，不否决）

对照基准：research.md（代码 file:line + /tmp/tail.bin 实测）。标注三档：[verified]（有代码/实测证据）、[unverified]（与代码/实测不符或无法证实）、[无证据]（本次范围外/纯设计待验证）。

统一口径（供仲裁引用，均 [verified]）：
- 样本单页：zstd 解压 6,354,058 B（6.35MB）；压缩 wire 962,483 B（962KB）；3,765 wire 条目，展开约 161,955 事件。
- 字节构成：工具输入三重表示 ≈1,262,754 B（19.9%）；工具输出 ≈465,172 B（7.3%）；工具 I/O 内容合计 ≈27.2%；sourceEventSeqs = 1,120,054 B（17.6%）；reasoning-chunks 709,763（11.17%）+ assistant 内 reasoning part 291,964（4.6%）；未打包 assistant/chunk 856,148（13.47%）；可见 text（user + assistant text part）≈144,298（2.3%）。
- 代码：pageEntries（api-proxy.ts:803-810）现为整条原始日志透传 + packChunkRuns（chunk-rows.ts:197-226），无 mask/fold；expandEntries/decodeStorageRecord/expandRow 存在且可复用（session.ts:800-814；chunk-rows.ts:298-350）；历史读入口 detachedHistoryRead 参数为 `(sessionId, beforeSeq, maxMessages)`（api-proxy.ts:1649-1707），**无 fromSeq/toSeq range 参数**。

---

## P1（arch）逐条

1. 「不改 session log 事实源、fold 只发生在读取投影层」——与现状一致（log 为 append-only 事实源，pageEntries 本就是读投影）。[verified]
2. 「替换连续 tool 事件区间含 tool/call、tool/code-dispatch、tool/result、对应 chunk-delta」——这些事件类型均存在于实测样本。 [verified]
3. 摘要字段（调用次数/结果数/中间回复数/错误标记/耗时）可由权威事件确定性派生（tool/call.name、tool/result.isError、事件 time 字段均在）。[verified]
4. 「sha256(canonicalSpan) 内容哈希」「canonical 序列化随 SESSION_FORMAT_VERSION 固定」——新机制，现无对应代码；SESSION_FORMAT_VERSION 存在（仓库文档）但「随其固定 canonical 规则」是设计。[无证据]
5. 「getEventRange({fromSeq,toSeq}) 返回同一 wire 形态、客户端复用 expandEntries 对称解码」——expandEntries/decodeStorageRecord/expandRow 可复用 [verified]；但 getEventRange 端点不存在 [unverified]。
6. 「chunk-rows 保持无损、fold 在其后计算」——chunk-rows 无损 [verified]；fold 时序为设计。[无证据]
7. 「首屏仅投影 surface 类型 + folded span」——surface 类型含 tool/result（surface.ts:15-19），与「fold 掉 tool/result」需在投影阶段再界定，存在轻微内部重叠。[verified 事实 + 需注意]
8. 「folded span 用 fromSeq/toSeq 寻址、不影响 cursor 分页」——cursor/beforeSeq 分页存在 [verified]；fromSeq/toSeq 寻址是新能力 [unverified]。
9. 「搜索索引始终消费权威 log」——本次只读范围未核实搜索索引实现。[无证据]
10. 量化「解压降 ≥40%，6.35MB→≤3.8MB，工具 I/O 及重复表示约 27%+，另含 sourceEventSeqs 17.6% 可并入治理」：
    - 基线 6.35MB、工具 I/O 27.2%、sourceEventSeqs 17.6% 三数均 [verified]。
    - ≥40% 可行性：[verified 仅当同时治理 sourceEventSeqs]（27.2%+17.6%=44.8%）；仅治理工具 I/O 只能约 -27%（→约 4.6MB），达不到 3.8MB。
11. 首帧 p50≤1.2s、展开 p95≤300ms——延迟无实测基线（提案自标「待测」）。[无证据]

## P2（product）逐条

1. 「首屏 = user/assistant 可见 text + fold 元数据；tool I/O 与 reasoning 主体不进首屏」——与字节构成一致（可见 text 仅 2.3%，移除 tool I/O+reasoning 后剩余很小）。[verified 与实测一致]
2. 摘要字段（seq 范围/count/类型/失败标记/耗时/字节数/哈希）——失败标记、字节数、耗时均可由事件派生。[verified 可派生]
3. 示例 chip「已折叠 26 次工具调用 · 3 次失败 · 20 条中间回复 · 13分25秒」——样本实际 tool/call=214 次、assistant/message=229 条，具体数字是示意非实测，不构成对该样本的量化。[verified 注：样本数字不匹配，仅示意]
4. 「计数由权威事件确定性派生，非估算」——与代码事实一致（事件含全量字段）。[verified]
5. 「首批约 200 条或 200KB ≤300ms、全组流式 ≤2s、TTI ≤1.0s」——无延迟/带宽基线。[无证据]
6. 「降级回退现有 pageEntries 完整分页读取」——pageEntries 存在 [verified]；降级行为为新设计 [无证据]。
7. 量化「wire ≤120KB（约样本 962KB 的 1/8）」：
    - 962KB 基线、962/8=120.25 算术均 [verified]。
    - ≤120KB 可达成性：[unverified]——research 只测了解压后字节构成，未测压缩后 wire 的字段级占比；移除解压内容与压缩后字节非等比例，1/8 无推导依据。

## P3（integrity）逐条

1. 「首屏只下发既有 packed chunk row + fold 标记（seqRange/runId/count/byteLen/hash）」——packed chunk row 为现有机制 [verified]；count/byteLen/hash 为新增 [无证据]。
2. 「标量 tool/call、tool/code-dispatch、tool/result 原文首屏不内联」——现状是 pageEntries 原样内联 [verified 现状]；「不内联」是方案改变现状，非现状描述。
3. 「展开用 seqRange 走现有 pageEntries/detachedHistoryRead 的 range 参数 + decodeStorageRecord/expandRow 对称解码、复用 seq/cursor 寻址」：
    - decodeStorageRecord/expandRow/expandEntries 存在且对称可复用 [verified]。
    - 「pageEntries/detachedHistoryRead 的 range 参数」：[unverified，与代码不符]——detachedHistoryRead 只有 `beforeSeq`（排他上界）+ `maxMessages`，pageEntries 只吃已切片 page，均无 fromSeq/toSeq range 参数；seqRange 寻址是新能力。
    - cursor/beforeSeq 寻址存在 [verified]。
4. 「model-visible⟺logged：完整 tool I/O 始终在 log，fold 只省略 wire UI 副本」——与仓库不变量及 surface/chunk-rows 事实一致。[verified 一致]
5. 「搜索索引/投影缓存继续消费全量事件源、不读折叠视图」——投影缓存存在（api-proxy.ts:1662-1664）[verified]；搜索索引实现本次未核实 [无证据]。
6. 降级「hash 不匹配/超时 → 回退全量 pageEntries」——pageEntries 存在 [verified]；降级行为 [无证据]。
7. 量化「解压 6.35MB→首屏 ≤1.0MB（约 -84%）；wire ≤150KB（基线 962KB）」：
    - 6.35MB、962KB 基线及 -84%→1.0MB 算术 [verified]。
    - ≤1.0MB 可达成性：[unverified，激进]——需移除几乎全部非可见内容（工具 I/O 27.2% + sourceEventSeqs 17.6% + reasoning 15.8% + 未打包 chunk 13.5% 等才凑近 84%）；wire ≤150KB 同 P2，无压缩层证据。

## 专项核对结论

1. **payload 削减比例可行性**：-40% 算术可行但**必须同时治理 sourceEventSeqs**（仅工具 I/O 只有 -27%）；-84%（P3）需再叠加 reasoning 与未打包 chunk 等全部非可见内容，算术上勉强可达但无实现路径证据。[verified 算术 / unverified 实现]
2. **「复用现有寻址与对称解码」与代码是否一致**：对称解码一致（expandEntries/decodeStorageRecord/expandRow 现成）；「复用现有 range 参数」**与代码不一致**——现只有 beforeSeq 上界 + maxMessages，无 fromSeq/toSeq range。[verified 解码 / unverified 寻址]
3. **量化目标基线依据**：字节基线有实测依据（6.35MB/962KB）；**所有延迟目标（p50/TTI/p95/首条/流式）均无实测基线**，且三份提案自己标注「待测/校准」。[verified 字节基线 / 无证据 延迟基线]
