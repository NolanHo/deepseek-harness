# Agent Note: SQLite 会话存储按 revision 保留整份已解码日志

Status: implemented

[English](2026-09-21-decoded-log-cache.md) | 中文

> 范围：`@deepseek-ai/dsh-session-persistence-sqlite` 为何新增 `decodedLogCacheBytes`、为何只在同一次调用读到的 revision 相符时才复用已保留日志、上限如何计费与淘汰，以及保留刻意不承诺什么。

## 问题

一次完整读取会解压、解析、校验并冻结一个会话的每一行已存储数据，而 `SqliteStore.loadStoredLog` 每次调用都重跑这份工作。于是恢复一个会话、重连一个客户端、重新列一次 catalog，以及任何其他「打开已存储会话并读取」的消费方，都要为没有变化的行再付一次全价。代价随日志线性增长：本部署那条 66,736 事件的会话每次冷读约 3.5 秒，而每一次重复读取都会再建一份完全相同的对象图。

这份代价是通过冷 catalog listing 变得可测量的。[catalog listing 的冷读有了上限](../bug-fix/2026-09-21-subagent-listing-cold-read-bound.zh.md)记录了其背后的线上事故：一个投影缓存为冷的 422 子会话 workspace 会解码整份存储日志——每遍 423 次，共 4–5 遍——把单核钉在 100% 约 8 分钟，期间共享事件循环的所有 RPC 与流全部挂起。那条记录新增的上界限制了单次 listing 发起多少次整日志读取；它并不让一次读取变便宜，也看不到 listing 没发起的那部分读取。该事故记录下来的形态正是成本被忽略的另一半：在 422 个子会话的 workspace 上，每一遍几乎都把整个 corpus 重新解码了一遍，因为存储里没有任何东西记得它已经产出过的日志。上界限制的是单遍的读取数，保留消除的是后一遍本要重复支付的解码。

## 决策

**`decodedLogCacheBytes?: number` 是经校验的 `Config` 字段，`0` 表示关闭。** schema 为 `z.natural().default(0)`：省略该字段时不保留任何内容、每次读取都重新解码（即已发布行为），需要重复读取被直接回答的部署从自己的 profile 行开启。负数或小数值会在挂载期失败并点名该字段。

**键是会话 id；命中条件是同一次调用读到的 revision。** `loadStoredLog` 在同一个 `readTransaction` 内读取会话行，并在**查询事件行之前**就地判定：存储用这一行算出 revision，只有它与条目记录的 revision 相等时才复用该条目，因此一次命中只 prepare 一条 `select-session`、不 prepare 任何事件行语句。命中判定所用的正是该行所在的快照，且从读出 revision 到返回保留日志之间没有 await。命中返回的是首次读取恢复出的那个完全相同的冻结 `SqliteStoredLog`——元数据、inherited cut、revision、存储版本、可选的撕裂基点，以及深冻结的事件数组——因此既省去整行扫描，也省去解压、解析、校验与冻结。

**每条本地写路径都在提交后删除条目，header 物化现在也和其他路径一样推动 revision。** 追加、header 物化、已存储日志发布、修复与 truncate 都在自己的事务内推动该会话的 revision，并经 `commitSessionMutation` 提交，后者在 `COMMIT` 之后立刻删除该会话的条目。让这条校验成立的是 revision 推动；删除条目只是在上限本会淘汰它之前提前释放字节。header 物化会重写命中判定所依据的那一行，因此它也推动 revision：没有这次推动，保留日志会继续为另一个连接写入的 header 作答，甚至绕过该次读取执行的 inherited-cut 校验。`close()` 清空映射与字节计数。

**上限按解码后 JSON 文本的 UTF-8 字节计费，并按最久未使用淘汰条目。** `scanRows` 在解析之前按 `Buffer.byteLength` 累加每个 data 列的解码文本，并把总和作为 `ScannedRows.decodedBytes` 报出；这个数就是条目的计费量，因此与编解码通道无关——`asyncCodec` 开关两态下数值相同。命中会把条目重新放到最新端，一次读取若会超出上限就从最旧端开始淘汰直到装得下，而比整体上限还大的日志永不保留，因此装不下的一次读取不会把本须让位的条目淘汰掉。计费刻意只量文本、不量被保留的图：它低报该图实际占用的内存，这也是 README 把上限表述为缓存大小而非内存预算的原因。

