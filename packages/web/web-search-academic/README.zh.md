# @deepseek-ai/dsh-web-search-academic

[English](README.md) | 中文

由 [arXiv Atom API](https://export.arxiv.org/api/query) 与 [Semantic Scholar Graph API](https://api.semanticscholar.org/graph/v1) 支持的 `WebSearchProvider`，用于 harness [web 能力 seam](../web/README.zh.md)（`ctx.web`）。它并行查询两个后端，把 arXiv Atom 条目与 Semantic Scholar 论文映射为 seam 规范化的 `WebSearchResult`。无需任何凭证。

这是一个**实现**包：它向 `ctx.web` 注册提供方，不拥有 `ctx.web` 键，也不注册面向模型的工具（后者属于 `@deepseek-ai/dsh-tool-web`）。与 `@deepseek-ai/dsh-llm-deepseek` 一样，它是函数／命名空间插件（`inject: ['web']`），负责注册后端，而非默认导出服务。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `arxivBaseURL` | `https://export.arxiv.org/api/query` | arXiv Atom API 查询端点。无法解析时提供方不可用。 |
| `s2BaseURL` | `https://api.semanticscholar.org/graph/v1` | Semantic Scholar Graph API 基址；追加 `/paper/search`。无法解析时提供方不可用。 |
| `count` | `5` | 每个后端的请求结果数，也是请求未携带 `maxResults` 时的回退上限。必须是正整数。 |
| `minS2IntervalMs` | `1500` | 两次 Semantic Scholar 请求之间的最小间隔，单位毫秒。必须是正整数。 |

```yaml
- id: web-search-academic
  name: '@deepseek-ai/dsh-web-search-academic'
```

## 映射

两个后端都不返回生成答案，因此省略 `content`。提供方并行查询 arXiv（`search_query=all:<query>`、`max_results=count`）与 Semantic Scholar（`/paper/search`、`limit=count`），Semantic Scholar 结果在前，再把合并结果截断到请求的 `maxResults`。每个 arXiv 条目映射为 `WebSearchSource`：`url` ← `https://arxiv.org/abs/<id>`（`id` 的最后一段路径）、`title` ← `title`、`snippet` ← `summary` 截断到 300 字符、`publishedAt` ← `published`。每个 Semantic Scholar 论文映射为：`url` ← `url`、`title` ← `title`、`snippet` ← `abstract` 截断到 300 字符、`publishedAt` ← `publicationDate`。标题为空的结果会被丢弃。最终上限由 seam 强制执行。Semantic Scholar 请求按 `minS2IntervalMs` 节流。单个后端失败会降级为存活后端的结果（Semantic Scholar 免费层限流频繁，而 arXiv 半边仍是完整答案）；仅当两个后端都拒绝时，调用才以 `WEB_PROVIDER_ERROR` 失败。中止请求即使另一个后端成功，也以 `WEB_ABORTED` 呈现。

## 模型体验

通过 [`dsh-tool-web`](../tool-web/README.zh.md) 间接影响；该工具保留此提供方经 `maxResults` 限制的 URL、标题、摘要与发布日期，或将确切的错误消息 `Academic search aborted`、`<backend> search request failed: <error>`、`<backend> API error (HTTP <status>)` 与 `arXiv returned an unparseable Atom feed: <error>` 置于消费方的错误包装层内；生成答案与提供方私有字段不进入上下文。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **标题为空的结果会被整个丢弃**：没有可映射的可移植引用，因此返回源可能少于请求数量。
- **Semantic Scholar 节流是单个提供方实例内生效**：它只约束一个提供方实例自身的请求，不跨进程或跨提供方生效。
- **只映射标题／摘要／URL／日期字段**：arXiv 的作者与分类、Semantic Scholar 的引用与 tldr 等待提供方无关的 Service Definition 字段。
