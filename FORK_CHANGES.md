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

### 2026-08-29 — 可禁用的浏览器认证 / Optional browser authentication

- EN: `client-connection` gains `browserAuth: false` (default true) — disables the persistent browser-session layer (launch token, cookie, 401) and keeps the Host/Origin fence as the only gate. This deployment uses it: loopback bind behind the Caddy rewrite proxy and the WireGuard-only traefik perimeter.
- ZH: `client-connection` 新增 `browserAuth: false`（默认 true）——关闭持久浏览器会话层（启动 token、cookie、401），仅保留 Host/Origin 围栏。本部署已启用：回环绑定 + Caddy 改写代理 + 仅 WireGuard 可达的 traefik 边界。

### 2026-08-29 — Turn Process 折叠恢复（部分历史也折叠）+ 更丰富摘要 / Turn Process fold with partial history and richer summary

- EN: The upstream Turn Process fold withheld controls and hid no members while older history was available (`historyIncomplete` gate), so real sessions never folded. Removed the gate (a closed Turn folds by default regardless of `hasMore`) and enriched the control: added the Turn wall-clock duration (from the `turn/start`/`turn/end` boundary) and a collapsed-prefix label (`Collapsed {counts} · {duration}` / `已折叠 …`), restyled from a full-width divider into a rounded pill. Updated the fold tests, refreshed seeded-history goldens, and raised the chat-scroll page cap for the 8-message page size.
- ZH: 上游 Turn Process 折叠在仍有更早历史时（`historyIncomplete` 门）不显示控件也不隐藏成员，导致真实会话几乎从不折叠。移除该门（已关闭回合无论 `hasMore` 一律默认折叠），并增强控件：增加回合墙钟时长（取自 `turn/start`/`turn/end` 边界）与折叠前缀标签（`已折叠 …`/`Collapsed {counts} · {duration}`），视觉由通栏分隔线改为圆角胶囊。更新折叠测试、刷新 seeded-history 金样，并提高 chat-scroll 页数上限以适配 8 消息分页。

### 2026-08-29 — 分页统一：用户消息对齐 + 回合完整边界 + 深层重试 / Paging unified: user-aligned, turn-complete boundaries, deep retry

- EN: Both history paging paths (the messageCut fast path and the observation fallback) now share one boundary walk: pages anchor at the Nth user message, widen through sourceEventSeqs, and extend back to the owning turn's opening events, so no page starts mid-turn and the Turn Process fold is stable from first render (no re-layout flicker on Load earlier). The indexed fast path retries its suffix read once at a 4096-event margin when a compaction replacement widens the cut beyond the shallow 128-event lead, instead of falling back to the full observation read.
- ZH: 两条历史分页路径（messageCut 快路径与观察回退）共用同一边界游走：页面锚定第 N 条用户消息、经 sourceEventSeqs 展宽、并回退到所属回合起始事件，页面不再从回合中间开始，Turn Process 折叠从首次渲染即稳定（消除 Load earlier 的重排闪动）。索引快路径在 compaction 替换把切点展宽超出 128 事件浅层前导时，先以 4096 事件深层边距重试一次后缀读取，不再直接回退全量观察。

### 2026-08-30 — Fork patch surface inventory / Fork 差异面清单

- EN: Added FORK_SURFACE.md (bilingual): the upstream-divergence inventory by isolation tier (fork-owned packages, config flags, small patches, semantic core changes) with the optimization plan (extract the paging core into a fork-owned module, move messageCut off the upstream persistence interface, compact marked diffs) and the sync runbook.
- ZH: 新增 FORK_SURFACE.md（双语）：按隔离层级（fork 自有包、配置开关、小型补丁、语义级核心修改）的上游差异面清单，附优化方案（分页核心抽入 fork 自有模块、messageCut 移出上游持久化接口、保持紧凑带标记的 diff）与同步 runbook。

### 2026-08-30 — Patch-surface reduction: fork modules for paging, mobile shell, messageCut / 差异面缩减：分页、移动 shell、messageCut 的 fork 模块化

