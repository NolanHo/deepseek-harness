---
description: "An arXiv Atom API and Semantic Scholar Graph API WebSearchProvider for the ctx.web seam: queries both backends in parallel and maps papers into normalized WebSearchResult."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-academic

English | [中文](README.zh.md)

## Summary

An [arXiv Atom API](https://export.arxiv.org/api/query) + [Semantic Scholar Graph API](https://api.semanticscholar.org/graph/v1)-backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It queries both backends in parallel and maps arXiv Atom entries and Semantic Scholar papers into the seam's normalized `WebSearchResult`. No credential is required.

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
| `arxivBaseURL` | `https://export.arxiv.org/api/query` | arXiv Atom API query endpoint. An unparseable value makes the provider unavailable. |
| `s2BaseURL` | `https://api.semanticscholar.org/graph/v1` | Semantic Scholar Graph API base; `/paper/search` is appended. An unparseable value makes the provider unavailable. |
| `count` | `5` | Per-backend result count and the fallback bound when a request carries no `maxResults`. Must be a positive integer. |
| `minS2IntervalMs` | `1500` | Minimum interval between Semantic Scholar requests, in milliseconds. Must be a positive integer. |

```yaml
- id: web-search-academic
  name: '@deepseek-ai/dsh-web-search-academic'
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Mapping

Neither backend returns a generated answer, so `content` is omitted. The provider queries arXiv (`search_query=all:<query>`, `max_results=count`) and Semantic Scholar (`/paper/search`, `limit=count`) in parallel, places Semantic Scholar results first, and truncates the merge to the request's `maxResults`. Each arXiv entry maps to a `WebSearchSource`: `url` ← `https://arxiv.org/abs/<id>` (the `id`'s last path segment), `title` ← `title`, `snippet` ← `summary` truncated to 300 characters, `publishedAt` ← `published`. Each Semantic Scholar paper maps to: `url` ← `url`, `title` ← `title`, `snippet` ← `abstract` truncated to 300 characters, `publishedAt` ← `publicationDate`. Entries with a blank title are dropped. The final bound is enforced by the seam. Semantic Scholar requests are throttled to `minS2IntervalMs`. A single backend failure degrades to the surviving backend's results (Semantic Scholar's free tier rate-limits aggressively, and the arXiv half remains a complete answer); the call fails with `WEB_PROVIDER_ERROR` only when both backends reject. An aborted request surfaces as `WEB_ABORTED` even when the other backend succeeded.

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

Indirectly, through [`dsh-tool-web`](../tool-web/README.md), which retains this provider's `maxResults`-bounded URLs, titles, abstracts, and publication dates or its exact `Academic search aborted`, `<backend> search request failed: <error>`, `<backend> API error (HTTP <status>)`, and `arXiv returned an unparseable Atom feed: <error>` failures under the consumer's error wrapper while generated answers and provider-private fields remain outside context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is incomplete on its own. They are current package constraints.

- **An entry with a blank title is dropped entirely** — no portable citation to map, so fewer sources than the requested count can return.
- **The Semantic Scholar throttle is per-provider-instance** — it enforces `minS2IntervalMs` across one provider's requests, not across processes or providers.
- **Only title/abstract/URL/date fields are mapped** — arXiv authors and categories and Semantic Scholar citations/tldr wait on provider-neutral Service Definition fields.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
