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

### 2026-08-27 — AGENTS.md: 运行中 dsh 禁止私自重启 / AGENTS.md: never restart the running dsh

- EN: `AGENTS.md` gains a "Restarting the running dsh" rule: host-half (node) plugin changes take effect only after a dsh restart, so the agent must stop and ask the user to restart (or wait for explicit approval) instead of killing or restarting the process itself; client-half changes (rebuild the client bundle, refresh the browser) do not require a restart.
- ZH: `AGENTS.md` 新增「Restarting the running dsh」规则：host 半（node）插件改动只有在 dsh 重启后才生效，agent 必须停下请用户重启（或等待明确批准），不得自行 kill 或重启进程；client 半改动（重建 client bundle 后刷新浏览器）无需重启。

 Updated upstream
### 2026-08-27 — Message-indexed page cuts: exact window sizing for paged cold reads / 消息索引切点：分页冷读的精确定窗

- EN: `sessionPersistence.messageCut` (new backend hook `userMessageCut`; SQLite answers with one `LIMIT` scan over `type`/`surface_op`, ~3ms on the production store) sizes the history page's first window from the exact Nth append-origin user-message seq instead of estimating. Measured: the density estimator's tail-biased sample made dense-session pages re-read ~2.7x the necessary events (~2.1s vs the ~0.8s minimum decode); the indexed cut reads the page's minimal window in one pass. Sequential media (JSONL) answers undefined and keeps the estimator.
- ZH: `sessionPersistence.messageCut`（新后端钩子 `userMessageCut`；SQLite 对 `type`/`surface_op` 做一次 `LIMIT` 扫描即答，生产库 ~3ms）按第 N 条追加来源用户消息的精确 seq 为历史页首窗定窗，不再依赖估计。实测：密度估计器受尾部样本偏差影响，密集会话页多读了 ~2.7 倍必要事件（~2.1s vs ~0.8s 的最小解码）；索引切点一次读齐页面的最小窗口。顺序介质（JSONL）回答 undefined，保留估计路径。

 HEAD
### 2026-08-28 — Memoize live-session observations so search stops re-cloning whole logs / 记忆化活跃会话观察，搜索不再反复克隆整日志

- EN: Every `session.search` recomputed `observeLive` (structuredClone + document extraction + JSON.stringify + SHA-256 of ALL events) for every attached session — ~12-13 core-seconds per search with large attached logs (553k/692k-event sessions), the measured cause of 13s searches. The fork memoizes the observation per session keyed by event count + tail seq/time (attached logs are append-only), evicting detached sessions; an unchanged session now costs ~0 per search, a changed one still pays one full recompute. Verified: repeat search = zero structuredClone calls (unit test) and 47ms vs 2420ms first search (reproduction against the production stores).
- ZH: 每次 `session.search` 都对每个附加会话重算 `observeLive`（全量事件的 structuredClone + 文档提取 + JSON.stringify + SHA-256）——大型附加日志（55.3 万/69.2 万事件）下每次搜索 ~12-13 核心秒，即 13s 搜索的实测根因。fork 按“事件数 + 尾 seq/time”为键记忆化（附加日志只追加），分离会话即驱逐；未变化会话每次搜索成本趋零，变化的会话仍需一次完整重算。验证：重复搜索 structuredClone 零调用（单元测试）；生产库复现中重复搜索 47ms vs 首次 2420ms。

### 2026-08-27 — OnePlus 13 移动端体验一轮治理 / OnePlus 13 mobile UX pass