- EN: Extracted the fork's upstream divergence into fork-owned modules per FORK_SURFACE.md: the user-aligned paging core now lives in `session-controller/src/page-boundary.ts` (history.ts keeps a ~60-line injection, down from 205); `messageCut` lost its upstream abstract/coordinator/jsonl surface (the concrete SQLite store keeps the indexed seek; history duck-types it); the mobile regime moved to `ui-layout/src/client/mobile-shell.tsx` (AppFrame keeps ~62 composition lines, down from 119). Upstream-owned files coordinator.ts, session-persistence/index.ts, and jsonl are pristine again.
- ZH: 按 FORK_SURFACE.md 把 fork 对上游的侵入抽入 fork 自有模块：user 对齐分页核心移入 `session-controller/src/page-boundary.ts`（history.ts 只留约 60 行注入，原 205 行）；`messageCut` 移除上游抽象/coordinator/jsonl 桩（具体 SQLite store 保留索引查询，history 以 duck-typing 发现）；移动端机制移入 `ui-layout/src/client/mobile-shell.tsx`（AppFrame 只留约 62 行组合，原 119 行）。coordinator.ts、session-persistence/index.ts、jsonl 回归上游原状。


### 2026-08-29 — Headless Host refuses file-open clicks fast with a localized notice / 无桌面主机快速拒绝文件打开点击

- EN: `session/openWorkspacePath` now consults the deployment's own `canOpenPath()` probe (config `nativeOpen`, injected opener, or platform detection) and fails fast with `desktop unavailable` instead of spawning `xdg-open` on a Host that cannot reach a desktop — previously a headless deployment relayed the platform's `no "view" rule for type "text/markdown"` dump into the Chat dialog. The Chat open face maps that refusal to the locale-owned `fileOpen.desktopUnavailable` copy (zh/en); other failures keep the wire reason. Tests pin the gate (opener not spawned) and the localized mapping; session-controller and ui-deliverables READMEs updated.
- ZH: `session/openWorkspacePath` 现在先查部署自身的 `canOpenPath()` 探测（配置 `nativeOpen`、注入打开器或平台检测），不可用时以 `desktop unavailable` 快速失败，不再在到不了桌面的主机上 spawn `xdg-open`——此前无桌面部署会把平台报错 `no "view" rule for type "text/markdown"` 整段转发进 Chat 对话框。Chat 打开接口还会在第三方 `betterSidebar` 插件安装时把核心文件表面（行内引用、工具行路径）路由到其侧栏编辑器——与其已劫持的产出文件芯片一致——拒绝映射为 locale 所有的 `fileOpen.desktopUnavailable` 文案（中英）；其他失败仍转发线上原因，原生打开器保留为回落。测试钉住门控（不再 spawn 打开器）、路由与本地化映射；session-controller 与 ui-deliverables 的 README 已更新。

### 2026-08-30 — Web perf: deferred boot batches, stable sidebar promotion, post-paint stats measurement / Web 性能：延迟启动批次、侧栏提升稳定、统计行绘制后测量

- EN: Field data showed LCP 3.82 s / CLS 0.19 concentrated on sidebar rows. Four changes: (1) `WebBootBatchPhase` gains `'deferred'` — `dsh-client-modules` partitions application records by a new `Config.defer` list, the web boot creates those entries only after mount (12 third-party packages ≈ 2.5 MB off the first-paint path; named in the profile patch layer), with loud composition contradictions and stale-name warnings; (2) `nextSessionOrderAccount` keeps the leading promoted run stable while sessions co-stream — one promotion per activity burst instead of a re-sort per update tick; (3) `StatsLine` ellipsis measurement moved from `useLayoutEffect` to `useEffect` (no forced layout reads inside the session-open commit); (4) deployment-local: webserver gzip on (`/root/dsh-web/webserver-bind.yml`) and a mutation-gated patch for the annotation plugin's 1 s poll. Agent Note: `.agents/notes/implemented/architecture/2026-08-29-deferred-boot-batches.md`.
- ZH: 字段数据显示 LCP 3.82 s / CLS 0.19 集中在侧栏行。四项改动：(1) `WebBootBatchPhase` 增加 `'deferred'`——`dsh-client-modules` 按新增 `Config.defer` 名单切分 application 记录，web boot 在挂载后才创建这些条目（12 个第三方包约 2.5 MB 移出首绘路径；名单落在 profile patch 层），组合矛盾响亮失败、失效名单只警告一次；(2) `nextSessionOrderAccount` 让头部提升序列在共同流式时保持稳定——每个活跃突发一次提升而非每拍重排序；(3) `StatsLine` 省略号测量从 `useLayoutEffect` 移到 `useEffect`（会话打开提交内不再有强制布局读）；(4) 部署本地项：webserver 开启 gzip（`/root/dsh-web/webserver-bind.yml`）与 annotation 插件 1 秒轮询的变更门控补丁。Agent Note：`.agents/notes/implemented/architecture/2026-08-29-deferred-boot-batches.md`。

