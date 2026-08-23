# @deepseek-ai/dsh-web-search-zhihu

English | [中文](README.zh.md)

A [Zhihu developer API](https://developer.zhihu.com)-backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It queries the in-site `zhihu_search` backend first and tops up with the whole-web `global_search` backend, then maps `Data.Items[]` into the seam's normalized `WebSearchResult`.

This is an **implementation** package: it registers a provider into `ctx.web`, it does not own the `ctx.web` key and it does not register a model-facing tool (that is `@deepseek-ai/dsh-tool-web`). Like `@deepseek-ai/dsh-llm-deepseek`, it is a function/namespace plugin (`inject: ['web']`) that registers its backend, not a default-export service.

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | `$ZHIHU_ACCESS_SECRET` | Zhihu access secret. Empty/absent makes the provider unavailable. |
| `baseURL` | `https://developer.zhihu.com` | Endpoint base; `/api/v1/content/<backend>` is appended. An unparseable value makes the provider unavailable. |
| `count` | `5` | Per-backend result count and the fallback bound when a request carries no `maxResults`. Must be a positive integer. |

```yaml
- id: web-search-zhihu
  name: '@deepseek-ai/dsh-web-search-zhihu'
  config:
    apiKey: !!js process.env.ZHIHU_ACCESS_SECRET
```

## Mapping

Zhihu returns no generated answer, so `content` is omitted. The provider queries the in-site `zhihu_search` backend with `Count = count`; when it returns fewer than `count` items it tops up with `global_search`, deduplicates the merge by URL, and truncates to the request's `maxResults`. Each item maps to a `WebSearchSource`: `url` ← `Url`, `title` ← `Title`, `snippet` ← `ContentText` truncated to 200 characters with an ellipsis, `publishedAt` ← `EditTime` (unix seconds) converted to ISO-8601 when greater than zero. Items with a blank title or URL are dropped. The final bound is enforced by the seam. Provider failures surface as `WebError` `WEB_PROVIDER_ERROR` (401/403 carry an auth hint, 429 a rate-limit hint); an aborted request surfaces as `WEB_ABORTED`. Credential-bearing HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`.

## Model Experience

Indirectly, through [`dsh-tool-web`](../tool-web/README.md), which retains this provider's `maxResults`-bounded URLs, titles, summaries, and publication dates or its exact `Zhihu search aborted`, `Zhihu search request failed: <error>`, and `Zhihu returned an unprocessable response body: <error>` failures under the consumer's error wrapper while generated answers and provider-private fields remain outside context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **An item with a blank title or URL is dropped entirely** — no portable citation to map, so fewer sources than the requested count can return.
- **`zhida` (Zhihu Zhida answer streaming) is not implemented** — it streams over SSE and does not map to a source list; only the two JSON search backends are wired.
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason surfaces as `WEB_PROVIDER_ERROR`.
