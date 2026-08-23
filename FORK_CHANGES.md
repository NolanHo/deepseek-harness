# FORK_CHANGES.md — 本 fork 对 DeepSeek Harness 的改动记录 / Changes this fork makes to DeepSeek Harness

这个文件记录 `NolanHo/deepseek-harness`（个人定制 fork）相对上游 `deepseek-ai/deepseek-harness` 的全部改动。**仅追加（append-only）**：每次改动在文件末尾追加一条新记录，不修改、不删除历史条目。每条包含：日期、改了什么、为什么。

This file records every change the personal fork `NolanHo/deepseek-harness` makes on top of upstream `deepseek-ai/deepseek-harness`. **Append-only**: add one new entry at the end per change; never edit or remove history. Each entry: date, what changed, why.

规则 / Rules

- 同步上游：每次改动前 `git fetch upstream` 并同步 `upstream/master`，保证 fork 与上游可合并。只从上游吸收更新，不向上游推送、不向上游提 PR。
- Sync upstream: fetch and rebase onto `upstream/master` before every change so the fork stays mergeable. The fork never pushes to or opens PRs against upstream.
- 每条改动必须在这里追加一条中英双语记录。
- Every change must append one bilingual entry here.

---

## 记录 / Entries

### 2026-08-24 — 初始定制集 / Initial customization set

- EN: Web client serving-authority trust — the host publishes the `/api` fence's non-loopback authorities into `window.__DSH_BOOT__.trustedAuthorities`; `connection.isLoopback` becomes `isServingAuthority`, so the settings plane works through loopback-rewrite proxies (deployment pattern: Caddy rewrites Host/Origin to loopback at `dsh.apeiria.cn`).
- ZH: Web 客户端服务权威信任 —— host 把 `/api` 栅栏的非回环权威列表发布进 `window.__DSH_BOOT__.trustedAuthorities`，`connection.isLoopback` 改名为 `isServingAuthority`，使 settings 平面在回环改写代理之后可用（部署形态：Caddy 在 `dsh.apeiria.cn` 把 Host/Origin 改写为回环）。
- EN: Transcript turn fold and mobile shell regimes (Agent Note `2026-08-23-transcript-turn-fold-and-mobile-shell`).
- ZH: 转录回合折叠与移动端外壳分档（Agent Note `2026-08-23-transcript-turn-fold-and-mobile-shell`）。
- EN: Per-request web search provider selection (bocha/brave/zhihu/academic) and docs regen (Agent Note `2026-08-14-per-request-web-search-providers`).
- ZH: 按请求选择 web 搜索后端（bocha/brave/zhihu/academic）及相关文档再生成（Agent Note `2026-08-14-per-request-web-search-providers`）。