**读取会把交出去的 header 冻结，因此保留不会把可写对象公开出去。** `restoreStoredLog` 冻结了事件图，却没有冻结 `artifact.header`，而当前格式的 codec 用展开解码结果的方式构造该 header（`{ ...decoder.header, version: 3 }`）。保留让这处遗漏变得可观察：命中会把同一个 header 对象交给同一 revision 上的每一次后续读取，于是任何调用方写一个字段都会波及全部。恢复路径现在直接冻结 header 记录本身——它的字段全是原始值，浅冻结即完整——使未命中路径与命中路径交出的都是接口所声明的不可变 `SqliteStoredLog.meta`。

## 命中保持的不变量

**I1 —— 保留是 opt-in，关闭态就是已发布路径。** 省略上限或上限为 `0` 时不保留任何内容：两次读取产出不同的日志、不同的事件数组、不同的事件对象，包括那条本会被计费为零字节的仅 header 会话。证据：`tests/decoded-log-cache.spec.ts` 的 `retains nothing when the ceiling is omitted`、`defaults to 0 and accepts a size`、`rejects a negative or fractional ceiling`，以及 `hands the configured ceiling to the store behind the mounted service`（挂载出来的 provider 自身——而不只是直接构造的 store——也会用保留日志作答）。

**I2 —— 命中要求同一次调用读到的会话行 revision。** 证据：`answers a repeat read of an unchanged session with the same frozen log`——第二次读取是同一个对象，其事件数组是同一个已冻结对象，`meta`、`inheritedEventCount`、`revision` 与 `storedVersion` 全部相等——以及 `tests/hit-no-event-read.spec.ts`：它要求判定在同一事务内、事件行查询之前做出，且这次读取按它读到的那份快照作答。

**I3 —— 本连接自己做的写入不可能由保留来回答。** 证据：`drops the retained log after a local append and serves the appended events`、`drops the retained log after a truncate`、`drops the retained log after a cut at the stored end`（什么都不丢的截断同样提交一个 revision）、`drops the retained log after a repair of a torn tail`、`drops the retained log when a migration is published over it`，以及 `drops the retained log when a header materialization commits`。

**I4 —— 另一个连接或进程做的写入不可能由保留来回答。** 证据：`misses when another connection bumps the revision or writes rows`——一次不改任何行、只推动 revision 的带外操作会让下一次读取未命中，而一次带外插入加推动会在下一次读取中可见。

**I5 —— 上限是硬上界，计费是字节数。** 证据：`bounds retained bytes with LRU eviction and never retains an oversized log`（恰好等于日志计费量的上限只装一条并淘汰另一条；比日志自身计费量少一字节的上限什么都不保留）、`charges UTF-8 bytes, not UTF-16 code units, so a multibyte log cannot be under-sized`（按 UTF-16 码元数设的上限会拒绝一份按字节数可以保留的日志），以及 `tests/packed-charge.spec.ts` 与 `tests/compression.spec.ts` 里针对 packed 行的用例——它们在同一份 packed 行上把两种计量分开，而 store 级用例产生不了这样的行。

**I6 —— 只有成功的读取才会被保留，失败与取消行为不变。** 证据：`retains nothing when a stored log cannot be read`（一行已提交数据损坏时两次读取抛出同一条诊断，而不是拿保留日志作答）与 `observes an aborted signal on a cached read exactly as on an uncached one`（已中止的 signal 在热、冷两个 store 上都抛 `AbortError`，且热 store 的条目在该次中止调用后仍然存活）。撕裂尾读取是一次成功的读取，按它读到的 revision 被保留。

**I7 —— 保留属于连接，随连接结束。** 证据：`retains nothing across close and a fresh store over the same file`——重新打开的 store 建出一份相等但不同的日志，随后保留这一份。跨进程一致性不在契约之内；见「影响」。

**I8 —— header 在命中与未命中两条路径上都是不可变的。** 证据：`answers a repeat read of an unchanged session with the same frozen log`（命中的 header 就是未命中的那个对象，且已冻结）、`does not let one caller write into the header every later read shares`（写 header 字段会抛错，下一次读取返回未变的 header），以及 `retains nothing when the ceiling is omitted`（关闭保留时的未命中同样交出已冻结的 header）。

## 备选方案

