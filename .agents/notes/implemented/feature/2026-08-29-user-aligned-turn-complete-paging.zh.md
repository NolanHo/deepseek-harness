# Agent Note: 两条读取路径统一为按用户消息对齐、按回合完整的分页

Status: implemented

[English](2026-08-29-user-aligned-turn-complete-paging.md) | 中文

> fork 相对上游消息索引分页的本地化差异，把 fork 的 messageCut 快路径扩展到它回退的观察路径。

## 问题

历史分页运行在两条边界规则不同的逻辑路径上。索引快路径（messageCut + 后缀读取）按第 N 条用户消息切页，而观察回退路径按第 N 条任意消息切页——同一游标因服务路径不同而得到不同边界。页面切在回合中间，页头回合缺少 turn/start 到达客户端后先展开渲染，下一页补全后折叠才生效：每次 Load earlier 都产生可见的重排（闪动）。另外，compaction 替换的组头横跨整个被压缩范围，快路径的 128 事件前导无法覆盖其完整性检查，压缩相邻的每一页都回退到全量观察读取。

## 变更

- 一个边界游走（`packages/api/session-controller/src/history.ts` 的 `nthMessageCut`）同时服务 `paginate`（观察）与 `paginateSuffix`（索引）：用户消息锚定页面（无用户消息的合成日志回退为任意消息），选中消息通过 `sourceEventSeqs` 展宽切点，且只在第 N 条消息处固定切点（不足一页时保持整窗）。稠密观察游走按数组前缀索引，不再切片。
- 每个切点回退到所属回合的起始事件（`turnAlignedCut`，停在上一个 `turn/end`），页面从完整回合边界开始，客户端的 Turn Process 折叠从页面首次渲染起就稳定。
- 索引快路径在浅层 128 事件前导无法容纳（被压缩展宽的）切点时，先以 4096 事件深层边距重试一次后缀读取，再回退观察路径。

## 验证

`packages/api/session-controller` 套件全绿（414 测试，含新增深层重试测试）；chat-scroll-contract 与 seeded-history 回放 lane 全绿（除两个长期存在的沙箱环境失败）；分页测试的边界期望更新为用户对齐、回合完整语义。
