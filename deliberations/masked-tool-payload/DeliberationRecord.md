# DeliberationRecord: 首屏历史页 mask 工具 I/O 的方案评估

- 日期：2026-08-28
- 审议问题：DSH Web GUI 首屏历史页把 tool 输入/输出从 wire 上 mask 掉、只传统计摘要（「已折叠 N 次工具调用 · M 条中间回复 · 时长」），展开时通过专门 API 按需请求完整内容，把首屏传输限制在 user/assistant 文本之内。是否采纳？以何种形态采纳？
- 环境说明：本会话子代理运行时无模型覆盖能力，全部 persona 继承主模型 deepseek-v4-pro，多样性为 persona 级（专长/偏见/张力），非跨模型。已在派活 prompt 声明。

## Persona 清单

| 席位 | 证据来源 | 专长 | 偏见 |
|---|---|---|---|
| 证据研究员 (researcher) | 仓库代码 + 生产 payload 实测 + 外部惯例搜索 | 事实核查与仲裁 | 只出可验证事实，不站队 |
| 协议架构师 (arch) | 仓库代码与 wire 契约 | API/协议设计 | 协议层一次做对，反对带外特殊路径 |
| 产品体验师 (product) | 用户感知与产品惯例 | 交互与感知性能 | 重视折叠可读性与展开顺滑 |
| 一致性守门员 (integrity) | 仓库不变量与失败模式 | 数据完整性与降级 | 对新增读取面保守 |

## 证据基座要点（researcher，[verified]）

- 一页真实历史响应：zstd 解压 6.35MB（wire 962KB），3765 条 wire 条目，展开 ~16.2 万事件。
- 工具输入三重表示 ≈19.9%（tool-call-chunks 11.1% + assistant 内 tool-call part + tool/call args 4.1%）；工具输出 ≈7.3%；真正可见 user/assistant 文本仅 ≈2.3%；sourceEventSeqs 单独占 17.6%；reasoning 双份。
- 现有代码：pageEntries 只做 chunk-row 无损打包，无 mask、无按需展开 API；寻址只有 beforeSeq + maxMessages，无 seq-range。
- 折叠工具调用作为 UI 表现的行业惯例存在，但「wire 层 mask + 展开按需 fetch」无公开先例 [unverified]。

## 立场演变

- 初始立场（预注册）：三席均为「有条件支持」，条件各异（架构：拒绝 mask 摘要与带外 API；产品：UX 质量门槛；一致性：不变量与降级）。
- 讨论后：产品与一致性向架构合流——反对「不可逆 mask 摘要 + 带外专门 API」，改为**无损、可寻址、对称可展开的按需投影**；专门 API 仅作投影读取面，不建第二事实链。

## 方案与投票（均权，不投自己）

| 方案 | 提出者 | 核心 | 得票 |
|---|---|---|---|
| P1 可寻址按需投影 (Lazy Transcript Projection) | arch | 可逆 folded span + 确定性摘要 + 内容哈希；getEventRange seq 窗口展开；降级回退整页 | product 有条件支持；integrity 有条件支持 |
| P2 可读折叠投影 (Foldable Projection) | product | 首屏可见文本 + 确定性折叠元数据（seq 范围/count/类型/失败/耗时/hash）；流式补入；骨架/预取/移动端分批 | arch 有条件支持；integrity 有条件支持 |
| P3 无损范围投影 + 确定性折叠索引 | integrity | 首屏只传 fold 标记与 hash；seqRange 寻址对称解码；失败回退全量读；搜索/缓存同源 | arch 有条件支持；product 有条件支持 |

三案高度收敛，六票全为「有条件支持」，无反对票。

## 事实仲裁（researcher）

- 削减比例：字节基线可信。-40%（P1）算术可行但必须同时治理工具 I/O（27.2%）+ sourceEventSeqs（17.6%）；只 mask 工具 I/O 仅约 -27%。-84%（P3）需叠加 reasoning 与未打包 chunk 等全部非可见内容才勉强可达。
- 「复用现有 range 参数」与代码不符：现有只有 beforeSeq + maxMessages；seq-range 寻址是新契约。
- 全部延迟/大小硬目标（p50/TTI/p95/wire≤120-150KB）无实测基线，属 [无证据]，只能作为待测目标，不能作为验收承诺。
- 小事实：P2 示例 chip「26 次工具调用」与样本不符（实测 tool/call=214）；P1 的 surface 投影与「fold 掉 tool/result」存在重叠（tool/result 本身是 surface 类型）。

## 最终决策

**待用户裁定**。圆桌的合并建议（六票共同收敛，分歧度：低——机制张力（mask vs 投影）在讨论轮已解决）：

1. **采纳方向：无损可寻址折叠投影**（三案合并）：首屏不下发 tool I/O 原文，只传可见文本 + 确定性折叠标记（seqRange/count/类型/失败/耗时/内容哈希），摘要由 BFF 从权威 log 确定性派生、可哈希校验，不建带外缓存。
2. **展开 = 新增 seq-range 读取契约**（明示为新 API，不是复用现有参数），复用 chunk-rows 对称解码，流式补入；失败一律回退现有整页读取。
3. **搜索索引/投影缓存继续消费全量事件源**（同源，不变量保持）。
4. **所有量化目标降级为待实测基线**，先测后承诺。
5. **并行/前置治理**：sourceEventSeqs（17.6%）与工具输入三重表示（19.9% 中的重复部分）——先修这些“重复表示”即可拿回可观收益，且与折叠方案正交。
6. **UX 底线**：折叠 chip 可读（类型/失败/耗时）、骨架屏、首批 ≤300ms、空闲预取、展开状态持久化、移动端分批 + 虚拟化。

## 被放弃方案及理由

- 不可逆 mask + 纯统计摘要（用户原案的字面形态）：放弃——摘要成为第二事实链，展开无法从权威源无损还原，破坏单一事实源与 model-visible⟺logged 的核对能力。
- 带外专门缓存 API：放弃——改为对权威 log 的投影读取面，避免缓存一致性问题。

## 成本

- 14 个 workflow 子代理探针失败（本环境子代理无工具）后改用 Team 机制：1 researcher + 3 persona，共 5 阶段 ~10 轮 teammate turn；crate 产物 12 个文件。模型：全部 deepseek-v4-pro（无跨模型覆盖）。

## Outcome

审议完成，待用户采纳/否决。产物目录：`deliberations/masked-tool-payload/`（已从 Kanon 检索根 /root/docs 移入本 fork 仓库，随 git 管理）。