### 2026-08-29 — Composer submission unifies on the busy-state policy / Composer 提交统一为繁忙态策略驱动

- EN: Re-applied onto the 0.1.2-alpha.1 base: the Web composer no longer sends on plain Enter (Enter/Shift+Enter insert newlines through the Lexical editor; only Cmd/Ctrl+Enter submits). The send button and the chord share one submission path whose busy-state delivery (Queue, the default, or Steer) comes only from the persisted `ui-conversation.busyEnter` setting — the chord-inversion rule and the empty-draft whole-queue steer chord are removed (per-row strict steer stays in the queue dock). While a session runs, the primary control stays Send with an independent Stop button (ordinary and continuable subagent sessions), superseding the upstream running-draft primary-Send toggle (both notes consolidated into the new Agent Note). Settings row renamed to 繁忙时发送行为 / "Send behavior while busy". Unit + GUI suites green, typecheck green; Web e2e scenarios updated.
- ZH: 在 0.1.2-alpha.1 基线上重新落地：Web composer 不再用普通 Enter 发送（Enter/Shift+Enter 通过 Lexical 编辑器插入换行；仅 Cmd/Ctrl+Enter 提交）。发送按钮与和弦共用一条提交路径，繁忙态投递方式（Queue 为默认，或 Steer）只来自持久化的 `ui-conversation.busyEnter` 设置——「和弦取反」规则与空草稿整队列插话和弦被移除（队列 dock 的逐条严格插话保留）。会话运行期间主控件保持为发送按钮，旁边有独立停止按钮（普通与 continuable subagent 会话均如此），取代上游「运行中草稿使用主发送按钮」的切换逻辑（两份 note 已并入新 Agent Note）。设置行更名为「繁忙时发送行为 / Send behavior while busy」。单测与 GUI 套件全绿、typecheck 全绿；Web e2e 场景已同步更新。

### 2026-08-29 — Per-child cwd and skill scoping for in-process subagents / in-process 子代理的 per-child cwd 与 skill 过滤

