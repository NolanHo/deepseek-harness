# Agent Note：历史页的线上 chunk 打包与 HTTP 响应压缩

Status: implemented

[English](2026-08-26-wire-chunk-packing-and-compression.md) | 中文

> Scope：为什么 `session.history` 页面现在发打包 chunk 行、为什么 fetch 载体压缩 JSON 响应——单靠分页持久化读取够不着的冷打开延迟，由线上层修复。

## Problem

分页冷读落地后，实测真实 RPC：host 读取 ~40ms，但端到端 history 调用仍有 3.5–4.7s——81 万事件会话的 25 回合页序列化出 **35MB**：159,976 个 `assistant/chunk` 事件，JSON 信封远超载荷（存储层对同形状实测 ~56× 信封浪费）。JSON.stringify、HTTP 传输、浏览器解析都在为信封买单；服务器也从不压缩响应。

## Decision

**历史线上条目复用存储 chunk 编解码器。** `pageEntries` 对页面运行 `packChunkRuns`：连续的白名单 delta-chunk 流（≥3 个成员）折叠成一个 `ChunkRow`（`text-chunks` / `reasoning-chunks` / `tool-call-chunks`），作为 `HistoryEntry` 联合类型的新 `{ packed }` 分支上线。编解码器无损、白名单形状、带校验——客户端用 `decodeStorageRecord` 在对话折叠前把打包行展开回精确的原始事件，下游永远看不到打包行。页切点、`baseSeq`、视图对齐、投影基线全部仍按展开后的事件计算（chunk 条目从不带视图）。

**浏览器包只经线上入口导入编解码器。** `@deepseek-ai/dsh-host-apiproxy/api` 转发 `decodeStorageRecord`/`ChunkRow`（新 `api/chunk-rows.ts`）；客户端包本来就 value-import 该入口（`transportError`），它不带任何 cordis 增强。客户端包**禁止**导入 `@deepseek-ai/dsh-session` 主入口：它声明了仅宿主可见的 `sessions: SessionStore` 增强，两面 typecheck 分离（"一个程序不能同时看到两面"）下客户端一旦加载即触发 `TS2717` 冲突、`ctx.get('sessions')` 解析成宿主 store（客户端 apply spec 钉住了这一点）。纯净的 `chunk-rows` 子路径在 `tsconfig.base.json` 中有两面共用的 paths 条目。

**fetch 载体压缩 JSON 响应。** `toFetchHandler` 用 `maybeCompress` 包裹 POST 信封路径：取客户端声明的最强编码（zstd，其次 gzip），只压缩 ≥1KiB 的 `application/json` 体，绝不碰 SSE 流与下载。`arrayBuffer()` 读取之后的**每个**返回都必须用字节重建新的 `Response`——返回被消费过的原始 Response 会写出空流，表现为每个小 `describe` 调用的 `net::ERR_EMPTY_RESPONSE`（lane 在修复前复现为无穷的连接重试循环）。

实测 81 万事件会话：25 回合页的 16 万 chunk 事件折叠成几百个打包行（35MB → ~2–3MB，zstd 再把传输压到 ~1MB 以下）。

## Consequences

- 线上页格式新增 `{ packed }` 分支；fork 两端同步升级（pre-release，无协议版本协商）。
- 冷打开延迟现在由载荷与渲染决定，而非全量日志重建；客户端仍在安装时线性展开每个打包行。
- `agentPreset.list`、`credentials.describe`、`host.describe` 等小 JSON RPC 也走重建闸门（不压缩、逐字节一致）。
- 读取线上页 `entry.event` 的测试先展开打包行（`wireEvents` 式辅助）；客户端 spec 用 `packChunkRuns` 构造打包 fixture 并断言精确的展开事件流。

## Alternatives considered

- **只压缩不打包**：否决——压缩只减传输，不减 JSON.stringify/parse 成本；56× 信封浪费才是根因。
- **打包但放任客户端导入存储主入口**：否决——从 `dsh-session` main 导入编解码器会打破两面 typecheck 分离（`sessions` 增强的 TS2717）。
- **压缩流式 SSE**：否决——SSE 必须逐帧可冲刷；历史页载荷才是真正的成本中心。

## Verification

- `pnpm exec vitest run packages/host/apiproxy` 21 文件 / 391 测试绿：打包行往返（解码与原始事件完全相等、2-chunk 流保持标量）、gzip/zstd 解压相等、tiny/不可压缩/非 JSON 路径、重建完整性。
- 客户端 runtime 套件绿（open + loadOlder 展开测试断言跨打包尾部的精确事件流）。
- `pnpm run typecheck`（0 错误）与完整浏览器 lane：269 通过；剩余失败为本机既有的宿主沙箱集合（容器无 sandbox 后端）。
