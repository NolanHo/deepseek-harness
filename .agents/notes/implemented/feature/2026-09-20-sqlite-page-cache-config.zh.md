# Agent Note: SQLite session 存储的页缓存来自经校验的 Config 字段

Status: implemented

[English](2026-09-20-sqlite-page-cache-config.md) | 中文

> 范围：`@deepseek-ai/dsh-session-persistence-sqlite` 为何暴露 `cacheSizeKib`、其值为何替换进 pragma 语句而不能绑定，以及连接的读回保证。

## 问题

provider 打开的每条连接都只携带 SQLite 编译期的页缓存建议值 —— `-2000` KiB，约 1.95 MiB —— 且没有任何字段可以改它。session 存储拿到多少页缓存属于随部署而变的可调项，本仓库把这类值放进经校验的 `Config` 字段（[规则](../../../../AGENTS.md#conventions)）；想换一个大小就得改包代码，并在每次上游同步时重新施加该改动。

## 决策

`cacheSizeKib?: number` 是 `SqliteSessionPersistence` 上的 `Config` 字段，按 `z.number().step(1).min(0).max(MAX_CACHE_SIZE_KIB)` 校验。`configurePageCache` 在 `openDatabase` 内、journal 模式与持久化设置之后施加它，因此 provider 交出的每条连接各自携带自己的值。

**缺省或留空不执行任何 pragma**，所以不设该字段的部署 —— 或把 `cordis.yml` 中的值留空（以 null 传入）—— 保持 SQLite 的默认建议值，对连接不做任何改变；该字段是开关的开启态，而不是新的默认值。

**该值替换进语句，绝不绑定。** SQLite 的 pragma 语法不接受参数 —— 在 Node 随包的 SQLite 3.51.3 上 `PRAGMA cache_size = ?` 以 `near "?": syntax error` 失败 —— 因此 `resources/sql/cache-size.sql` 声明 `PRAGMA cache_size = -?`，由 `sql('cache-size', n)` 替换该 token。替换仅限这一处：`sql()` 重载只允许 `'cache-size'` 带实参，其他资源名带实参是编译错误，`tests/sql-resource-boundary.spec.ts` 拒绝 `src` 与 `tests` 中任何实参未跟在 `'cache-size'` 名称之后的 `sql`/`testSql` 调用。

**施加结果要验证，不靠信任。** 连接读回 `PRAGMA cache_size`，若未保持 `-cacheSizeKib` 就拒绝本次打开，并报出实际保持值与期望 KiB；失败的连接会被关闭。该比较对 `0` 无需分支：在 `===` 下 `-0` 与 `0` 相等。

**`0` 是 SQLite 的零页建议值。** 连接施加 `-0`，SQLite 把它钳到 10 页下限。它不是 2,000 KiB 默认值，也不是调用方恢复默认值的方式。

**字段上限为 `MAX_CACHE_SIZE_KIB = 2_147_483_647`**，即它承载的 INT32_MAX 量级。SQLite 也接受字面量 `-2147483648`（比该量级大 1），而字段永远不会发出它。

**三项物理设置刻意未动**：`mmap_size = 0`（内存映射 I/O 相对截断带有 SIGBUS 语义，且连接的读回在文件支撑的连接上钉住该值）、`synchronous = FULL`、64 KiB 的 `page_size`。三者各自牵动自己的持久化论证，因此把它们做成可配置是另一件事。

## 备选方案

**把值绑定为 SQLite 参数。** 引擎拒绝：pragma 语句不接受绑定参数，因此只有"替换"或"不加字段"两条路。

**让 `sql()` 把调用方的值替换进任何资源。** 通用插值路径会把调用方文本放进每个随包语句，schema 与事务语句也不例外。重载加边界 spec 把自由变量限制在唯一一个语法需要的语句上。

**信任 pragma，省略读回。** 被 SQLite 忽略的 pragma 会让部署跑在没人选择的缓存大小上，而字段就连接的真实取值静默撒谎。包内其他连接设置本就读回并硬失败。

**让 `0` 表示恢复 SQLite 默认值。** pragma 自身的 `0` 是零页建议值；重置语义需要第二个哨兵值，并与文档化行为背离；想要默认值的部署不设该字段即可。

**在同一轮里把 `mmap_size`、`synchronous`、`page_size` 也做成可配置。** 每一项都是自己的持久化或失败模式决策，`mmap_size` 尤其被相对截断的 SIGBUS 语义钉住；一个字段包住三者会把三个论证藏在一个名字后面。

## 影响

部署可以从 `cordis.yml` 按连接设定页缓存，取消该字段即让连接留在 SQLite 的默认建议值上 —— 不设它什么都不变。SQLite 接受但 schema 不接受的值（负数、小数、越过上限）在挂载时失败；连接未保持的值让本次打开失败，而不是静默跑在另一个缓存上。`0` 会被接受，且几乎不会是调优想要的取值，因为它落到 10 页下限。

## 测试

`tests/page-cache.spec.ts` 记录 provider 打开的每条连接，钉住：以 `1_048_576` 挂载的连接收到 `-1_048_576`；省略字段或显式 null 保持 `-2000` 且不执行任何 `cache_size` 语句；`0`、`64` 与 `MAX_CACHE_SIZE_KIB` 各自落为自己的相反数；`-1`、`1.5`、`2_147_483_648` 在挂载时被拒。`tests/sql-resource-boundary.spec.ts` 在整个包的 TypeScript 源码上钉住替换的笼子。`tests/page-cache-async-composition.spec.ts` 把该字段与 `asyncCodec` 挂在一起，钉住组合后的 store 在连接上保持所配置的缓存。

## 相关

- 包 README 承载面向运维的字段表与启动行为：[session-persistence-sqlite](../../../../packages/session/session-persistence-sqlite/README.zh.md)
- 该 provider 所在的 fork 清单行：[FORK_SURFACE.md](../../../../FORK_SURFACE.md)
- 与本字段组合的池化解码器：[异步编解码记录](2026-09-20-async-session-codec.zh.md)
