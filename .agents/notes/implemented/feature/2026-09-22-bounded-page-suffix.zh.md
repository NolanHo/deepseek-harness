# Agent Note: 分页历史读取加上界 —— 旧页只读自身跨度

状态：已实现

[English](2026-09-22-bounded-page-suffix.md) | 中文

> 范围：fork 的分页历史读取如何给物理后缀读取加上界、store 在有上界时给出什么保证，以及为什么短后缀绝不会被当成页面端出。[FORK_SURFACE.md](../../../../FORK_SURFACE.md) 拥有该差异的重放流程；[packages/session/session-persistence-sqlite/README.md](../../../../packages/session/session-persistence-sqlite/README.zh.md) 拥有面向运维的读取契约。

## 问题

Web GUI 的「加载更早」请求的页面终止于阅读者已持有的最旧记录（`beforeSeq`），并携带它最后看到的日志游标（`throughSeq`）。fork 的 `readIndexedSuffix` 已经为该请求算出页面的排他终点——`end = min(throughSeq + 1, beforeSeq)`——并用它定位消息切点，但后缀读取本身没有上界：`SeekablePersistence.readFrom(id, fromSeq, signal)` 一路走到 `SqliteStore.loadStoredFrom`，执行 `SELECT … FROM events WHERE session_id = ? AND seq >= ? ORDER BY seq`，并解压从页面切点到日志末尾的每一行。在本部署那条 6.7 万事件的会话上实测，每次「加载更早」解码的行数随翻页深度从 348 涨到 1345，而页面只需要其中几十行。

消费方的请求校验从另一侧暴露了这次读取的形态：它把读取尾部与请求游标（`throughSeq`）比较，而这条检查只在读取一直跑到日志末尾时成立。受限读取终止于 `beforeSeq - 1`，低于 `throughSeq`，因此该校验实际断言的是「本次改动要加上的那个上界不存在」。

## 决定

**上界是作用在物理行首个逻辑 seq 上的 SQL 谓词。** `resources/sql/select-events-from-through.sql` 在已发布的后缀语句上追加 `AND seq < ?`，并在 `src/sql.ts` 中与它并列登记；无界读取继续使用原语句。调用方给出的 `throughSeqExclusive` 原样传到 `physicalSpanFrom`，因此只有当某行的**首个**逻辑 seq 位于上界之前时它才被选中。

**跨过上界的 packed 行整行读出、再按逻辑事件过滤。** packed 行在一个物理 `seq` 下表示最多 `MAX_PACKED_ROW_MEMBERS` 个连续 delta 事件，而该列存的是其中的第一个；不存在能选中「该行的一部分」的上界。因此 `loadStoredFrom` 的两个分支都对解码后的事件套用与 `fromSeq` 相同的上界过滤，丢弃位于上界及其之后的成员。

**受限扫描未到达上界时退回无界重读。** `scanRows` 会把无法解码或不连续的行判为可移除尾部（当其后没有有效 `turn/end` 时），否则判为已提交损坏（当其后存在时）。从不越过上界的扫描看不到上界之上的 `turn/end`，因此可能少报损坏：受限扫描返回撕裂尾部，而整日志扫描会抛 `corrupt session log: invalid committed physical row at seq N`。当 `tornFrom < throughSeqExclusive` 时，读取因此退回无界重读，并返回其结果按上界过滤后的版本——绝不返回那个短后缀。这既让「绝不静默端出短页」对任意上界都成立，也让整日志分类对**严格位于上界之下**的损坏具备权威性，代价只在「撕裂行位于上界之下」这种罕见情形下与今天相同。位于上界及其之上的损坏则始终不被读取，这种不对称是有意为之：受限读取从不读取自己的上界及其之上的内容，因此 `loadStoredFrom(id, 0, 4)` 会回答 `[0, 1, 2, 3]`，而 `loadStoredFrom(id, 0)` 抛出 `invalid committed physical row at seq 4`——旧页不该为一个它从不端出的尾部付出代价或因此失败。

