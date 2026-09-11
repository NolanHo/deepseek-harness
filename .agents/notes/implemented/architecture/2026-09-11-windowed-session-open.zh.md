# Agent Note: 冷会话的窗口化打开快照

Status: implemented

[English](2026-09-11-windowed-session-open.md) | 中文

## 问题

Web 客户端打开一个会话要走 `session.history.follow`，而它解析的是一次完整观测：整段已存日志被解码、每个投影单元被折叠，然后从这次折叠里裁出最新一页消息。在本部署最大的会话上（1,035,641 个事件），一次打开要花数秒 CPU 和数百 MB 堆内存，而客户端实际展示的只是最新 8 条消息加一个投影切面。历史向上翻页早已不付这个代价：`page`/`loadOlder` 通过 fork 的索引寻址面（`messageCut` + `readFrom`）提供更早的页。打开快照仍走全量读取，于是每次打开都要再付一遍整段日志的代价——而任何导航之后重新打开会话都是最常见的路径。

## 决策

当挂载的持久化后端暴露 fork 寻址面、且投影缓存持有该 Session 生命周期的记录时，`follow` 用一个可寻址的后缀窗口提供冷启动的普通会话打开快照。窗口无法证明的任何情形都回落到既有的观测路径，行为不变。

### 窗口计划

`packages/api/session-controller/src/fork/open-window.ts` 驱动 `fork/page-boundary.ts` 的 `readIndexedSuffix`，复用较旧分页所用的同一套消息切点阶梯：按 append 来源用户消息做索引切点、在其下方留一个前导余量、对压缩加宽后的组头做一次深余量重试，并在窗口无法证明容纳完整一页时软退出。窗口本身就是裁出该页的那次读取，因此页尾与游标来自同一切面：网关会拒绝未在报告游标处结束的打开页。

读数计划用首次读取得到的已存 header 解析投影下限（缓存身份需要这份元数据）。下限低于窗口起点时从该处重启读取，使一次窗口同时服务页面与投影尾部；下限不低于窗口起点则无需第二次读取。

### 投影切面

`ctx.sessionProjections.restore(rows, window, fromSeq, meta, inheritedEventCount)` 从缓存检查点行出发，在接受的窗口上折叠每个已注册单元，其 `snapshot` 即线上 `projections` 块。`fromSeq` 是 restore 的 `baseSeq`；由下限扩展保证，序号不低于它的行必然可用，而该块的 `asOfSeq` 就是窗口末端——与页面、游标报告的是同一切面。

快速路径只服务最后一个回合边界为 `turn/end` 的日志：在未闭合回合内结束的窗口，其折叠结果与 `readColdSessionLog` 通过追加 `interruptedTurnClosers` 构造出的平衡视图不同，而打开块必须与完整观测的值和 `asOfSeq` 一致。窗口内完全没有回合边界时，只有从日志头部开始的窗口才能证明这一点，因此起点更靠后且找不到边界的窗口一律退出。当前单元无法播种的检查点记录（缺少 `formatVersion` 的 predecessor 世代、版本不匹配的行）出于同样理由退出：`restore` 要么从 seq 0 重新折叠，要么拒绝该行。

### 写回

没有可用记录的冷观测现在会安装一条，使*下一次*打开走窗口路径：`SessionProjectionCache.hydratePrepared` 折叠日志的**持久前缀**并把该检查点写回，软失败且发后不理（写丢了只是多回放一段尾部）。`readColdSessionLog` 会报告该前缀长度（`durableEventCount`），因为它交出的平衡日志可能带有已存日志从未持有的合成 closer；所服务的块仍然折叠整段平衡日志，只是从写回的行继续，因此只重折叠那些 closer。这些行绝不来自 `checkpoint(session)`：恢复出的 Session 会在传入日志之后一个 seq 处追加自己的 `session/end-seed` 恢复标记，而超出持久末端的行会让此后每一次以它们为种子的尾部 restore 失败。

### 激活

打开快照在请求路径之外于后台激活该 Session。观测路径直接提升它已持有的那个精确 prepared Session；窗口路径只读了持久化、没有观测对象，因此按 id 通过第二个注入回调激活（`SessionController.activate` → `ApiSessionAgentController.resolveAgent`），每次激活读一次日志。两条路径的激活簿记都由 `SessionController` 拥有。

### 注入点

