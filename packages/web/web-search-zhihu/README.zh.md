---
description: "一个由知乎开发者 API 支持的 ctx.web WebSearchProvider：先查询 zhihu_search，不足时用 global_search 补齐，并把 Data.Items[] 映射为规范化的 WebSearchResult。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-zhihu

[English](README.md) | 中文

## 概述

由 [知乎开发者 API](https://developer.zhihu.com) 支持的 `WebSearchProvider`，用于 harness [web 能力 seam](../web/README.zh.md)（`ctx.web`）。它先查询站内 `zhihu_search` 后端，不足时用全网 `global_search` 后端补齐，再把 `Data.Items[]` 映射为 seam 规范化的 `WebSearchResult`。

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
| `apiKey` | `$ZHIHU_ACCESS_SECRET` | 知乎访问密钥。为空或缺失时提供方不可用。 |
| `baseURL` | `https://developer.zhihu.com` | 端点基址；追加 `/api/v1/content/<backend>`。无法解析时提供方不可用。 |
| `count` | `5` | 每个后端的请求结果数，也是请求未携带 `maxResults` 时的回退上限。必须是正整数。 |

```yaml
- id: web-search-zhihu
  name: '@deepseek-ai/dsh-web-search-zhihu'
  config:
    apiKey: !!js process.env.ZHIHU_ACCESS_SECRET
```

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 映射

知乎不返回生成答案，因此省略 `content`。提供方以 `Count = count` 查询站内 `zhihu_search` 后端；当返回不足 `count` 条时用 `global_search` 补齐，按 URL 去重，再截断到请求的 `maxResults`。每项结果映射为 `WebSearchSource`：`url` ← `Url`、`title` ← `Title`、`snippet` ← `ContentText` 截断到 200 字符并加省略号、`publishedAt` ← `EditTime`（unix 秒）在大于零时转为 ISO-8601。标题或 URL 为空的结果会被丢弃。最终上限由 seam 强制执行。提供方失败以 `WebError` `WEB_PROVIDER_ERROR` 呈现（401/403 附带鉴权提示、429 附带限流提示）；中止请求以 `WEB_ABORTED` 呈现。带凭证的 HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。

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

通过 [`dsh-tool-web`](../tool-web/README.zh.md) 间接影响；该工具保留此提供方经 `maxResults` 限制的 URL、标题、摘要与发布日期，或将确切的错误消息 `Zhihu search aborted`、`Zhihu search request failed: <error>` 与 `Zhihu returned an unprocessable response body: <error>` 置于消费方的错误包装层内；生成答案与提供方私有字段不进入上下文。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了提供方自身尚不完整之处。它们是当前包约束。

- **标题或 URL 为空的结果会被整个丢弃**：没有可映射的可移植引用，因此返回源可能少于请求数量。
- **未实现 `zhida`（知乎直答）**：它通过 SSE 流式返回，无法映射为源列表；本包只接入两个 JSON 搜索后端。
- **按错误形状分类中止**：只有 `DOMException` 且名为 `AbortError` 时才映射为 `WEB_ABORTED`；携带自定义原因的中止会呈现为 `WEB_PROVIDER_ERROR`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
