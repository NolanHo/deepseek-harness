# Agent Note：Web 历史冷读改为持久层 `readFrom` 分页读取

Status: implemented

[English](2026-08-26-paged-cold-history-reads.md) | 中文

> Scope：web `session.history` RPC 如何读取未附加（冷）会话——带加宽循环的后缀窗口 `readFrom` 读取、按回合对齐的分页切点、tail 页投影基线的缓存冷读阶梯，以及修复歧义尾部时的全量 inspect 回退。组装素材：持久层缝隙的 [`readFrom`](../../docs/subsystems/session.md) 原语与投影缓存的 `coldSnapshot` 阶梯。

## Problem

web GUI 打开大会话时，每次冷读都付出全量日志重建：history 处理器先 `inspect()`——读完整文件、逐行 JSON 解析与 chunk 展开、把全部事件在 Session 折叠里重放一遍、合成中断回合的闭合事件——然后在内存里切一页。实测 81 万事件会话：JSONL 后端 ~1.1s，SQLite ~820ms，而发出的一页只有约 50 个回合。SQLite 后端早已实现可定位的 `loadStoredFrom` 钩子，投影缓存也早已暴露零全量读取的 `coldSnapshot` 阶梯；处理器只是从未使用它们。

## Decision

**冷历史读取改为带加宽循环的分页后缀读取。** api proxy 的 `detachedHistoryRead` 先用 `persistence.list()` 解析会话头（缺失映射为 `session-not-found`），选择首个窗口（`fromSeq`）：tail 页锚定在投影缓存水印减去 `maxMessages × 256` 事件处，loadOlder 页锚定在 `beforeSeq` 减去同一估计处；循环：`readFrom(id, fromSeq)` → `paginate` → 若页切点可证明落在后缀内（`cut >= fromSeq`）且窗口至少含 `maxMessages` 条用户消息则直接服务；否则 `fromSeq` 减半重读。`fromSeq === 0` 构造上即精确，循环必然终止；最坏情况等于今天的全量读。非 seek 后端（JSONL）在协调器内部降级（`readFrom` 回退为全前缀 + 跳过），不低于今天的行为。

**页切点只在用户消息上。** `paginate` 只数 `user/message` 边界（无用户消息的合成日志回退到 `assistant/message`），因此一页 = 整数个回合：切点落在用户提问上，该回合的完整工具/助手内容随页携带——绝不切在回合中间或回答中间。旧行为两类消息都数，会在用户消息与其回答之间切开。`maxMessages` 语义变为"每页用户消息数"（默认 50 = 50 个回合）。

**两个保守守卫回退保证每页精确。**（1）`needsRepairTail` 扫描后缀最后的回合边界：尾部止于 `turn/start`——或窗口内根本没有回合边界、无法证明干净——回退到全量 `inspect()`，这是唯一会合成中断回合闭合事件的路径；尾部止于 `turn/end` 则无需闭合事件，后缀原样服务。（2）tail 页投影来自 `sessionProjectionCache.coldSnapshot`（缓存检查点行 + `readFrom` 尾部重折叠，fail-soft，零全量读取）；缓存缺失则整个块缺失，与未挂载 registry 的部署一致。

**已知降级（记录在处理器 JSDoc 中）：** presenter scope 从后缀解析，读取窗口之前选择的预设回退到头值——仅影响视图（通用工具卡片），限于切换发生在窗口外的 switched-blank 会话。

在迁移后的 SQLite 存储上实测（81 万事件会话，冷进程）：全量 `inspect()` 820ms，`readFrom` 尾部窗口 40ms——冷打开成本不再随历史长度增长。

## Consequences

- 冷历史不再合成闭合事件，除非尾部修复歧义；干净尾部与 inspection 输出逐字节一致（后者本来也不会产生闭合事件）。
- `inspect()` 保留在 resume 路径（`ensureSession`），agent 激活不变；只有转录读取改成分页。
- subagent-history 处理器仍全量 inspect——它的页共享新的按回合 `paginate`，但其读取路径是后续采用同方案的对象。
- 固定旧混合消息计数语义（`api-proxy-view`）或冷读 inspect 调用次数（`api-proxy-cold`）的测试已更新为新可观察行为；分页契约有专属 spec（`api-proxy-history-paged`）。

## Alternatives considered

- **分页读不带修复尾部守卫**：否决——后缀无法证明中断回合的闭合事件；原样服务会改变崩溃恢复呈现。
- **投影基线从页事件折叠**：否决——投影是会话级事实；缓存阶梯正是为零全量读取而存在。
- **切点同时落在 assistant 消息（现状）**：否决——会把回合从提问与回答之间切开，这正是本变更要修的阅读缺陷。
- **按页内消息密度重新估计而非减半**：否决——减半单调、上界为 log2(end/estimate) 次读取、不需要任何后端统计。

## Verification

- `pnpm exec vitest run packages/host/apiproxy` 21 文件 / 385 测试绿（新 `api-proxy-history-paged.spec.ts`：tail-via-readFrom、用户消息切点、加宽收敛、未闭合尾部回退、未找到映射、投影缓存存在/失败/缺失）。
- `pnpm run typecheck` 与 `pnpm run test:gui` 绿（4044 测试）；客户端的回合对齐页大小（25）更新了三个固化旧线上值的 client-runtime spec。
- 浏览器 lane：完整 `DSH_SNAPSHOT=replay pnpm run test:web:built` 回放——269 通过；剩余 11 个失败为本机既有的宿主沙箱集合（容器无 sandbox 后端：bwrap 无法建 namespace、内核 5.4 无 Landlock）加上 built-boot 的官方 profile 摘要（`DSH_BUILD_CLIENT_PROFILE=official pnpm run build` 后通过）。零失败归因于分页读取。
- 迁移后的 SQLite 存储实测：81 万事件会话全量 `inspect()` 820ms vs `readFrom` 尾部窗口 40ms。