**受限读取报告它观测到的已存末端。** 它自己的窗口终止于客户端游标之下，因此无法回答已发布的游标检查。`resources/sql/select-max-seq.sql` 从 `(session_id, seq)` 主键上取 `COALESCE(MAX(seq), -1)`，不触碰任何行体；`scanStoredPrefix` 在选取跨度的同一个读事务内执行它——且只在给出上界时执行，因此无界读取的语句集与已发布版本完全一致。该值以 `storedEnd` 出现在 store 的后缀、SQLite 插件的 `readFrom` 与 fork 的 `SeekablePersistence.readFrom` 上：本次读取观测到的最高已存逻辑 seq，空日志为 `-1`，无界读取则为其完整校验前缀的尾部。

**计划拒绝从无法证明上界的后缀裁出页面。** 当终点不高于窗口起点时 `readIndexedSuffix` 返回 `undefined`；只有受限后缀的最后一个事件恰为 `end - 1` 时才接受它——这正是 store 自己的保证：受限读取要么稠密到达上界，要么覆盖其上界之下的整段日志。给出短答案的后端（被截断的读取）会把请求交给观测路径，而不是端出一个缺失「后缀尾到上界之间全部事件」的页面。打开窗口的计划既不带 `throughSeq` 也不带 `beforeSeq`，因此与之前一样无界读取。

**忽略上界的提供方绝不会拿到静默错误的页面。** 寻址面是结构化的，所有树内消费方现在都串上该上界并上报观测到的末端。仍在实现已发布三参数 `readFrom(id, fromSeq, signal?)` 的树外提供方会在自己的 `signal` 位置收到上界：回答已发布整尾读取的那种会被校验器响亮拒绝（`gateway/internal`，窗口越过了自己的上界），而不会据此裁出页面；不上报已观测已存末端的那种同样被响亮拒绝。把上界当作 `AbortSignal` 解引用的提供方会在快路径内抛错，请求由观测路径作答——即已发布结果，只是没有上界带来的收益。仓库处于 pre-stable 阶段；没有任何一条路径会端出上界未覆盖的页面。

**消费方按它观测到的已存末端校验受限读取。** `history.ts` 的校验会收到生效的终点与观测到的已存末端。上界低于请求游标的读取按已存末端执行已发布的游标检查——游标高于它即以相同的已发布消息失败 `gateway/bad-request`，而观测日志不可能包含的游标仍以已发布的内部错误失败——上界本身则负责该读取的稠密度检查（越过自身上界的窗口为 `gateway/internal`）。对所有无界读取以及上界高于游标的读取（即游标加一），已发布的游标检查逐字保留。这为每种请求形态恢复了已发布结果：在 1,200 事件的日志上 `{throughSeq: 3000, beforeSeq: 901}` 在两条路径上都是 `gateway/bad-request`，由 `tests/session-page-bound.host.spec.ts` 的形态电池钉住。

**不传上界即已发布行为。** 每个新参数都是可选的，且除 `signal` 外都排在最后；`physicalSpanFrom` 选择已发布的语句，按事件的过滤退化为已发布的 `seq >= fromSeq`，也没有任何计划会在原先不传上界的地方传上界。`tests/differential.spec.ts` 钉住每个 `fromSeq` 的无界相等。

## 考虑过的替代方案

**在调用方过滤整尾读取，而不是给查询加上界。** 那正是已发布行为：过滤发生时行已经解码完毕，而那正是要消掉的成本。过滤依然保留——它负责把跨界 packed 行位于上界之上的成员挡在结果之外——但它替代不了谓词。

**按 packed 行的整段跨度加上界（只选「末尾位于上界之前」的行）。** 那会丢掉成员仍属于页面一部分的行，让每个落在 packed 段内部的页面出现缺口。上界属于首个逻辑 seq，成员在解码之后过滤。

**返回短后缀、让调用方自己发现截断。** 消费方无法区分「日志在上界之下结束」与「读取提前停止」，因此短后缀要么被当成带静默缺口的页面端出，要么在日志确实缩短到上界之下的正当情形下被拒。只有持有行、能做这个区分的 store 才拥有该判断。

**继续按请求游标校验受限读取。** 游标是客户端自己最后看到的 seq，不是本次读取的契约：旧页按构造就终止在它之下，因此这条检查拒绝的恰好是本次改动要服务的读取。

**干脆不校验受限读取的游标。** 那正是本次修掉的回归：快路径对 1,200 事件日志上的 `{throughSeq: 3000, beforeSeq: 901}` 回答 `ok: true`，而观测路径以 `gateway/bad-request` 拒绝它，等于静默接受了一个失步的客户端游标。观测到的已存末端只花一次纯索引查询，且就在该读取自己的事务内。

