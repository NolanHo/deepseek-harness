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

### 2026-08-26 — SQLite 切换移入 profile 层 + 分页冷读 / SQLite switch moves to the profile layer + paged cold history

- EN: Correction: the web-app bundle no longer switches persistence itself — it only declares the `dsh-session-persistence-sqlite` dependency (knip-exempt, heals into `$DSH_HOME/profiles/node_modules`), and this machine's web profile layer (`~/.dsh/profiles/web/cordis.patch.yml`) inserts the SQLite row and disables JSONL. Keeping the bundle on the upstream composition preserves the web e2e lane, whose fixtures seed the JSONL tree. Paged cold history reads land with it: `session.history` serves detached sessions from `readFrom` suffix windows (turn-aligned page cuts at user messages, widening loop, projection-cache cold ladder, full-inspection fallback for repair-ambiguous tails) — Agent Note `2026-08-26-paged-cold-history-reads`.
- ZH: 更正：web-app bundle 不再自行切换持久化——只声明 `dsh-session-persistence-sqlite` 依赖（knip 豁免，heal 进 `$DSH_HOME/profiles/node_modules`），本机 web profile 层（`~/.dsh/profiles/web/cordis.patch.yml`）插入 SQLite 行并禁用 JSONL。bundle 保持上游组装使 web e2e lane 不受影响（其 fixture 种入 JSONL 树）。随之落地分页冷历史读取：`session.history` 用 `readFrom` 后缀窗口服务未附加会话（按用户消息对齐回合切点、加宽循环、投影缓存冷读阶梯、修复歧义尾部回退全量 inspect）——Agent Note `2026-08-26-paged-cold-history-reads`。

### 2026-08-26 — Wire chunk packing + zstd/gzip response compression / 线上 chunk 打包 + zstd/gzip 响应压缩

- EN: History pages ship consecutive delta-chunk runs as single `{ packed }` wire entries (the storage codec, lossless; the client expands them back to the exact events before the fold), and the fetch carrier compresses JSON responses with the strongest advertised coding (zstd, then gzip) — the wire fix for the 35MB cold-open pages the paged read exposed. Browser packages import the codec through `@deepseek-ai/dsh-host-apiproxy/api` only; client packages must not import `dsh-session`'s main entry (host `sessions` augmentation breaks the two-face typecheck split). Agent Note `2026-08-26-wire-chunk-packing-and-compression`.
- ZH: 历史页把连续 delta-chunk 流折叠成单个 `{ packed }` 线上条目（存储编解码器、无损；客户端在折叠前展开回精确事件），fetch 载体按客户端声明的最强编码（zstd，其次 gzip）压缩 JSON 响应——针对分页读暴露出的 35MB 冷打开页的线上修复。浏览器包只经 `@deepseek-ai/dsh-host-apiproxy/api` 导入编解码器；客户端包不得导入 `dsh-session` 主入口（宿主的 `sessions` 增强会破坏两面 typecheck 分离）。Agent Note `2026-08-26-wire-chunk-packing-and-compression`。

### 2026-08-27 — Paged-read window sizing: aggressive first cut + density re-estimation / 分页读窗口估计：激进首切 + 密度重估

- EN: The first cold-read window now anchors `maxMessages × 4096` events back (SQLite rows are cheap; latency jumps only across storage pages, so headroom wins), and the widening loop re-estimates from the observed events-per-message density instead of halving (one halving step overshot 6.4k → 275k events on dense agent sessions). Measured on the migrated store: dense-session cold reads previously spent ~800ms re-decoding overshot suffixes.
- ZH: 冷读首窗改为锚定在 `maxMessages × 4096` 事件处（SQLite 行读取便宜、延迟跳变只在跨存储页出现，余量更划算），加宽循环按实测每消息事件密度重估而非减半（密集 agent 会话上一步减半会从 6.4k 超调到 27.5 万事件）。迁移库实测：密集会话冷读此前有 ~800ms 浪费在超调后缀的重复解码上。

### 2026-08-27 — Correction: the aggressive first window (×4096) was measured and reverted / 更正：激进首窗（×4096）经实测回退

- EN: A benchmark against the live production store showed `readFrom` scales ~linearly with the window (decode is CPU-bound — no cheap within-page plateau), and the densest session needs ~200k events per 25-message page no matter the window. The first-cut estimate stays at 256 events/message; the widening loop re-estimates from the observed events-per-USER-message density (a suffix without a user message halves instead — the assistant-message fallback count must not feed the density sample).
- ZH: 对线上生产库的实测显示 `readFrom` 随窗口近似线性增长（解码是 CPU 界，没有页内便宜的平台期），最密会话每 25 条消息页无论窗口多大都需要 ~20 万事件。首切估计保持在 256 事件/消息；加宽循环按实测的每“用户消息”事件密度重估（后缀无用户消息时减半——assistant 回退计数不能当作密度样本）。
