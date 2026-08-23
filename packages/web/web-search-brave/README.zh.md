# @deepseek-ai/dsh-web-search-brave

[English](README.md) | 中文

由 [Brave Search](https://brave.com/search/api/) 支持的 `WebSearchProvider`，用于 harness [web 能力 seam](../web/README.zh.md)（`ctx.web`）。它调用 Brave 的 `GET /res/v1/web/search` 端点，把 `web.results[]` 映射为 seam 规范化的 `WebSearchResult`。

这是一个**实现**包：它向 `ctx.web` 注册提供方，不拥有 `ctx.web` 键，也不注册面向模型的工具（后者属于 `@deepseek-ai/dsh-tool-web`）。与 `@deepseek-ai/dsh-llm-deepseek` 一样，它是函数／命名空间插件（`inject: ['web']`），负责注册后端，而非默认导出服务。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | `$BRAVE_API_KEY` | Brave API 密钥。为空或缺失时提供方不可用。 |
| `baseURL` | `https://api.search.brave.com` | 端点基址；追加 `/res/v1/web/search`。无法解析时提供方不可用。 |
| `count` | `10` | 请求不含 `maxResults` 时以 `count` 发送的默认结果数。必须是正整数。 |

```yaml
- id: web-search-brave
  name: '@deepseek-ai/dsh-web-search-brave'
  config:
    apiKey: !!js process.env.BRAVE_API_KEY
```

## 映射

Brave 返回 `web.results[]`，不返回生成答案，因此省略 `content`。每项结果映射为 `WebSearchSource`：`url` ← `url`、`title` ← `title`、`snippet` ← `description`、`publishedAt` ← `published_time`（`age` 是相对标签，不参与映射）。没有标题的条目会被丢弃。请求的 `maxResults` 优先于已配置的默认 `count`，并作为 Brave `count` 发送，以优化成本和延迟；最终上限由 seam 强制执行。提供方失败（HTTP 错误、网络失败、响应体无法解析）以 `WebError` `WEB_PROVIDER_ERROR` 呈现；中止请求以 `WEB_ABORTED` 呈现。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。

## 模型体验

通过 [`dsh-tool-web`](../tool-web/README.zh.md) 间接影响；该工具保留此提供方经 `maxResults` 限制的 URL、标题、描述与发布日期，或将确切的错误消息 `Brave search aborted`、`Brave search request failed: <error>` 和 `Brave returned an unprocessable response body: <error>` 置于消费方的错误包装层内；生成答案与提供方私有字段不进入上下文。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **没有标题的条目会被整个丢弃**：没有可引用的可移植标题，因此返回源可能少于请求数量。
- **只公开 `count`**：Brave 的其他控制项（safesearch、时效、国家、额外摘要）等待提供方无关的 Service Definition 字段（见 [seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)）。
- **按错误形状分类中止**：只有 `DOMException` 且名为 `AbortError` 时才映射为 `WEB_ABORTED`；携带自定义原因的中止（例如 `dsh-timeout` 的 `TimeoutReason`）会呈现为 `WEB_PROVIDER_ERROR`。