**把上界做成新的 `Config` 字段。** 它是从请求推导出的逐次调用寻址值，不是随部署变化的可调项；计划本来就算出了它。

## 后果

旧页只读能表示自身跨度的行；对于页面位于日志深处的会话，这消掉了随深度线性增长的解码，而端出的页面不变——`tests/session-page-bound.host.spec.ts` 与新增的两条 `session-open-window.host.spec.ts` 用例通过「快路径 vs 观测路径」的对比钉住这一点。受限读取另有一次纯索引 `MAX(seq)`，只在该读取自己的事务内、且只在给出上界时执行。首页（`beforeSeq` 缺省、游标存在）以游标加一为上界：`paginateSuffix` 无论哪边都把窗口过滤到同一终点，因此页面与其接受判定完全相同，而读取不再解码活跃会话中位于客户端游标之后的事件。受限路径能作答的每种请求形态现在都在观测路径失败的地方失败：`tests/session-page-bound.host.spec.ts` 的形态电池逐条对比两条路径的完整结果，含审阅者给出的 1,200 事件日志上的 `{throughSeq: 3000, beforeSeq: 901}`、`beforeSeq === throughSeq`、`throughSeq: -1`、`beforeSeq > throughSeq`、`{5000, 4000}`，以及 0 到 3 的 `beforeSeq`。

有一点限制值得点名：packed 行解码出的成员是已退役的 `assistant/chunk` 事件，`validateStoredEvents` 会拒绝当前格式行里的这类事件。因此这样的行只能经历史分支（整日志恢复）或语句级视角读出——这就是 `tests/bounded-suffix-read.spec.ts` 用「上界落在窗口起点」（结果为空、不触发拒绝）与「再往后一个 seq」（存活成员通过点名其 seq 的格式拒绝被观测到）来钉住跨界行为，而 `tests/bounded-suffix-statements.spec.ts` 钉住行选择本身的原因。生产库的当前格式行从不含 packed 行；fork 的 legacy 行走历史分支，而该分支已被 `seekable` 挡在快速路径之外。

## 验证

`npx vitest run packages/session/session-persistence-sqlite packages/api/session-controller` → 58 文件通过 / 1 跳过，1020 中 1018 通过 / 2 跳过，含 differential 规格对每个 `fromSeq` 的无界相等。新增用例：`tests/bounded-suffix-read.spec.ts`（6 条）、`tests/bounded-suffix-statements.spec.ts`（3 条）、`tests/session-page-bound.host.spec.ts`（14 条），以及在 `tests/session-open-window.host.spec.ts` 中新增 2 条。先红后绿：陈旧游标用例与形态电池在修复前的快路径上失败——它对 `{throughSeq: 3000, beforeSeq: 901}` 回答 `ok: true`，而观测路径回答 `gateway/bad-request`。变异轮次：去掉按事件的过滤只让 packed 跨界与历史分支两条用例失败；去掉 SQL 上界只让语句级用例与「上界之下撕裂」回退用例失败；把观测到的已存末端强制为 `Number.MAX_SAFE_INTEGER` 只让陈旧游标用例与形态电池失败，而在 store 的 `select-max-seq` 答案里强制同一值则让 store 自己的已存末端用例失败。`npx tsc -b packages/session/session-persistence-sqlite/tsconfig.json packages/api/session-controller/tsconfig.host.json` 退出 0；`npx tsc -b tsconfig.host.json` 在本次触及的任何文件中都没有报错；oxlint 在本次触及的任何文件中都没有报错。对这两个包跑一次限定范围的 `--coverage`：所触及源码的新增语句（含 store 的 `-1` 分支与校验器的守卫）没有未覆盖行。

## 相关

- 本次上界所收窄的读取契约：[session-persistence-sqlite README](../../../../packages/session/session-persistence-sqlite/README.zh.md)
- 计算该上界的分页核心：[page-boundary.ts](../../../../packages/api/session-controller/src/fork/page-boundary.ts)
- 共用同一读取计划的冷打开窗口：[open-window.ts](../../../../packages/api/session-controller/src/fork/open-window.ts)
- 本次所扩展的寻址面与读取计划：[窗口化会话打开](../architecture/2026-09-11-windowed-session-open.zh.md)
