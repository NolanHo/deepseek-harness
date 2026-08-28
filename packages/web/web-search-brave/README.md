---
description: "A Brave Search WebSearchProvider for the ctx.web seam: calls Brave's web search endpoint and maps web.results[] into normalized WebSearchResult."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-brave

English | [中文](README.zh.md)

## Summary

A [Brave Search](https://brave.com/search/api/)-backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It calls Brave's `GET /res/v1/web/search` endpoint and maps the `web.results[]` into the seam's normalized `WebSearchResult`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

This is an **implementation** package: it registers a provider into `ctx.web`, it does not own the `ctx.web` key, and it does not register a model-facing tool (that is `@deepseek-ai/dsh-tool-web`). Like `@deepseek-ai/dsh-llm-deepseek`, it is a function/namespace plugin (`inject: ['web']`) that registers its backend, not a default-export service.

### Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | `$BRAVE_API_KEY` | Brave API key. Empty/absent makes the provider unavailable. |
| `baseURL` | `https://api.search.brave.com` | Endpoint base; `/res/v1/web/search` is appended. An unparseable value makes the provider unavailable. |
| `count` | `10` | Default result count sent as `count` when a request carries no `maxResults`. Must be a positive integer. |

```yaml
- id: web-search-brave
  name: '@deepseek-ai/dsh-web-search-brave'
  config:
    apiKey: !!js process.env.BRAVE_API_KEY
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Mapping

Brave returns `web.results[]` and no generated answer, so `content` is omitted. Each result maps to a `WebSearchSource`: `url` ← `url`, `title` ← `title`, `snippet` ← `description`, `publishedAt` ← `published_time` (`age` is a relative label and is not mapped). An entry with no title is dropped. A request's `maxResults` wins over the configured `count` default and is sent as Brave's `count` for a cost/latency optimization; the final bound is enforced by the seam. Provider failures (HTTP errors, network failure, unparseable bodies) surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web package map](../README.md) — the web package family and each role.
- [Web capability seam](../web/README.md) — the `ctx.web` service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` and `web_fetch` tools over the seam.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through [`dsh-tool-web`](../tool-web/README.md), which retains this provider's `maxResults`-bounded URLs, titles, descriptions, and publication dates or its exact `Brave search aborted`, `Brave search request failed: <error>`, and `Brave returned an unprocessable response body: <error>` failures under the consumer's error wrapper while generated answers and provider-private fields remain outside context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is incomplete on its own. They are current package constraints.

- **An entry with no title is dropped entirely** — no portable title to cite by, so fewer sources than the requested count can return.
- **Only `count` is exposed** — Brave's other controls (safesearch, freshness, country, extra snippets) wait on provider-neutral Service Definition fields ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)).
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (e.g. `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
