# Agent Note: 单次请求的 web 搜索提供方选择

Status: implemented

[English](2026-08-14-per-request-web-search-providers.md) | 中文

## 问题

`ctx.web` 每个部署只解析一个搜索提供方：配置的 `searchProvider` id（或唯一一个可用的已注册提供方）决定每一次 `web_search` 调用，切换后端意味着改配置并重启。dsh 部署想要同时拥有多个可用的搜索后端（博查、Brave、知乎、学术），并让模型按查询自选一个，但注册多个可用提供方会让未配置路径以 `WEB_PROVIDER_AMBIGUOUS` 失败，而面向模型的 `web_search` schema 没有任何命名后端的方式。

## 决策

本 Agent Note 扩展 [web 能力 seam Agent Note](2026-06-24-web-capability-seam.zh.md)；其归属划分（seam 拥有选择权，`dsh-tool-web` 拥有面向模型的 schema）不变。

- `WebRuntime.search()` 增加可选的 `WebSearchOptions` 第二参数（`{ signal?, provider? }`）。显式传入 `options.provider` 时，仅为该次调用解析该已注册提供方，覆盖配置的默认值；配置默认与自动选择的规则不变。未知 id 以 `WEB_PROVIDER_UNKNOWN` 失败且消息列出可用 id；已注册但不可用的 id 以 `WEB_PROVIDER_UNAVAILABLE` 失败。默认提供方仍可通过 `searchProvider` / `$DSH_WEB_SEARCH_PROVIDER` 配置，因此注册多个提供方不再冲突——它们只是让未配置的默认保持歧义，部署方显式固定即可。
- `web_search` 增加可选的面向模型参数 `backend`（字符串），转发为 `options.provider`；省略则使用配置的默认值。工具仍是面向模型措辞的唯一所有者；seam 拥有选择与错误。
- 四个提供方插件注册进同一 seam：`web-search-bocha`（博查 `POST /v1/web-search`）、`web-search-brave`（Brave `GET /res/v1/web/search`）、`web-search-zhihu`（知乎开放平台站内/全网搜索，自 workbench `search` skill 的 Python 客户端移植）、`web-search-academic`（arXiv Atom + Semantic Scholar JSON，合并）。每个都遵循 Exa 提供方契约：便宜的本地 `available()`、credential 请求 `redirect: 'error'`、`WEB_ABORTED`/`WEB_PROVIDER_ERROR` 失败、针对 mock fetch 的包测试。
- 这些提供方挂载后，workbench `search` skill 的 `web`/`zhihu`/`academic` 通道在 dsh 中变得冗余；`docs`（ctx7）仍留在 skill 侧。

## 曾考虑的替代方案

- 在 `web_search` schema 中使用固定枚举——否决：提供方在运行时注册；schema 枚举会与注册集合脱节并破坏自定义提供方。
- 仅用环境变量切换（`$DSH_WEB_SEARCH_PROVIDER`）——已存在，但它只能移动默认值，无法表达按查询选择后端。
- 一个内部扇出的路由「元提供方」——否决：它会绕过 seam 的注册表、选择与错误归属，并重复可用性语义。

## 结果

- 模型可以按查询把一次搜索路由到任意已注册后端，误路由会以可操作的列表失败，而不是配置重启。
- `web_fetch` 暂时保留单一配置提供方；当出现按请求 fetch 的消费方时，同样的 options 形状会对称地扩展到它。
- 注册多个提供方且省略 `searchProvider` 的部署，在默认路径上仍会得到 `WEB_PROVIDER_AMBIGUOUS`——该歧义现在通过固定默认值解决，而不是注销提供方。
