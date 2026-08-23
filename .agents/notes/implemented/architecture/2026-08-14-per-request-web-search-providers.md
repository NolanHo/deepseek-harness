# Agent Note: Per-request web search provider selection

Status: implemented

English | [中文](2026-08-14-per-request-web-search-providers.zh.md)

## Problem

`ctx.web` resolved exactly one search provider per deployment: the configured `searchProvider` id (or the single usable registered provider) decided every `web_search` call, and switching backends meant editing configuration and restarting. The dsh deployment wanted several live search backends at once (Bocha, Brave, Zhihu, academic) and for the model to pick one per query, but registering more than one usable provider made the unconfigured path fail with `WEB_PROVIDER_AMBIGUOUS`, and the model-facing `web_search` schema had no way to name a backend.

## Decision

This note extends the [web capability seam note](2026-06-24-web-capability-seam.md); its ownership split (seam owns selection, `dsh-tool-web` owns model-facing schema) is unchanged.

- `WebRuntime.search()` gains an optional `WebSearchOptions` second argument (`{ signal?, provider? }`). An explicit `options.provider` resolves that registered provider for the call alone, overriding the configured default; the configured-default and auto-select rules are unchanged. Unknown ids fail with `WEB_PROVIDER_UNKNOWN` and the message lists the available ids; a registered-but-unavailable id fails with `WEB_PROVIDER_UNAVAILABLE`. The default provider stays configurable via `searchProvider` / `$DSH_WEB_SEARCH_PROVIDER`, so multiple registered providers no longer collide — they only keep the unconfigured default ambiguous, which deployments pin explicitly.
- `web_search` gains an optional model-facing `backend` string argument, forwarded as `options.provider`; omitting it uses the configured default. The tool remains the only owner of model-facing wording; the seam owns selection and errors.
- Four provider plugins register into the same seam: `web-search-bocha` (Bocha `POST /v1/web-search`), `web-search-brave` (Brave `GET /res/v1/web/search`), `web-search-zhihu` (Zhihu open API station/global search, ported from the workbench `search` skill's Python client), and `web-search-academic` (arXiv Atom + Semantic Scholar JSON, merged). Each follows the Exa provider contract: cheap local `available()`, `redirect: 'error'` on credentialed requests, `WEB_ABORTED`/`WEB_PROVIDER_ERROR` failures, and package tests against mocked fetch.
- The workbench `search` skill's `web`/`zhihu`/`academic` channels become redundant in dsh once these providers are mounted; `docs` (ctx7) stays skill-side.

## Alternatives considered

- A fixed enum in the `web_search` schema — rejected: providers register at runtime; a schema enum would drift from the registered set and break custom providers.
- An environment-only switch (`$DSH_WEB_SEARCH_PROVIDER`) — already exists, but it only moves the default and cannot express per-query backend choice.
- A routing "meta-provider" that fans out internally — rejected: it would bypass the seam's registry, selection, and error ownership and duplicate availability semantics.

## Consequences

- The model can route one search to any registered backend per query, and misroutes fail with an actionable list instead of a configuration restart.
- `web_fetch` keeps its single configured provider for now; the same options shape extends to it symmetrically when a per-request fetch consumer appears.
- Deployments that register several providers and omit `searchProvider` still get `WEB_PROVIDER_AMBIGUOUS` on the default path — the ambiguity is now resolved by pinning the default, not by unregistering providers.
