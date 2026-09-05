# persona-3 一致性守门员 · 提案

## 方案：无损范围投影 + 确定性折叠索引（Range-Projected Transcript）

### 1. 无损可重构的 wire 表示
不 mask、不摘要替代事实。`pageEntries` 对 tool 密集 run 首屏只下发：既有 `packed chunk row`（流式 delta 已对称无损）+ 一个 `fold` 标记，内含 `seqRange`、`runId`、`count/byteLen/hash`（hash=对规范序列化的 SHA-256）。标量 `tool/call`、`tool/code-dispatch`、`tool/result` 的原文首屏不内联；展开时用 `seqRange` 走现有 `pageEntries`/`detachedHistoryRead` 的 range 参数 + `decodeStorageRecord`/`expandRow` 对称解码取回，复用 seq/cursor 寻址，不新建第二事实链、不建旁路缓存。

### 2. 计数可校验
计数由唯一的投影函数从权威事件派生（与渲染摘要同源），并附 `byteLen` 与内容 `hash`。客户端展开后重算计数与 hash 对比：不一致即告警并触发降级。禁止手写/另存统计。

### 3. 与既有不变量衔接
- **model-visible⟺logged**：完整 tool I/O 始终在 session log；fold 只省略 wire 上的 UI 副本，模型可见内容不变，展开返回精确日志字节。
- **搜索索引/投影缓存**：索引与缓存继续消费全量事件源，不读折叠视图；新增门禁测试断言二者 source == session log 事件。
- **single fact chain**：fold 是只读路径优化，摘要与原文同源自同一次投影。

### 4. 失败与降级路径
range 请求超时/失败或 hash 不匹配：① 重试 range；② 失败则渐进回退为现有全量 `pageEntries` 读取，骨架屏 + 进度反馈、保留滚动位置，绝不白屏或整页重算。

### 5. 首屏延迟目标（以 B 节单页样本为基线）
解压 6.35MB→首屏 ≤1.0MB（约 -84%）；wire ≤150KB（基线 962KB）；首屏摘要可交互 <150ms；展开 p95 <300ms、单次增量 ≤20KB，配合预取相邻 run 掩盖往返。

## 优点
- 单一事实源与 model-visible⟺logged、索引/缓存不变量全保留，无损可验证；
- 复用既有 seq/cursor 与 chunk-row 对称解码，改动面小；
- 降级路径明确，失败不丢数据。

## 缺点
- 展开仍有一次网络往返（需骨架/预取补偿）；
- 需维护确定性计数+hash 的一致性测试，分页/缺页/乱序边界复杂度上升；
- 应先修 sourceEventSeqs 与 reasoning/tool-call 多重表示（更便宜的第一刀），本方案作为第二刀。

LEAD-SUMMARY: 无损范围投影+确定性折叠索引：首屏只传折叠标记与 hash，展开按 seqRange 走现有寻址对称解码，失败回退全量读。
