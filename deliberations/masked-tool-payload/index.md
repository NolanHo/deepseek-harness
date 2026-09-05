# Crate: masked-tool-payload roundtable

审议主题：DSH Web GUI 首屏历史页把 tool 输入/输出从 wire 上 mask 掉、只传统计摘要，展开时按需请求完整内容。

## Manifest

- DeliberationRecord.md — 最终审议记录（persona/方案/投票/决策/放弃理由/成本/分歧度）
- research.md — 证据基座（代码事实 + payload 字节构成实测 + 外部惯例）
- arbitration.md — 事实仲裁（逐方案标注 verified/unverified/无证据）
- persona-1-arch-{stance,discussion,proposal,vote}.md — 协议架构师产出
- persona-2-product-{stance,discussion,proposal,vote}.md — 产品体验师产出
- persona-3-integrity-{stance,discussion,proposal,vote}.md — 一致性守门员产出
- log.md — 阶段时间线（volatile）

结论一句话：六票全「有条件支持」，合并收敛为「无损可寻址折叠投影」——首屏只传可见文本 + 确定性折叠标记（seqRange/count/失败/耗时/哈希），展开走新增 seq-range 读取契约对称解码，失败回退整页读取；所有量化目标先测基线再承诺；sourceEventSeqs 与工具输入多重表示的前置治理与之正交且收益可观。
