# Agent Note: Remote stream mux 上报载波生命周期

Status: implemented

[English](2026-09-21-remote-stream-carrier-diagnostics.md) | 中文

> 范围：`RemoteStreamMuxServer` 为何上报慢载波与关闭、这些行为何写 `process.stderr` 而不是 `ctx.logger`，以及每类诊断的含义。

## 问题

生产环境里浏览器侧的 mux WebSocket 每约 15 秒重建一次并持续数小时，而这条路径此前一行日志都没有。traefik 记录同一 route 24 小时内 468 条连接、连接寿命中位 14.5 秒、峰值每小时 90–135 条——而 mux 说不出某条连接是因为心跳终止了沉默的 socket、因为 ready/首帧在事件循环被别处占用时来得太晚、还是因为对端或中间层关闭了它。三者最终都只呈现同一个可观测状态：socket 已关闭；事后没有任何东西能把它们区分开。

## 决策

**一个可选的诊断参数，而不是行为开关。** `RemoteStreamMuxServer` 新增第五个构造参数 `RemoteStreamDiagnostics { sink, slowMs }`。缺省时 mux 什么都不输出、行为与改动前完全一致；传入时消息由 mux 拥有、目的地由调用方拥有。`TypertGatewayService` 传入本部署的 sink 与解析后的 `diagnosticsSlowMs`。

**四类单行诊断覆盖整条载波生命周期。**

```text
api gateway: remote stream first item slow endpoint="session/events" elapsedMs=50
api gateway: remote stream heartbeat tick late driftMs=101
api gateway: remote stream heartbeat terminate missed=2 lifetimeMs=60
api gateway: remote stream socket closed code=1000 reason="peer done" lifetimeMs=1 streams=1 heartbeat=false
api gateway: remote stream socket closed code=1006 reason="" lifetimeMs=61 streams=0 heartbeat=true
```

第一行点名首帧耗时达到阈值的逻辑流（`endpoint`、`elapsedMs`）。第二行报告事件循环令心跳 tick 迟到（`driftMs`），最多每 5 秒一条，使一次卡顿不会每个 tick 重复一次。第三行报告心跳 terminate 以及该 socket 欠下的 pong 数。第四行报告每次 socket 关闭：对端或本地的 close code、截断到 120 字符的 reason、socket 存活时长、它开启过的逻辑流数，以及关闭是否由心跳造成——正是这一项把「mux 杀掉了死载波」与「载波自己走了」分开。

**阈值是经校验的 `Config` 字段。** `diagnosticsSlowMs`（`z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(3_000)`）决定首帧或迟到 tick 何时值得记一行。健康流量只产出每次关闭那一行，因此该字段的取值是在上报灵敏度与繁忙主机的日志量之间取舍；本部署的调度器、垃圾回收与网络路径决定这里「慢」的含义。

**这些行写进程的 stderr，而 sink 保持可注入。** 本仓库没有注册任何 console exporter——cordis 内置 exporter 只写内存环形缓冲——因此 `ctx.logger` 的行到不了运维日志，而本部署在 supervisor 下运行进程、由它把 stderr 折进服务日志。确有 exporter 的组合改为传入自己的 sink 而不是这个常量，测试则注入一个记录器。

**诊断只携带归因，绝不携带内容。** 任何一行都不包含 stream payload、Session id 或 Session 值；关闭原因在加引号之前按字符边界截断；心跳 terminate 行只发一次，且在 `setImmediate` 复核确认该 socket 仍欠 pong 之后——期间到达的 pong 只会留下那一行关闭日志，其 `heartbeat=false`。上报从不 await、不写 socket、也不关闭 socket。

## 备选方案

**经 `ctx.logger` 记录。** 该行会写进 cordis 的内存环形缓冲，永远不会出现在运维日志里，因为本仓库没有注册 console exporter。stderr 才是本部署已经在采集的流。

**发一条 Session 事件或一个指标。** 两者都没有消费者：本部署读文本日志，而 Session 事件会为没有任何代码查询的数据新增持久化、wire 与模型可见性表面。这些诊断是运维侧输出，不是会话状态。

**只在连接自己的 run 循环里记录关闭。** 单有一行关闭无法归因：没有 accept 时刻、没有 missed pong 计数、没有「是否心跳致死」标志，三种可能原因就依旧无法区分——正是本次要补的缺口。

**记录每一个心跳 tick 与每一帧。** 在繁忙主机上是纯粹的量，健康流量会淹没真正值得看的事件。阈值加 5 秒限流让安静主机保持沉默、让卡顿主机自行上报。

**把诊断放在需要部署打开的调试开关后面。** 这次事故之所以不可见，恰恰因为什么都没打开；阈值让主机无需任何开关即可上报自身变慢，而 `diagnosticsSlowMs` 仍允许繁忙部署抬高门槛。

**按逻辑流而非按载波上报。** 真正频繁重建的单位是载波——traefik 看到的是 468 条连接，而不是其中的流——因此关闭行属于载波，而逐流的延迟由首帧行覆盖。

## 影响

运维可以 grep `api gateway: remote stream`，并从一行日志归因一条载波的死亡。日志量随载波重建走：每次关闭一行，加上每个慢流一行首帧、以及最多每 5 秒一行迟到 tick——按本次记录到的每小时 90–135 条连接，这点量可以忽略。由于证据落在服务日志而不是指标管线里，无需新增任何采集，阈值也是部署可调项而非协议常量。

代价：`stream-server.ts` 现在承载 fork 自有的观测代码——sink 与 diagnostics 接口、诊断常量、accept 时刻/心跳致死/已开逻辑流三项跟踪，以及四处上报点——上游同步时必须重新施加；`index.ts` 承载该字段、sink 常量与构造参数。mux 的流路径本身未动。[FORK_SURFACE.md](../../../../FORK_SURFACE.md) 中的行登记了这些位置。

## 测试

`packages/api/gateway/tests/stream-server.host.spec.ts` 新增 `Remote stream mux diagnostics` 块：它以记录型 sink 驱动一个真实 mux 上的真实 WebSocket，覆盖心跳 terminate 行及其 `heartbeat=true` 的关闭行；对端关闭的 close code、reason、存活时长与已开逻辑流数；把最长 reason 截断成一行有界文本；首帧超过阈值时带 endpoint 的一行；提高阈值后首帧不再上报；健康载波除关闭行外保持沉默；以及每个限流窗口只发一条迟到 tick。`packages/api/gateway/tests/gateway-stream.host.spec.ts` 钉住该字段的默认值与 `[1, MAX_TIMER_DELAY_MS]` 边界，并通过组合后的 Host 捕获进程 stderr，端到端证明路由与行格式。

`npx vitest run packages/api/gateway/tests/stream-server.host.spec.ts packages/api/gateway/tests/gateway-stream.host.spec.ts` 两个文件共 43 个用例通过（18 与 25），新增用例在其中。事故本身的数字（每约 15 秒重建一次、24 小时 468 条连接、寿命中位 14.5 秒、峰值每小时 90–135 条）来自生产 route 自身的记录，也没有测试重放生产环境的重连循环：本次没有在本地重新观测线上 mux，面向运维的可读性是靠注入的记录器与进程 stderr 断言的，而不是靠日志管线。

## 相关

- 包 README 承载面向运维的这些行的说明：[gateway](../../../../packages/api/gateway/README.zh.md)
- 该差异面登记所在的 fork 清单行：[FORK_SURFACE.md](../../../../FORK_SURFACE.md)
- mux 的另一个传输层字段：[per-message deflate](../architecture/2026-08-29-remote-mux-permessage-deflate.zh.md)
