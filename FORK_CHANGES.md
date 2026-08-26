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

### 2026-08-24 — 回合折叠与移动外壳的集成修复 / Turn-fold & mobile-shell integration fixes

- EN: Turn-fold + mobile-shell stabilization round (Agent Note `2026-08-23-transcript-turn-fold-and-mobile-shell`, updated in place): fold expansion moved into the per-session chat store (view-tab remounts were collapsing the transcript and breaking scroll restoration); the mobile grid collapses to one in-flow track (three-track templates auto-placed the center column into the zero-width sidebar track); a frame-owned floating drawer opener (`Open sidebar`) is the mobile navigation entry; Escape gating follows the sheet's actual visibility; browser e2e adapted to fold/mobile behavior (`expandAllTurnFolds` helper) and goldens refreshed.
- ZH: 回合折叠与移动外壳的稳定化收尾（Agent Note `2026-08-23-transcript-turn-fold-and-mobile-shell`，原地更新）：折叠展开状态移入按会话的 chat store（视图标签重挂载会折叠转录并破坏滚动恢复）；移动端网格收成单一在流轨道（三轨模板会把对话列自动放进 0 宽侧栏轨道）；框架自有浮动按钮成为移动端抽屉入口；Escape 分层跟随 sheet 实际可见性；浏览器 e2e 适配折叠/移动行为（`expandAllTurnFolds` 辅助函数）并刷新 goldens。

### 2026-08-26 — Web 会话存储切换 SQLite / Web session storage switches to SQLite

- EN: The web profile now composes the SQLite session-persistence backend (single `sessions.sqlite` beside the JSONL tree) instead of the JSONL backend; headless/CLI profiles keep JSONL. The SQLite provider implements the seek-capable `loadStoredFrom` hook, the precondition for paged cold history reads. Migration to the database remains a manual one-shot (`/root/dsh-web/migrate-to-sqlite.sh`); the JSONL tree stays as a read-only backup.
- ZH: web 配置改为组装 SQLite 会话持久化后端（`sessions.sqlite` 单文件，位于 JSONL 目录树旁），headless/CLI 配置保持 JSONL。SQLite 后端实现了可定位读取的 `loadStoredFrom` 钩子，是历史分页冷读的前提。迁移到数据库仍是手动一次性操作（`/root/dsh-web/migrate-to-sqlite.sh`）；JSONL 目录树保留为只读备份。
