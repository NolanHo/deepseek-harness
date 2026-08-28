---
description: "A Bocha WebSearchProvider for the ctx.web seam: calls Bocha's web-search endpoint and maps data.webPages.value[] into normalized WebSearchResult."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-bocha

English | [中文](README.zh.md)

## Summary

A [Bocha](https://bochaai.com)-backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It calls Bocha's `POST /v1/web-search` endpoint and maps the nested `data.webPages.value[]` into the seam's normalized `WebSearchResult`.

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
| `apiKey` | `$BOCHA_API_KEY` | Bocha API key. Empty/absent makes the provider unavailable. |
| `baseURL` | `https://api.bochaai.com` | Endpoint base; `/v1/web-search` is appended. An unparseable value makes the provider unavailable. |
| `freshness` | `noLimit` | Recency filter sent as Bocha's `freshness`. |
| `count` | `10` | Default result count sent as `count` when a request carries no `maxResults`. Must be a positive integer. |

```yaml
- id: web-search-bocha
  name: '@deepseek-ai/dsh-web-search-bocha'
  config:
    apiKey: !!js process.env.BOCHA_API_KEY
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Mapping

Bocha returns nested `data.webPages.value[]` and no generated answer, so `content` is omitted. Each result maps to a `WebSearchSource`: `url` ← `url`, `title` ← `name`, `snippet` ← the first non-blank of `snippet` then `summary` (an entry with both blank has no portable snippet and is dropped), `publishedAt` ← `dateLastCrawled`. A request's `maxResults` wins over the configured `count` default and is sent as Bocha's `count` for a cost/latency optimization; the final bound is enforced by the seam. A 2xx body with `code !== 200` is an in-band failure and surfaces its `msg`. Provider failures (HTTP errors, non-200 `code`, network failure, unparseable bodies) surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`.

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

Indirectly, through [`dsh-tool-web`](../tool-web/README.md), which retains this provider's `maxResults`-bounded URLs, titles, first snippets, and publication dates or its exact `Bocha search aborted`, `Bocha search request failed: <error>`, `Bocha API error (HTTP <status>)`, `Bocha API error (non-200 code)`, and `Bocha returned an unprocessable response body: <error>` failures under the consumer's error wrapper while generated answers and provider-private fields remain outside context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is incomplete on its own. They are current package constraints.

- **An entry with both `snippet` and `summary` blank is dropped entirely** — no portable snippet to map, so fewer sources than the requested count can return.
- **Only `freshness`/`count` are exposed** — Bocha's other controls (streaming, answer/image options, other freshness windows) wait on provider-neutral Service Definition fields ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)).
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (e.g. `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
