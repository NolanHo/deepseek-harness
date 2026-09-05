# persona-1-arch-vote.md

## 对 P2（可读折叠投影）：有条件支持

理由：投影语义、单一事实源、确定性计数、降级回退与 P1 一致，摘要可读/分批预取/骨架是必要非功能项，应采纳；但其 wire≤120KB（962KB 的 1/8）与 TTI≤1.0s 均无压缩层/延迟基线，[无证据] 作为严重负面信号，须改「先测基线再定标」。

## 对 P3（无损范围投影+确定性折叠索引）：有条件支持

理由：一致性与降级最强，model-visible⟺logged、索引/缓存同源、hash 校验必须采纳；但「复用现有 pageEntries/detachedHistoryRead 的 range 参数」与代码不符（现仅 beforeSeq+maxMessages，无 fromSeq/toSeq），且 -84%/≤150KB 无实现证据，[无证据] 属严重负面信号——须明示 getEventRange 为新契约而非既有参数。

## 合并建议（≤100 字）

必须保留：单一事实源、无损可逆投影、确定性计数+哈希、seq 窗口对称解码、降级回退、搜索/缓存同源、先修 sourceEventSeqs。可放弃：P2/P3 无证据量化数值与「复用现有 range」表述；改新增 getEventRange 契约并实测定标。

LEAD-SUMMARY: 方案P2:有条件支持；方案P3:有条件支持。合并须保留无损投影+哈希+降级+同源，弃无证据量化与「复用现有range」。
