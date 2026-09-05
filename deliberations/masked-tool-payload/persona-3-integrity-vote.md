# persona-3 一致性守门员 · 投票

## 对 P1（可寻址按需投影）
**投票：有条件支持**
理由：单一事实源、可逆 fold、hash 校验、降级回退均与我方不变量一致；但 canonical 哈希、getEventRange/fromSeq-toSeq 寻址、搜索索引同源、延迟基线均被仲裁标为 [无证据]/[unverified]，属严重负面信号，须先落地验证再承诺。

## 对 P2（可读折叠投影）
**投票：有条件支持**
理由：总则已服从单一事实源、降级体验完整、计数派生正确；但其 wire ≤120KB 为 [unverified]、TTI/延迟全为 [无证据]，只能作待测目标，且必须绑定 seq-range 无损解码 + hash 校验，不能只按 UX 独立实施。

## 合并建议（≤100 字）
必留：单一事实源、无损可逆 fold(seqRange+count+hash)、搜索/缓存同源、降级回退 pageEntries、确定性计数。可弃：-84%/≤120KB 与延迟具体值（改实测后校准）、P2 示例数字；sourceEventSeqs 治理独立前置。

LEAD-SUMMARY: 方案1:有条件支持；方案2:有条件支持。
