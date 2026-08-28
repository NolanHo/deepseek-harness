---
description: "一个由 Brave Search 支持的 ctx.web WebSearchProvider：调用 Brave 的 web search 端点并把 web.results[] 映射为规范化的 WebSearchResult。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-brave

[English](README.md) | 中文

## 概述

由 [Brave Search](https://brave.com/search/api/) 支持的 `WebSearchProvider`，用于 harness [web 能力 seam](../web/README.zh.md)（`ctx.web`）。它调用 Brave 的 `GET /res/v1/web/search` 端点，把 `web.results[]` 映射为 seam 规范化的 `WebSearchResult`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

这是一个**实现**包：它向 `ctx.web` 注册提供方，不拥有 `ctx.web` 键，也不注册面向模型的工具（后者属于 `@deepseek-ai/dsh-tool-web`）。与 `@deepseek-ai/dsh-llm-deepseek` 一样，它是函数／命名空间插件（`inject: ['web']`），负责注册后端，而非默认导出服务。

### 配置

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

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 映射

Brave 返回 `web.results[]`，不返回生成答案，因此省略 `content`。每项结果映射为 `WebSearchSource`：`url` ← `url`、`title` ← `title`、`snippet` ← `description`、`publishedAt` ← `published_time`（`age` 是相对标签，不参与映射）。没有标题的条目会被丢弃。请求的 `maxResults` 优先于已配置的默认 `count`，并作为 Brave `count` 发送，以优化成本和延迟；最终上限由 seam 强制执行。提供方失败（HTTP 错误、网络失败、响应体无法解析）以 `WebError` `WEB_PROVIDER_ERROR` 呈现；中止请求以 `WEB_ABORTED` 呈现。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Web 包总览](../README.zh.md) —— web 包族及其各自角色。
- [Web 能力 seam](../web/README.zh.md) —— 本提供方注册到的 `ctx.web` 服务。
- [dsh-tool-web](../tool-web/README.zh.md) —— 面向模型的 `web_search` 与 `web_fetch` 工具。
- [Web 能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md) —— 搜索与抓取为何共享同一提供方选择服务。

-----

<a id="model-experience"></a>
## 模型体验

通过 [`dsh-tool-web`](../tool-web/README.zh.md) 间接影响；该工具保留此提供方经 `maxResults` 限制的 URL、标题、描述与发布日期，或将确切的错误消息 `Brave search aborted`、`Brave search request failed: <error>` 和 `Brave returned an unprocessable response body: <error>` 置于消费方的错误包装层内；生成答案与提供方私有字段不进入上下文。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了提供方自身尚不完整之处。它们是当前包约束。

- **没有标题的条目会被整个丢弃**：没有可引用的可移植标题，因此返回源可能少于请求数量。
- **只公开 `count`**：Brave 的其他控制项（safesearch、时效、国家、额外摘要）等待提供方无关的 Service Definition 字段（见 [seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)）。
- **按错误形状分类中止**：只有 `DOMException` 且名为 `AbortError` 时才映射为 `WEB_ABORTED`；携带自定义原因的中止（例如 `dsh-timeout` 的 `TimeoutReason`）会呈现为 `WEB_PROVIDER_ERROR`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