**只靠本地失效，不做 revision 校验。** 只在自己写入时删除条目的 store，会为自己从未做过的写入返回陈旧事件：本包支持多个连接与多个进程共用一个数据库文件，而 revision 是读取判定行是否移动过的唯一信号。这条校验依附于读取本来就要取的那一行，因此不花任何语句。变异轮次说明了哪一半在承重：去掉比较会让带外写入用例失败，而只去掉提交后删除则什么都不会失败。

**承诺跨进程一致性，包括带外 SQL。** revision 能覆盖本提供方的每一次写入，而本 store 能负担得起的任何读取期校验都无法区分「日志未变」与「另一个写方改写了行却没有推动 revision」。因此本设计对绕过提供方的写方不作任何承诺，README 记录了其代价：在该会话的条目被淘汰之前，保留日志会掩盖带外物理损坏，收缩保护的损坏判定也被一并掩盖。

**把多份日志拼成一次解码。** Node 的 zstd 接口每次调用只解一帧——两帧拼接后解压只会得到第一帧的内容，且不报错（在 Node v25.9.0 上核对）——拼批就需要帧边界与一份本 store 不拥有的尺寸账目，而兄弟通道的池化解码已经在重叠并发的解码。拼批还会在任何一份被计费之前同时持有多个已解码对象图，而这正是保留想要避免的状态。

**先读会话行，让命中省掉事件行扫描。** 已采纳，但落在**现有事务内**而非另开一个事务：判定被提前到同一个同步 `readTransaction` 回调中、事件行查询之前，因此命中在 prepare 任何事件行语句之前就返回。单独开一个只读 revision 的事务只会多出一个快照和未命中路径的一次往返，换不到更多节省。在合成的 66,000 事件会话上，命中中位从 80.6 ms 降到 0.025 ms，二十次命中零条事件行语句，冷读不变；`tests/hit-no-event-read.spec.ts` 钉住这些语句计数。

## 影响

对未变化会话的重复整日志读取，返回的是首次读取产出的那些对象。在本部署那条 66,736 事件的会话上，重复读取实测 3.5 秒 → 0.30 秒（约 11×），两次命中是同一个冻结对象（`identitySame: true`）；第二次之后的读取仍是同一次命中。复用判定移到事件行查询之前后，一次命中只付一行带索引的会话行读取：在上述合成会话上实测中位 0.025 ms、p95 0.342 ms，而此前为 80.6 ms。内存：该会话的日志被计费 252.2 MB 解码后 JSON 文本，而在同一次实测里，进程 heap 在开启缓存时约 0.69 GB、关闭时约 1.96 GB——保留把一份不断堆积却已无人引用的解码图，换成了它唯一持有的那一份。

两条限制属于设计本身，包 README 以面向运维的措辞给出：计费是被保留内存的下界，且不限制零字节条目的条数；绕过提供方的写方在条目被淘汰前可能被掩盖。保留也是按连接的：同一文件上的两个 store 各解码一次，它们只能通过 revision 校验看到彼此的写入。本包为 fork 自有，因此本次改动不会在其自身文件之外新增任何合并面，fork 清单登记了该字段、store、计费与规格。

## 测试

`packages/session/session-persistence-sqlite/tests/decoded-log-cache.spec.ts` 共 24 个用例：`decoded log cache` 块 21 个，钉住 I1–I8；`decodedLogCacheBytes configuration` 块 3 个，分别钉住 schema 默认值、对 `-1`、`1.5` 的拒绝，以及挂载出的插件把上限传给自己的 store。`tests/decoded-text.ts` 独立于被测代码解码存储的 data 列，因此上限用例所依赖的字节测量不是从实现里读回来的。跨连接用例把同一份存储状态分别经保留 store 与无缓存 store 读出并比较内容，因为单独的否定断言会被本地提交后删除满足，无法区分 revision 推动与「删除条目」；一条已热条目对应的会话行被带外删除时必须什么都不返回，而不是返回保留日志。packed 行计费另有覆盖，因为 store 级多字节用例存不下 packed 行：`tests/packed-charge.spec.ts` 用一份 schema-19 fixture 经迁移链读回带多字节文本的 packed 行，并用三个上限把计费钉成恰好等于字节数；`tests/compression.spec.ts` 另有一条直接断言累加器的 `scanRows` 用例。`tests/hit-no-event-read.spec.ts` 补上语句层与快照层的对照：它用 `vi.mock('node:sqlite')` 驱动记录 store prepare 与直接执行的 SQL，要求冷读恰有一条事件行语句、一次会话键查询、一对 `BEGIN`/`COMMIT`，命中则前两者为零、事务对相同；同一文件还在事件行查询之前注入一次已提交的外部写入，要求这次读取按它读到的快照作答——因为没有任何对象层断言能区分「扫了再丢」与「根本没扫」。