- EN: Two additive upstream-increment patches so a delegated child can run role-isolated. `SkillRegistry.restrict({ allow | deny })` (packages/skill/skill) files a compiled filter into the calling scope's layer mirroring `ToolsRegistry.restrict`'s inherited-surface semantics (own-layer registrations exempt, chain intersection, restricted names read as nonexistent through snapshot/list/get — one filter governs the skill catalog tool's injection and loads); allow/deny are mutually exclusive and names are not catalog-validated because provider discovery is asynchronous. `SubagentStartRequest` gains `cwd` (absolute, validated, stamped over the parent's header in `childSessionMeta`) and `skillFilter` (applied as a scoped `skills.restrict()` in the child's creation window beside the existing `tools.restrict`); the in-process driver and continuation manager pass both through, the subagent seam reaches the registry structurally via `ctx.get('skills')` (no `dsh-subagent` → `dsh-skill` dependency), and a skillFilter against a registry-less composition fails loud. `SUBAGENT_DESCRIPTOR_VERSION` bumps 3 → 4: continuable descriptors record both fields, cold resume reapplies `skillFilter` from the descriptor (the persisted session header stays the cwd authority), and v3 descriptors read as unsupported. Old requests without the new fields behave identically. Agent Note: `.agents/notes/implemented/feature/2026-08-29-subagent-child-cwd-skillfilter.md`.
- ZH: 两个纯加法上游增量补丁，让被委派的子代理可以按角色隔离。`SkillRegistry.restrict({ allow | deny })`（packages/skill/skill）把编译后的过滤写入调用 scope 的层，语义镜像 `ToolsRegistry.restrict` 的继承面规则（自己 scope 的注册豁免、链上相交、被限制名字经 snapshot/list/get 读作不存在——一处过滤同时约束 skill 目录工具的注入与加载）；allow/deny 互斥，且不对照目录校验名字（provider 发现是异步的）。`SubagentStartRequest` 增加 `cwd`（绝对路径，校验后在 `childSessionMeta` 覆盖父 header）与 `skillFilter`（由 `applyChildComposition` 在子创建窗口作为 scoped `skills.restrict()` 应用，与既有 `tools.restrict` 并列）；in-process 驱动与 continuation manager 双双透传，subagent seam 经 `ctx.get('skills')` 结构化访问注册表（不引入 `dsh-subagent` → `dsh-skill` 依赖），组装中无注册表时 skillFilter 响亮失败。`SUBAGENT_DESCRIPTOR_VERSION` 3 → 4：continuable descriptor 记录两个字段，冷恢复从 descriptor 重应用 `skillFilter`（持久化会话 header 仍是 cwd 权威），v3 descriptor 读作不支持。无新字段的旧请求行为不变。Agent Note：`.agents/notes/implemented/feature/2026-08-29-subagent-child-cwd-skillfilter.md`。

### 2026-08-29 — Session-log export capsule hidden on phone widths / 手机端隐藏 Session log 下载胶囊

- EN: The phone header is trimmed to the drawer opener and tabs: `session-log-export`'s capsule (Session log download button) and the conversation breadcrumb (session title with its lineage chip) both render desktop-only via `max-width: 560px` media blocks in `HeaderAction.module.css` and `ConversationRoot.module.css`; the title stays reachable in the drawer session list. Package tests stay green (55 + 329) and both rules were verified live at 412px (hidden) and 1280px (visible).
- ZH: 手机头部精简为抽屉开关 + 标签页：`session-log-export` 的胶囊（Session log 下载按钮）与对话面包屑（会话标题及其血统芯片）均改为仅桌面展示，分别在 `HeaderAction.module.css` 与 `ConversationRoot.module.css` 中新增 `max-width: 560px` 媒体块；标题仍可在抽屉会话列表中查看。包测试保持全绿（55 + 329 用例），两条规则均已在 412px（隐藏）与 1280px（可见）实测验证。

### 2026-08-29 — Session-open interaction out of the render path + identity-stable list snapshots / 会话打开交互移出渲染路径 + 身份稳定列表快照

- EN: Field INP showed the session-row click at 240 ms with 185 ms of processing: `SessionManager.select` flushed `notifyNow`, rendering the sidebar and conversation swap inside the interaction. Selection now notifies through `markDirty` (the list projection lands in the manager's microtask batch); `ClientSessions.open`/`openSubagent` stage synchronously by calling `followCurrent` directly (it reads the manager snapshot, the projection's source), so each open still reaches its window and bursts stage every selection. `buildListSnapshot` returns the previous object on equal content (stabilized `subagentsByParent`/`jobsBySession` references), and the workspace order store keeps the previous array reference across unchanged account syncs. Measured: click handler 185 ms → 2.6 ms; ambient co-streaming rebuilds drop. Agent Note: `.agents/notes/implemented/architecture/2026-08-29-selection-staging-outside-interaction.md`.
- ZH: 字段 INP 显示会话行点击 240 ms、处理用时 185 ms：`SessionManager.select` 走 `notifyNow`，侧栏与会话切换渲染全部跑在交互内。选择改为 `markDirty`（列表投影落在 manager 微任务批次）；`ClientSessions.open`/`openSubagent` 直接调用 `followCurrent` 同步 stage（读 manager 快照即投影数据源），每次 open 仍即时触达窗口、连续 open 全部 stage。`buildListSnapshot` 内容未变时返回上一个对象（`subagentsByParent`/`jobsBySession` 引用稳定），工作区 order store 未变同步保留旧数组引用。实测：点击处理器 185 ms → 2.6 ms；共同流式的环境重建减少。Agent Note：`.agents/notes/implemented/architecture/2026-08-29-selection-staging-outside-interaction.md`。

### 2026-08-29 — Working-tree discipline: branch worktrees, land via PR / 工作区纪律：分支 worktree、经 PR 落地

- EN: AGENTS.md gains a "Working tree" section: the main checkout serves the running dsh and hosts concurrent agent sessions, so development happens on git worktrees under `.worktrees/<slug>` on their own branches, landing through PRs against `origin/master` (or clean fast-forward merges for local-only branches). Uncommitted changes left in the main checkout blocked another session's merge this day (FORK_CHANGES/FORK_SURFACE collision); the rule makes that a documented never-again.
- ZH: AGENTS.md 新增「Working tree」一节：主 checkout 服务运行中的 dsh 且承载并行 agent 会话，开发一律在 `.worktrees/<slug>` 的分支 worktree 上进行，经 `origin/master` 的 PR（或本地分支的干净 fast-forward 合并）落地。当日就发生过主 checkout 未提交改动阻塞另一会话合并的碰撞（FORK_CHANGES/FORK_SURFACE）；该规则把此事写成明令禁止。

### 2026-08-29 — Deployment activation: dsh-subagent-dispatch takes over the `subagent` tool / 部署激活：dsh-subagent-dispatch 接管 `subagent` 工具

- EN: Machine-local activation (web profile, deployment state not repo surface). The profile links `dsh-subagent-dispatch` (dsh-ext-nolan; model-alias whitelist `subagent` tool over the official `ctx.subagents` service) and disables the official generic `tool-subagent` row via a user-preset override: profile patch cannot reach agent-preset rows (they compose per session, outside the profile's entry graph), so `$DSH_HOME/.agent-presets/standard-dispatch/` is a copy of the shipped standard preset with that one row `disabled: true`, and the `agent-presets` profile config sets `default: standard-dispatch`. The plugin config carries the four-model whitelist (deepseek-v4-flash default, -pro, gpt-5.6-sol, macaron-v1-venti; single `model` parameter, provider off the tool surface). `subagent_fork`/`send_message`/`report` stay official. Re-sync obligation: upstream preset changes do not reach the copy — re-copy `presets/standard/agent.cordis.yml` over it and re-apply the single `disabled: true` after any change touching the shipped preset. Sessions resumed from before the switch keep their recorded preset (the official `subagent` tool); new sessions mount `standard-dispatch`.
- ZH: 机本地激活（web profile，部署态非仓库面）。profile 挂载 `dsh-subagent-dispatch`（dsh-ext-nolan；白名单 `subagent` 工具，经官方 `ctx.subagents` 服务），并用用户 preset 覆盖禁用官方通用 `tool-subagent` 行：profile patch 够不到 agent preset 行（preset 按会话组装，在 profile 入口图之外），故 `$DSH_HOME/.agent-presets/standard-dispatch/` 是 shipped standard preset 的副本，仅该行 `disabled: true`，`agent-presets` 的 profile config 置 `default: standard-dispatch`。插件 config 携四模型白名单（deepseek-v4-flash 默认、-pro、gpt-5.6-sol、macaron-v1-venti；单 `model` 参数，provider 不上工具面）。`subagent_fork`/`send_message`/`report` 保持官方。再同步义务：上游 preset 改动不会到达副本——任何触及 shipped preset 的变更后，把 `presets/standard/agent.cordis.yml` 重拷过去并重加那一行 `disabled: true`。切换前恢复的旧会话保留其记录的 preset（官方 `subagent` 工具）；新会话挂载 `standard-dispatch`。

### 2026-08-29 — Remote stream WebSocket negotiates permessage-deflate / Remote stream WebSocket 协商 permessage-deflate

- EN: `RemoteStreamMuxServer` gains a `perMessageDeflate` flag wired to `Config.websocketPerMessageDeflate` (default false; enabled in this deployment's profile patch): RFC 7692 negotiation on `/api/remote.mux`, `threshold: 1024` keeps live frames raw while journal `opened` frames carrying whole history windows (1.2-1.4 MB on event-dense sessions) compress several-fold. Browsers negotiate automatically; opted-out clients fall back to plain frames. Cold-open wire volume behind slow reverse-proxy paths drops accordingly; the render segment is unchanged. Agent Note: `.agents/notes/implemented/architecture/2026-08-29-remote-mux-permessage-deflate.md`.
- ZH: `RemoteStreamMuxServer` 新增 `perMessageDeflate` 构造参数接到 `Config.websocketPerMessageDeflate`（默认 false；本部署 profile patch 启用）：`/api/remote.mux` 上的 RFC 7692 协商，`threshold: 1024` 让实时帧保持原样，而承载整页历史窗口的 journal `opened` 帧（事件密集会话 1.2-1.4 MB）压缩数倍。浏览器自动协商；选择退出的客户端回落普通帧。慢速反代路径上冷打开的线上体积相应下降；渲染段不变。Agent Note：`.agents/notes/implemented/architecture/2026-08-29-remote-mux-permessage-deflate.md`。

### 2026-08-30 — Sync to dsh-v0.1.2-rc.1 / 同步至 dsh-v0.1.2-rc.1

- EN: Merged upstream tag `dsh-v0.1.2-rc.1` (656 commits; rc pinned instead of master to skip the 0.1.3-alpha stream). 66 conflicts resolved per FORK_SURFACE tiers. Notable outcomes: `session-persistence-sqlite` is now fork-owned (upstream removed it under the JSONL-only decision while keeping the seam for out-of-tree providers) and ported to the handle-based `PersistenceBackend`/coordinator seam with unchanged DB schema; the `ui-chat` ChatView reader-input attribution patch (Tier D) was dropped — upstream landed their own geometric observed-top-ledger fix; StatsLine passive measurement and PAGE_MESSAGES=8 re-applied onto upstream's refactor; the gateway permessage-deflate config survived alongside upstream's heartbeat-missed termination.
- ZH: 合并上游 tag `dsh-v0.1.2-rc.1`（656 个提交；钉在 rc 而非 master，跳过 0.1.3-alpha 流）。按 FORK_SURFACE tiers 解决 66 处冲突。要点：`session-persistence-sqlite` 转为 fork 拥有（上游按 JSONL-only 决策删除该包但为 out-of-tree 提供者保留接缝）并移植到 handle-based `PersistenceBackend`/coordinator 接缝，DB schema 不变；`ui-chat` ChatView reader-input attribution 补丁（Tier D）移除——上游落地了自己的 observed-top 台账几何修复；StatsLine 被动测量与 PAGE_MESSAGES=8 在上游重构之上重放；gateway permessage-deflate 配置与上游的 heartbeat 失联终止并存。

### 2026-09-04 — SQLite persistence adopts schema 20 with an in-place 19→20 migration / SQLite 持久化采纳 schema 20 并支持 19→20 原地迁移

- EN: `session-persistence-sqlite` replaces the schema-19 JSON-tag ignorable shim with upstream's final schema-20 design: the events table gains an `ignorable` column that doubles as the packed-row discriminator (`0` packed sentinel; scalar rows `NULL`/`1` from the envelope), SCHEMA_VERSION is 20, and the reserved `@dsh/session-persistence-sqlite/ignorable` data tag, `is_packed` column, and version-19 statement resource are removed. A one-time migration upgrades an on-disk schema-19 database inside the open transaction (`ALTER TABLE events ADD COLUMN ignorable`, packed rows marked `0`, `DROP COLUMN is_packed`, `user_version = 20`); any other version still rejects. Migration, raw-row, and envelope-column fixtures/assertions added; both session persistence suites pass (554 tests).
- ZH: `session-persistence-sqlite` 用上游最终 schema-20 设计替换 schema-19 的 JSON tag ignorable 兼容垫片：events 表新增 `ignorable` 列并兼任打包行判别位（`0` 为打包行哨兵；标量行为 envelope 的 `NULL`/`1`），SCHEMA_VERSION 升为 20，删除保留键 `@dsh/session-persistence-sqlite/ignorable` data tag、`is_packed` 列与版本 19 语句资源。一次性迁移在打开事务内原地升级磁盘上的 schema-19 数据库（`ALTER TABLE events ADD COLUMN ignorable`、打包行标记 `0`、`DROP COLUMN is_packed`、`user_version = 20`）；其他版本依旧拒绝。新增迁移、原始行与 envelope 列相关的夹具/断言；两个会话持久化套件全绿（554 项测试）。

### 2026-09-04 — Fork-module convention: extract patch logic into src/fork/ / fork 模块约定：补丁逻辑抽取进 src/fork/

- EN: Every fork patch carrying more than a one-liner of logic now lives in a fork-owned module under `<pkg>/src/fork/` (client faces: `src/client/<area>/fork/`); upstream files keep only marked injections (an import plus a call behind a `// Fork patch (FORK_SURFACE.md)` comment). Extracted this round: skill registry restrictions (`fork/skill-restrict.ts`), subagent child cwd/skillFilter (`fork/child-scoping.ts`), session list snapshot identity (`sessions/fork/snapshot-identity.ts`), session-query live-observation memo (`fork/live-observation-memo.ts`), workspace order stability (`client/fork/order-stability.ts`), TurnProcess fold summary (`chat/fork/turn-process-summary.ts`), open-file routing (`chat/fork/open-file-routing.ts`); existing modules moved in (`fork/page-boundary.ts`, `ui-layout fork/mobile-shell.tsx`). Inherent one-liners (constants, hook swaps, CSS blocks, config fields) stay inline by policy. Syncing is now: copy every `fork/` directory verbatim, then re-apply the injections registered in FORK_SURFACE.md.
- ZH: 凡超过一行逻辑的 fork 补丁都移入 `<pkg>/src/fork/`（client 面：`src/client/<area>/fork/`）的 fork 自有模块；上游文件只保留标记注入点（一个 import 加一个调用，配 `// Fork patch (FORK_SURFACE.md)` 注释）。本轮抽取：skill 注册表限制（`fork/skill-restrict.ts`）、subagent 子代理 cwd/skillFilter（`fork/child-scoping.ts`）、会话列表快照身份（`sessions/fork/snapshot-identity.ts`）、session-query 实时观察 memo（`fork/live-observation-memo.ts`）、workspace 顺序稳定性（`client/fork/order-stability.ts`）、TurnProcess 折叠摘要（`chat/fork/turn-process-summary.ts`）、文件打开路由（`chat/fork/open-file-routing.ts`）；既有模块迁入约定目录（`fork/page-boundary.ts`、`ui-layout fork/mobile-shell.tsx`）。内在一行式改动（常量、hook 互换、CSS 块、配置字段）按政策保持内联。同步操作变为：原样搬移所有 `fork/` 目录 + 重放 FORK_SURFACE.md 登记的注入点。

### 2026-09-05 — Deliberation crate adopted from the Kanon docs workspace / 从 Kanon docs 工作区收编审议 crate

- EN: Adopted the `deliberations/masked-tool-payload/` crate from `/root/docs/crates/`: the DSH Web GUI first-screen tool-payload masking roundtable (collective-intel DeliberationRecord, research evidence, fact arbitration, persona stances/discussions/proposals/votes) plus the SYNC-STATUS worklog of the 0.1.2-alpha.1 upstream absorb (session-chunk-rows). Fork-owned top-level `deliberations/` directory; docs-only Tier-A addition, no upstream-owned file touched.
- ZH: 从 `/root/docs/crates/` 收编 `deliberations/masked-tool-payload/` crate：DSH Web GUI 首屏 tool payload masking 圆桌（collective-intel DeliberationRecord、证据研究、事实仲裁、persona 立场/讨论/提案/投票）与 0.1.2-alpha.1 上游吸收（session-chunk-rows）的 SYNC-STATUS 工作日志。fork 自有顶层 `deliberations/` 目录；纯文档 Tier-A 增量，未触及任何上游文件。

### 2026-09-05 — Coalesce ambient session-activity list rebuilds / 合并环境性会话活动触发的列表重建

- EN: Browser profiling showed the session-list derivation chain (buildListSnapshot + lineage/order/subagent snapshots) burning ~9% of main-thread time with zero interaction — other running sessions' `api-session/activity` events rebuild the whole list per event render, and every interaction's INP lands on top of that churn (measured keystroke 104 ms). `sessions/fork/coalesced-refresh.ts` buffers ambient activities per session (latest timestamp wins) and flushes at most every 200 ms; lone activities still apply immediately, so the synchronous staging contract and single-event freshness are unchanged.
- ZH: 浏览器剖析显示会话列表推导链（buildListSnapshot + 血缘/排序/子代理快照）在零交互时仍占主线程约 9%——其他运行中会话的 `api-session/activity` 事件每次渲染都重建整个列表，所有交互的 INP 都叠在这条链上（实测击键 104 ms）。`sessions/fork/coalesced-refresh.ts` 按会话缓冲环境性活动（最新时间戳生效）并至多每 200 ms 冲刷一次；单条活动仍立即生效，同步暂存契约与单事件新鲜度不变。