Fork 自有模块：`src/fork/open-window.ts`（窗口计划与投影切面）与 `session-projection-cache/src/fork/checkpoint-read.ts`（打开路径所需的检查点读取）。上游自有文件只承载注入：`history.ts` 保留同步服务检查、窗口分支及其观测回落；`index.ts` 接线按 id 的激活；`session-projection-cache/src/index.ts` 为 fork 模块注册其私有检查点查找，并在 `hydratePrepared` 中写回刚恢复的检查点；`page-boundary.ts` 增加窗口化读取（`IndexedRead`、`readIndexedSuffix`，可选 `throughSeq` 与 `windowFloor`），`readIndexedPage` 仍委托给它。注册用的是 symbol 键属性而非实例上的 WeakMap：cordis 交给调用方的是 tracker 代理，调用方看到的服务对象并非构造函数注册的那个对象。`packages/api/session-controller/tsconfig.host.json` 列出了新源文件。

## 考虑过的替代方案

**保留完整观测再裁剪，只缓存折叠结果。** 投影缓存已能为折叠跳过检查点前缀，这正是它存在的理由。它无法跳过日志*读取*（缓存持有投影状态而非事件），而客户端可见成本主要来自物化并折叠整段日志；没有可用记录的会话仍然每次打开都付全额。作为本条 Agent Note 存在的原因被否决。

**把检查点读取暴露为缓存公有方法。** 生成的 Cordis 目录与子系统页会记录每个公有服务方法，因此新增方法会改动本次变更面之外的已生成提交文档。symbol 键注册在给打开路径提供经身份校验的行的同时，保持服务公有面与目录不变。

**写回 `checkpoint(session)`。** 它是注册表文档化的检查点面，但折叠到*Session 的*切面，而恢复出的 Session 会把该切面用恢复标记推后传入日志一个 seq——此后每次尾部 restore 都会拒绝超出已存末端的行。因此写回自行折叠持久前缀，使用冷读报告的计数。

**要求持久化抽象提供寻址面。** `messageCut` 与 `readFrom` 是 fork 自行给后端加的能力，藏在 `Partial<SeekablePersistence>` 的鸭子类型探测之后；把它们提升进抽象会改上游自有的持久化包，并强迫每个后端实现它们。鸭子类型探测保持该面为增量能力，与较旧分页快速路径已在上游成立的做法一致。

**在本地修复不平衡窗口。** 快速路径可以对窗口追加 `interruptedTurnClosers` 再折叠，但这些 closer 并非持久：它们的序号会声称日志并不持有的事件，之后的 restore 或激活会对切点产生分歧。平衡视图已由观测路径负责，因此窗口选择退出。

## 后果

对有当前格式检查点记录的会话，冷打开只读取一个有界后缀，而不是整段日志；缺失记录时首次打开会把它装上，因此第二次打开即走快速路径。客户端线上协议不变：`SessionFollowFrame.snapshot` 仍保持 `{ header, cursor, records, hasMore, projections, assistantStream? }`，且所提供的块按构造与完整观测的值和 `asOfSeq` 一致，宿主机测试用实时注册表钉住了这一点。

代价：一次打开需要可用的检查点记录与 fork 寻址面，因此 JSONL 后端的部署、以及已存尾部不平衡的会话仍走观测路径（正确但不更快）；已存日志无法触及的记录——从合成 closer 恢复的会话——会让窗口尝试持续退出，直到一次实时写入替换该行，这正是该会话在本次变更之前的行为。旧版本写入、缺少 `formatVersion` 的投影缓存记录依旧不能播种快速路径；首次打开会为下一次装上当前格式记录。

验证落在宿主机测试里：`session-open-window.host.spec.ts` 用**同一 Session 经观测路径取得的快照**作为参照钉住窗口路径结果（记录、`hasMore`、游标、投影值与 `asOfSeq`）、单次尾部窗口读取、`hasMore` 为假的全日志页、落在窗口之外的下限所对应的陈旧检查点、当前单元无法播种的记录、带写回的回退及其后一次窗口打开、后端无寻址面、页长不足、子代理、尾部不平衡、读取失败、截断、其他生命周期、缺少工作区、附加竞态、子代理栅栏等回落分支、读数计划的下限重启与深余量算术，以及经真实控制器按 id 后台激活的两条失败分支；`session-projection-cache/tests/cache.spec.ts` 钉住平衡日志与恢复日志各自的写回切点、在写回行上按下限播种的 restore、其软失败，以及该记录能被 `cachedSnapshot` 服务。冷打开的语言可见成本由基准 worker（`benchmarks/session-open`）覆盖，它组装 JSONL 后端，因而测量的是它当初为之编写的观测路径。