变异轮次（针对这份源码独立施加、逐个进行、每次都在下一次之前还原）：从命中路径去掉 revision 比较，让带外写入用例失败；把复用判定挪回事件行查询之后（即改动前的顺序），让 `tests/hit-no-event-read.spec.ts` 失败；完全不读会话行就回答命中，让该用例的 `select-session` 断言失败；命中路径顺手取一次整数会话键，让该用例的 `select-session-key` 断言失败；把 `Buffer.byteLength` 换成 `String.length`（UTF-16 码元）会让被改那处所属的用例失败（scalar 行那处让 `tests/decoded-log-cache.spec.ts` 的 store 级多字节用例失败，packed 行那处让 `tests/packed-charge.spec.ts` 与 `tests/compression.spec.ts` 的 `scanRows` 用例失败）；把 packed 行的累加改成赋值会让 `tests/packed-charge.spec.ts` 失败——它的上限钉住的是总计费，而不是落在窗口内的某个值；去掉「超限即不保留」判定，让 `does not evict a retained log to make room for one that cannot fit` 失败；去掉淘汰循环，让 `bounds retained bytes with LRU eviction and never retains an oversized log` 失败；去掉命中时的 LRU 刷新，让 `keeps a repeatedly read session when a third one arrives` 失败；去掉 header 物化的 revision 推动，让 `misses when another connection materializes a header over the cached session` 失败；去掉 append、publish、repair 或 truncate 的 revision 推动，各自让 `agrees with an uncached reader across another connection's writes` 失败（repair 那处让撕裂尾变体失败，truncate 那处让落到存储末尾之前的删除型截断失败）；让插件构造 store 时丢掉配置的上限，让 `hands the configured ceiling to the store behind the mounted service` 失败；去掉 header 冻结，让三处「header 已冻结」断言失败。有两个变异什么都不失败，本记录把它们当作结果写下来：去掉提交后的 `forgetDecodedLog` 与去掉 `close()` 的清空只改变字节何时释放，没有任何公开观测能区分。store 在解码之后执行的 inherited-cut 校验在这些规格里没有失败态 fixture：它对这些规格构造的每种日志形态都与所比较的行列一致。

包套件通过：`npx vitest run packages/session/session-persistence-sqlite/tests` → 12 文件通过，173 中 172 通过 / 1 跳过，exit 0。

真实会话 A/B 在与生产同构的隔离实例上、针对本部署那条 66,736 事件的会话执行，缓存设置是唯一的配置差异：重复整读 3.5 秒 → 0.30 秒、两次命中是同一个冻结对象、该会话计费 252.2 MB、进程 heap 约 0.69 GB 对 1.96 GB。这些是作者本机对单机会话的观测，不是提交在案的基准，也无法仅凭本 commit 重放；本记录没有重跑它们。

以下没有任何证据覆盖：缓存没有浏览器、e2e 或录制会话快照（它返回的对象图与无缓存路径相同，因此没有任何模型可见或产品可见输出变化，也就不欠快照）；store 在解码之后执行的 inherited-cut 校验，这些规格没有任何 fixture 能触达；packed 行计费只对 `text-chunks` 钉住，因此 `reasoning-chunks` 或 `tool-call-chunks` 的 packed 行没有计费断言；同一会话上同时在飞的两个读取（条目在扫描之后才写入，因此两者都会解码；一处作者本机探针把一次带外写入交错进这个窗口，对保留读取者与无缓存读取者做了六轮比较，未发现分歧）；以及超出该条已测会话的上限内存余量。

## 相关

- 限制单遍发起多少冷读的 listing 上界：[catalog listing 的冷读有了上限](../bug-fix/2026-09-21-subagent-listing-cold-read-bound.zh.md)
- 挪走未命中仍要支付的解码的兄弟开关：[session 日志编解码器在 libuv 线程池上解压](2026-09-20-async-session-codec.zh.md)
- 包 README 承载面向运维的字段表、三条限制与冷读行为：[session-persistence-sqlite](../../../../packages/session/session-persistence-sqlite/README.zh.md)
- 该差异面登记所在的 fork 清单行：[FORK_SURFACE.md](../../../../FORK_SURFACE.md)
