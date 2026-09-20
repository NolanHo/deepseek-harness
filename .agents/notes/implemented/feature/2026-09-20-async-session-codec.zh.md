# Agent Note: session 日志编解码器在 libuv 线程池上解压

Status: implemented

[English](2026-09-20-async-session-codec.md) | 中文

> 范围：`@deepseek-ai/dsh-session-persistence-sqlite` 为何新增 `asyncCodec` 开关、为何只有解压离开读取线程，以及该开关的内存代价。

## 问题

分页冷读（[分页冷历史读取](../architecture/2026-08-26-paged-cold-history-reads.zh.md)）限制了历史页加载多少物理行，却没有限制加载它们的代价：该窗口内每个压缩 data 列都由 `zstdDecompressSync` 在服务该 RPC 的线程上解压。解码是这次读取中的线性部分，因此一个大页 —— 或两个并发冷读 —— 会让事件循环在整段扫描期间被占住，每个流都排在不需要 JavaScript 的工作后面。

## 决策

`asyncCodec?: boolean` 是 `SqliteSessionPersistence` 上的 `Config` 字段，按 `z.boolean().default(false)` 校验。`false` 与既有的同步路径完全一致；`true` 用 `scanRowsOnThreadPool` 构建 store，它通过 `promisify(zstdDecompress)` 解码压缩 data 列，然后对水合后的行跑同一个 `scanRows` 分类，因此两种设置把同一份存储日志变成同一批事件。

**只有解压离开线程。** 压缩仍在调用方线程上用 `zstdCompressSync`，事务持有的每次解码也一样。

**只在读事务返回之后 await 线程池。** `loadStoredLog` 与 `loadStoredFrom` 在同步的 `readTransaction` 内选出各自的行，之后才水合。同一条 `DatabaseSync` 连接无法承载两个打开的事务，而在事务内 await 会让其他操作在事务打开期间触达该连接：它们的 `BEGIN` 以 `cannot start a transaction within a transaction` 失败——需要原子性的操作在那里失败，而已打开事务自身的行与提交不受影响。因此即使开关打开，每条写路径仍用同步解码器。

**压缩不异步，因为两种帧不同。** Node 的异步 zstd 入口是流式的那个（`ZSTD_compressStream2`，写出 window descriptor），而 `zstdCompressSync` 是一次性的 `ZSTD_compress2`，其 single-segment 帧携带 `Frame_Content_Size`。用存储编解码器自己的选项 —— 它的字典与 level 3 —— 5 个探测输入在 Node 25.9.0 上全部不同：同步帧以 `28 b5 2f fd 60` 开头，异步帧以 `28 b5 2f fd 00` 开头。压缩改为异步会改变每个存储行的内容；而 `worker_thread` 要恢复逐字节相同，就得给一个前提为"不额外增加 isolate 与堆"的开关加上第二个 isolate 与堆。正是压缩保持同步，才让两种设置写出逐字节相同的物理行，`tests/async-codec.spec.ts` 逐列比对这一点。

**窗口限制的是在飞解码数，不是内存。** `HYDRATION_WINDOW = 8` 一次最多提交 8 列，但 `hydrateDataColumns` 把全部解码列累积进一个数组，而调用方仍持有压缩行，因此该路径的峰值高于同步扫描 —— 后者解一行、用一行、丢一行。

**8 是本部署实际池大小的两倍。** libuv 默认线程池为 4，且没有设置 `UV_THREADPOOL_SIZE` —— 进程环境、supervisor 程序、启动脚本里都没有 —— 因此第 4 个之后的解码在线程池队列里等待，而不是并行运行。

**覆盖面是那两条冷读路径。** append、publish、repair、truncate 的压缩，以及写事务持有的每次解码，仍是同步的。

## 备选方案

**压缩也放到线程池上。** 因上述帧差异被拒：要么两种设置不再写同样的字节，必须指定其中一个为存储格式；要么把 zstd 搬进 `worker_thread`，用额外的 isolate、堆和一份要同步维护的第二份编解码器副本换取逐字节相同。

**在读事务内 await 线程池。** 被拒：`readTransaction(async () => …)` 是自然的写法，而它产生的正是上面的事务危害而非变慢——已打开的事务在整个解码期间让其他操作的 `BEGIN` 全部以嵌套事务错误失败，而不是照常执行。

**把开关默认设为 `true`。** 被拒：`false` 让已发布的路径在字节与行为上完全一致，这正是本次改动可以二分、可以只靠配置回滚的原因；想要池化解码的部署自己设该字段。

## 影响

关闭即已发布行为。打开后，冷读在行与行之间让出，并发冷读共享线程池；解压本身的 CPU 开销不变，只是离开了读取线程，并发读之间互相重叠而不是排成一列。在本部署 63,762 事件的会话上，开启池化解码的 GUI 冷开实测 88~109 CPU·秒，关闭时为 26~29 CPU·秒（每态两次、交替进行、同一份快照；两种状态都成功打开了会话，且只有池化那两次让事件循环保持跳动）——这一结果无法由一次性同行扫描对比（同步 490~526 ms 对池化 966~1072 ms，非仓库内基准）预测，因此本部署保持开关关闭，放大原因尚未归因。没有需要迁移的格式分叉：两种设置写出相同的行，并各自能读对方写的日志，因此该字段就是回滚的全部。线程池扫描比同行的同步扫描占用更多内存；写路径的停顿不变，因为压缩与事务内解码仍在调用方线程上运行。

## 测试

`tests/compression-async.spec.ts` 把池化扫描与同步扫描对钉：混合物理日志解码出相同事件，撕裂尾、已提交损坏与畸形行的分类一致，打包的 `maxOutputLength` 上限与扫描 base 行为相同，配置后使用的是 `zstdDecompress` 入口，线程池无法解码的列留给扫描自己的分类。`tests/async-codec.spec.ts` 挂载 provider，钉住字段默认为 `false` 且拒绝非布尔值、两种设置写出逐字节相同的物理列、各自能读对方写的日志、只有配置过的 store 才调用池化解码器。`tests/page-cache-async-composition.spec.ts` 同时挂载两个 `Config` 字段，钉住组合后的 store 在连接上保持页缓存、为存储日志选择池化解码器、并在连接未保持 pragma 时让首次使用失败。

## 相关

- 塑造了这一代价的分页读取：[分页冷历史读取](../architecture/2026-08-26-paged-cold-history-reads.zh.md)
- 包 README 承载面向运维的字段表与冷读行为：[session-persistence-sqlite](../../../../packages/session/session-persistence-sqlite/README.zh.md)
- 与本开关组合的页缓存 `Config` 字段：[SQLite 页缓存 Config 字段记录](2026-09-20-sqlite-page-cache-config.zh.md)
