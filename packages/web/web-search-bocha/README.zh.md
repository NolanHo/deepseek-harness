# @deepseek-ai/dsh-web-search-bocha

[English](README.md) | 中文

由 [Bocha](https://bochaai.com) 支持的 `WebSearchProvider`，用于 harness [web 能力 seam](../web/README.zh.md)（`ctx.web`）。它调用 Bocha 的 `POST /v1/web-search` 端点，把嵌套的 `data.webPages.value[]` 映射为 seam 规范化的 `WebSearchResult`。

这是一个**实现**包：它向 `ctx.web` 注册提供方，不拥有 `ctx.web` 键，也不注册面向模型的工具（后者属于 `@deepseek-ai/dsh-tool-web`）。与 `@deepseek-ai/dsh-llm-deepseek` 一样，它是函数／命名空间插件（`inject: ['web']`），负责注册后端，而非默认导出服务。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | `$BOCHA_API_KEY` | Bocha API 密钥。为空或缺失时提供方不可用。 |
| `baseURL` | `https://api.bochaai.com` | 端点基址；追加 `/v1/web-search`。无法解析时提供方不可用。 |
| `freshness` | `noLimit` | 以 Bocha `freshness` 发送的时效过滤。 |
| `count` | `10` | 请求不含 `maxResults` 时以 `count` 发送的默认结果数。必须是正整数。 |

```yaml
- id: web-search-bocha
  name: '@deepseek-ai/dsh-web-search-bocha'
  config:
    apiKey: !!js process.env.BOCHA_API_KEY
```

## 映射

Bocha 返回嵌套的 `data.webPages.value[]`，不返回生成答案，因此省略 `content`。每项结果映射为 `WebSearchSource`：`url` ← `url`、`title` ← `name`、`snippet` ← `snippet` 与 `summary` 中第一个非空者（两者都为空的条目缺少可移植的 snippet，会被丢弃）、`publishedAt` ← `dateLastCrawled`。请求的 `maxResults` 优先于已配置的默认 `count`，并作为 Bocha `count` 发送，以优化成本和延迟；最终上限由 seam 强制执行。`code !== 200` 的 2xx 响应体是带内失败，会呈现其 `msg`。提供方失败（HTTP 错误、非 200 `code`、网络失败、响应体无法解析）以 `WebError` `WEB_PROVIDER_ERROR` 呈现；中止请求以 `WEB_ABORTED` 呈现。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。

## 模型体验

通过 [`dsh-tool-web`](../tool-web/README.zh.md) 间接影响；该工具保留此提供方经 `maxResults` 限制的 URL、标题、首条 snippet 与发布日期，或将确切的错误消息 `Bocha search aborted`、`Bocha search request failed: <error>`、`Bocha API error (HTTP <status>)`、`Bocha API error (non-200 code)` 和 `Bocha returned an unprocessable response body: <error>` 置于消费方的错误包装层内；生成答案与提供方私有字段不进入上下文。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **`snippet` 与 `summary` 都为空的条目会被整个丢弃**：没有可映射的可移植 snippet，因此返回源可能少于请求数量。
- **只公开 `freshness`／`count`**：Bocha 的其他控制项（流式、答案／图片选项、其他时效窗口）等待提供方无关的 Service Definition 字段（见 [seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)）。
- **按错误形状分类中止**：只有 `DOMException` 且名为 `AbortError` 时才映射为 `WEB_ABORTED`；携带自定义原因的中止（例如 `dsh-timeout` 的 `TimeoutReason`）会呈现为 `WEB_PROVIDER_ERROR`。
