# masked-tool-payload — 证据研究（仅事实，不站队、不提方案）

- 研究者 persona：证据研究员
- 方法：只读仓库代码（行号引用）；对 /tmp/tail.bin 做实测反序列化统计；web_search 查行业惯例
- 约束：全程未修改仓库任何文件

## A. 代码事实（[verified]，均有 file:line）

1. 历史页 wire 编码入口是 `pageEntries`（api-proxy.ts:803-810）：对分页后的原始事件切片调用 `packChunkRuns(page)`，然后每条记录要么变成 `{packed: <ChunkRow>}`，要么变成 `{event: <原始事件>, view?}`。**除了 chunk-row 打包，所有事件原样透传**，`tool/call`、`tool/result` 的完整输入/输出不做任何 mask。[verified]
2. `packChunkRuns`（chunk-rows.ts:197-226）只打包 `assistant/chunk` 的三种流式 delta：`text-delta`、`reasoning-delta`、`tool-call-delta`（`classify` 白名单，chunk-rows.ts:101-128；`MIN_RUN=3`，chunk-rows.ts:82）。这不是 tool I/O mask，而是流式 delta 的无损行打包；解码 `decodeStorageRecord`/`expandRow` 精确还原（chunk-rows.ts:298-350）。[verified]
3. 客户端 `expandEntries`（session.ts:800-814）只做 chunk-row 还原 + view 对齐，**没有对 tool 输入/输出做折叠或摘要**。[verified]
4. `PAGE_MESSAGES = 8`（session.ts:37），其注释已确认 tool 密集会话是 payload 主因："8 turns on a tool-dense agent conversation reads ~90k events instead of the ~270k a 25-turn page needs, cutting the cold-open decode ... to about a third"。[verified]
5. `detachedHistoryRead`（api-proxy.ts:1649-1707）是分页冷读路径，最终仍走 `pageEntries`；grep `expand|tool-detail|toolDetail|mask|collapse|onDemand|folded`（api-proxy.ts 与 session.ts）**未发现任何"展开时按需请求工具完整内容"的专门端点**。[verified]
6. surface 事件类型只有 `user/message`、`assistant/message`、`tool/result`（surface.ts:15-19），但 `pageEntries` 并不按 surface 过滤——历史页传输的是**整条原始事件日志切片**（含 `tool/call`、`tool/code-dispatch`、`step/*`、`turn/*`、`request/header` 等全部类型）。[verified]

## B. 实测 payload 构成（[verified]，/tmp/tail.bin，node v25.9.0 zstdDecompressSync）

- 样本：一页真实历史响应，`server-response` RPC 帧，`rpcId="probe-verify"`，`result.value.events`。
- 压缩（wire）962,483 B；zstd 解压后 6,354,058 B（约 6.60×）。客户端 parse/fold 成本按解压后 6.35MB 计。
- wire 条目 3,765 个 = 443 个 packed chunk row + 3,322 个标量事件；展开后约 **161,955 个事件**。

解压后按类型字节占比（% 相对 6,354,058 B）：

| 类型/分组 | bytes | 占比 | 备注 |
|---|---:|---:|---|
| assistant/message | 1,847,123 | 29.07% | 内部：message.content 671,085；usage 19,233；**sourceEventSeqs 1,120,054（17.6%）** |
| assistant/chunk（未打包） | 856,148 | 13.47% | 1343 条 |
| reasoning-chunks（packed） | 709,763 | 11.17% | 150 row / 73,743 member |
| tool-call-chunks（packed） | 706,454 | 11.12% | 214 row / 74,929 member |
| tool/call | 585,294 | 9.21% | 其中 data.arguments = 259,757（4.09%） |
| tool/code-dispatch | 543,547 | 8.55% | arguments 202,864 + content 236,023 |
| tool/code-dispatch-start | 300,461 | 4.73% | 360 条 |
| tool/result | 293,019 | 4.61% | 其中 message.content = 229,149（3.61%） |
| request/header | 189,410 | 2.98% | |
| user/message | 108,765 | 1.71% | |
| text-chunks（packed） | 98,745 | 1.55% | 79 row / 9,961 member |
| 其余（约 21 类，compaction/step/turn/…） | ~195k | ~3.1% | |

关键派生事实（[verified]，由实测字段级拆分得出）：

1. **工具输入至少 3 处表示**：流式 `tool-call-delta` 已打包进 tool-call-chunks（706,454）+ `assistant/message` content 内 `tool-call` part 214 个（296,543）+ `tool/call` data.arguments（259,757）≈ 1,262,754 B（19.9%）。
2. **工具输出 2 处载体**：`tool/code-dispatch` content 236,023 + `tool/result` content 229,149 ≈ 465,172 B（7.3%）。注意 run_code 的实际子调用结果主要放在 `tool/code-dispatch.content`，仅 mask `tool/result` 会漏掉大头。
3. **reasoning 双份**：reasoning-chunks（709,763）与 `assistant/message` content 内 reasoning part（291,964）同时存在。
4. **真正可见文本极小**：`assistant/message` 内 `text` part 仅 35,533 B（0.56%）；`user/message` 全量 108,765 B（1.71%）。二者合计 ~2.3%。
5. **`sourceEventSeqs` provenance 是单块最大隐藏开销**：assistant/message 事件上 1,120,054 B（17.6%），最大单数组长 10,989（seq 451034）。

## C. 行业实践（web_search）

1. Claude Code 默认延迟加载 MCP 工具**定义/schema**，按需经 ToolSearch 加载——对象是工具 schema，不是 transcript 里的工具输入/输出。[verified]（Claude Code docs；Anthropic "advanced tool use"）
2. claude.ai 网页版长对话默认把**所有**消息一次载入 DOM，官方 issue 反映卡顿/内存高，即原生并未做客户端懒加载。[verified]（GitHub anthropics/claude-code #24146）
3. VS Code 代理 UI 把 reasoning 与分组 tool call 渲染为**可折叠区块**；ChatGPT/Claude transcript 也有折叠 tool call/思考的交互（属 UI 折叠，非 wire mask）。[verified]（VS Code docs；多个第三方折叠扩展）
4. "在 wire 层把 tool 输入/输出 mask 成摘要、展开时经专门 API 按需拉取"作为主流产品既定惯例——**未找到公开证据**。[unverified]

## D. 对提案前提的逐条核对

1. "首屏历史页已把 tool 输入/输出从 wire 上 mask 掉、只传统计摘要" —— **与当前代码不符**。现状是整条原始日志切片透传，tool I/O 全量且多重表示；唯一压缩是 chunk-row 打包（流式 delta 去重），不是 tool I/O mask。[verified]
2. "展开时通过专门 API 按需请求完整内容" —— 该专门 API **当前不存在**。[verified]
3. "从而把首屏传输限制在 user/assistant 文本之内" —— 前提不成立：首屏当前传输全部事件类型（6.35MB 解压），且 assistant 事件内部还含 reasoning、tool-call part 与 sourceEventSeqs；user+可见 text 仅 ~2.3%。[verified]
4. 示例文案「已折叠 26 次工具调用 · 20 条中间回复 · 13分25秒」—— 仓库内无此折叠/统计逻辑或字符串。[verified]

## E. 已知局限

- B 节数字来自**单个会话的单页样本**（run_code 密集、214 次工具调用），反映该页构成，不是跨会话平均值。[verified]