- EN: A phone-viewport pass over the web client verified in a real browser at 412×915 (Agent Note `2026-08-27-oneplus-13-mobile-ux-pass`): the session-header breadcrumb gets a 88px floor and header actions shrink with ellipsis instead of crushing it; composer/sidebar/workspace/settings/goal controls gain ≤560px thumb floors (32–40px); the settings modal portals to `document.body` (the transform-animated drawer would pin it to 320px); the job popover becomes a fixed bottom panel on phones; HoverCard gains a long-press touch path with viewport clamping. Desktop breakpoints untouched; 94 files / 1487 client tests green, client typecheck and lint green.
- ZH: 面向 Web 客户端的手机视口一轮治理，在真实浏览器 412×915 下往返验证（Agent Note `2026-08-27-oneplus-13-mobile-ux-pass`）：会话 header 面包屑获得 88px 底线、header actions 以省略号收缩而不再把它压成 16px；composer/侧栏/工作区/设置/goal 控件获得 ≤560px 拇指底线（32–40px）；设置弹层 portal 到 `document.body`（带 transform 动画的抽屉会把它钉在 320px 内）；job 弹层在手机上变为固定底部面板；HoverCard 增加长按触控路径并 clamp 在视口内。桌面断点不变；94 文件 / 1487 客户端测试全绿，client typecheck 与 lint 全绿。
- EN: Follow-up fix — the mobile drawer opener and the details-sheet close were invisible in the light theme (white glyph on the white floating fill: `button-floating-fill` + `label-primary-inverted`, the dark-surface pairing). Both now pair `label-primary` glyph + `border-l2` hairline + `shadow-lv2` like the desktop scroll-to-bottom button; sheet close also grows 24→32px. Verified in light and dark themes.
- ZH: 追加修复——移动抽屉入口与 details sheet 关闭按钮在浅色主题下不可见（白底白图标：`button-floating-fill` + `label-primary-inverted`，实为深色底配对）。两者现改为与桌面「回到底部」按钮一致的 `label-primary` 图标 + `border-l2` 细描边 + `shadow-lv2`；sheet 关闭按钮同时 24→32px。深浅主题均验证。


### 2026-08-28 — layout face gains closeDrawer for app views on mobile / 布局契约新增 closeDrawer 供移动端应用视图关闭抽屉

- EN: `ILayout`/`LayoutController` gain `closeDrawer()` (delegates to the layout store's `setDrawerOpen(false)`). The mobile drawer overlays the single-track center column; app views (dsh-app-views) occupy that column, and the drawer must close like it does on session selection. dsh-app-views v0.1.4 calls it on view open. UI-layout README updated in the same commit.
- ZH: `ILayout`/`LayoutController` 新增 `closeDrawer()`（委托布局 store 的 `setDrawerOpen(false)`）。移动端抽屉覆盖单轨中间列；应用视图（dsh-app-views）占据该列时，抽屉需要像会话切换时一样关闭。dsh-app-views v0.1.4 在视图打开时调用它。ui-layout README 同提交更新。

### 2026-08-28 — Mobile trim: session-log capsule and commit badge off the phone chrome / 移动端精简：session log 胶囊与 commit 徽标移出手机 chrome

- EN: Phone chrome drops two desktop-only surfaces: the session-log export capsule in the header utilities (`display: none` ≤560px; the `/export` command and its shared dialog stay available) and the sidebar brand row's commit-hash badge (`display: none` ≤560px). Workspace drag-and-drop was left as is: HTML5 DnD never activates on touch. The message icon-actions time label (`timeStart`/`timeEnd`, always visible on touch devices) also elides at ≤560px — it previously pushed past the 412px viewport with long run-duration strings.
- ZH: 手机 chrome 去掉两块桌面专属表面：header utilities 的 session log 导出胶囊（≤560px `display: none`；`/export` 命令与弹窗仍可用）与侧栏品牌行的 commit hash 徽标（≤560px `display: none`）。工作区拖拽保持原样：HTML5 DnD 在触屏上从不激活。消息图标操作行的时间标签（`timeStart`/`timeEnd`，触屏设备常显）在 ≤560px 下省略号化——此前长运行时长字符串会冲出 412px 视口。

### 2026-08-28 — Brand fallback renamed to plain DSH / 品牌兜底文案改为 DSH

- EN: The generic client brand (sidebar fallback brand name, default document title, `apps/web` index title and Vite default) reads `DSH` instead of `DSH Local Build`. The build-revision badge keeps its existing desktop/mobile behavior. Affected tests and snapshots updated; ui-sidebar/ui-renderer/apps-web suites green (97 tests) and client typecheck green. The deployment title (`DSH_CLIENT_TITLE`) still overrides the default.
- ZH: 通用客户端品牌（侧栏兜底品牌名、默认文档标题、`apps/web` index 标题与 Vite 默认值）从 `DSH Local Build` 改为 `DSH`。构建版本徽标保留原有桌面/移动端行为。相关测试与快照已更新；ui-sidebar/ui-renderer/apps-web 套件全绿（97 用例），client typecheck 全绿。部署标题（`DSH_CLIENT_TITLE`）仍可覆盖默认值。

### 2026-08-28 — dsh-ext-nolan extension monorepo stays local-only / 扩展插件 monorepo 保持纯本地引用

- EN: `dsh-ext-nolan` (the personal, self-contained collection of DSH web plugins: dsh-app-views, dsh-github-inbox, dsh-herdr, dsh-rewind) is NOT tracked by this fork: the repo is going private, and a submodule pointing at a private repo would break clones. A submodule added earlier the same day was removed; the local checkout instead links the tree with a symlink (`dsh-ext-nolan` → `/root/code/dsh-ext-nolan`, listed in `.git/info/exclude`). Profiles install packages from that tree via `link:` paths.
- ZH: `dsh-ext-nolan`（个人自包含的 DSH Web 插件集合：dsh-app-views、dsh-github-inbox、dsh-herdr、dsh-rewind）不由本 fork 跟踪：该仓库将设为私有，指向私有仓库的子模块会破坏克隆。同日早些时候添加的子模块已移除；本地 checkout 改用符号链接引用该目录（`dsh-ext-nolan` → `/root/code/dsh-ext-nolan`，记入 `.git/info/exclude`）。profile 通过 `link:` 路径从该目录安装插件。

### 2026-08-28 — Client history pages shrink to 8 turns for faster cold opens / client 历史页缩至 8 回合以加速冷打开

- EN: `PAGE_MESSAGES` drops from 25 to 8. The host read cost scales with the page's event count (decode is CPU-bound), and a 25-turn page of a tool-dense conversation reads ~270k events (~1s) while an 8-turn page reads ~90k (~0.35s); the client fold/render shrinks the same way. Older turns page in through the unchanged load-older path. Client-only: takes effect on a browser refresh, no restart.
- ZH: `PAGE_MESSAGES` 从 25 降到 8。host 读取成本随页事件数线性增长（解码是 CPU 界），工具密集对话的 25 回合页要读 ~27 万事件（~1s），8 回合页只要 ~9 万（~0.35s）；client 端折叠/渲染同比例缩小。更早的回合走不变的 load-older 路径翻页。纯 client 侧改动：刷新浏览器即生效，无需重启。

### 2026-08-28 — Absorb upstream 0.1.2-alpha.1 (1079 commits, session-controller restructure) / 吸收上游 0.1.2-alpha.1（1079 提交，session-controller 重构）

- EN: Merged upstream/master into the fork: api-proxy -> packages/api/session-controller + gateway, host webserver with gzip, Turn Process fold, client/ui reorganizations. 123 conflicts resolved (26 upstream-only, 13 deleted apiproxy files, client/UI/manifest batches resolved in parallel, 15 import-migration tests). Fork features ported or confirmed absorbed: wire chunk packing (upstream now packs history pages itself); HTTP compression (upstream webserver gzip; fork zstd remains a later enhancement); messageCut indexed page cuts ported into SessionHistoryController (tryIndexedPage + paginateSuffix, full-observation fallback), including the session-key fix for the upstream numeric events.session_id; search live-observation memo survived; PAGE_MESSAGES=8 (from upstream 50); mobile drawer merged into upstream AppFrame; fork TurnFold UI superseded by upstream Turn Process fold; serving-authority trust preserved (trustedAuthorities/isServingAuthority, scope reads isLoopback).
- ZH: 将 upstream/master 合并进 fork：api-proxy → packages/api/session-controller + gateway、带 gzip 的 host webserver、Turn Process 折叠、client/ui 重组。123 个冲突全部解决（26 个纯上游、13 个已删除 apiproxy 文件、client/UI/manifest 批次并行解决、15 个 import 迁移测试）。fork 功能移植或确认被吸收：wire chunk 打包（上游自带历史页打包）；HTTP 压缩（上游 webserver gzip，fork 的 zstd 留作后续增强）；messageCut 索引寻址移植进 SessionHistoryController（tryIndexedPage + paginateSuffix，回退全量观察），含对上游数值 events.session_id 的会话键修复；搜索观察记忆化存活；PAGE_MESSAGES=8（上游为 50）；移动端抽屉并入上游 AppFrame；fork TurnFold UI 被上游 Turn Process 折叠取代；serving-authority 信任保留（trustedAuthorities/isServingAuthority，scope 读取 isLoopback）。
