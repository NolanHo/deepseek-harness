# Agent Note: 延迟启动批次、侧栏提升稳定性与 Web 性能解剖

Status: implemented

[English](2026-08-29-deferred-boot-batches.md) | 中文

> Scope: the web client's boot phasing (`dsh-client-modules` graph composition, `dsh-client-web` boot), the workspace sidebar's recency promotion, and `ui-chat` StatsLine measurement timing. No wire-format, protocol, or persistence changes.

## 问题

线上 GUI 的实测数据（Chrome 本地字段数据）为 LCP 3.82 s、CLS 0.19，偏移集群约 150 条落在侧栏会话行上。对运行中部署的测量归因如下：

- **传输**：boot combo 请求把全部客户端 bundle 放在一个响应里——未压缩约 6.8 MB（54 个包；其中 12 个第三方插件约 2.5 MB）——而 webserver 的压缩默认值是 `none`。走域名路径（WireGuard → traefik → Caddy）时原始字节量主导 LCP。
- **启动门**：`boot.ts` 先创建全部 Loader 条目并断言全部激活才挂载 UI 渲染器，皮肤/市场/SSH 等装饰性插件对首屏没有贡献却阻塞首绘。
- **侧栏抖动**：`nextSessionOrderAccount` 每一拍都把 `updatedAt` 有更新的会话重排序，多个会话共同流式输出时位置持续互换（即用户的 sessionRow 偏移集群；列表在指针下移动导致 Playwright 连续 57 次 `click()` 报 "element is outside of the viewport"）。
- **空闲 CPU**：第三方插件 `@changfenhuang/dsh-annotation` 每秒无条件全量轮询 `decorateAll` 扫描所有消息行；`StatsLine` 在 `useLayoutEffect` 里测省略号截断，在会话打开的提交阶段每行强制一次布局回流（374 ms 冷启动长任务中占 46 ms）。

## 决策

**延迟启动批次（配置门控，上游形态）。** `WebBootBatchPhase` 增加 `'deferred'`：`dsh-client-modules` 的 node 半边按新的 `Config.defer` 名单把 application 记录切分为 pre-mount 与 deferred combo；deferred combo 按需服务但不预加载，boot 内核只在应用挂载之后才创建其条目。两类组合矛盾响亮失败（deferred 行同时是 `immediately` 一阶段行；pre-mount 行的 `external` 请求了 deferred 包）。pre-mount 插件等待 deferred 包提供的服务时，现有的激活审计会如实呈现。失效名单（已卸载插件）只警告一次并忽略。部署在 profile patch 层点名第三方插件——机制在仓库，策略在部署。

**最近更新提升保持头部稳定。** 已在顺序头部的会话（提升头）共同流式输出时保持相对位置；只有头部之外的行一次性跳到最前（新的在前）——每个活跃突发一次提升，而不是每个更新拍重排序。进入"最近更新"视图时的完整排序与单次提升语义不变。

**StatsLine 改为绘制后测量。** 省略号测试从 `useLayoutEffect` 移到 `useEffect`：会话打开的提交不再携带每统计行一次的强制布局读；悬停提示（500 ms 延迟）不受影响——可见行为零变化。

**传输与第三方是部署本地项。** webserver overlay 启用 `compression: 'gzip'`（响应中间件本就覆盖插件路由；上游默认为 `none`）。annotation 插件的 1 s 兜底轮询通过对已安装副本的本地补丁门控在观察到变更之后（`~/.dsh/profiles/web/node_modules/@changfenhuang/dsh-annotation/client.js`），插件下次更新即失效——修复属于上游。

## 后果

- 冷加载首绘只拉取并解析 pre-mount bundle；deferred 包（压缩前约 2.5 MB）在挂载后立即到达，其槽位稍后填入。
- 共同流式的侧栏行不再互换；打开会话仍会单次提升到前。
- 冷启动长任务去掉 StatsLine 测量遍；剩余成本是 React 挂载可见会话窗口（已 memo 化且由 host 分页限定）。
- 被错误延迟的插件（pre-mount 包注入了它提供的服务）会让启动审计响亮失败而不是挂死——defer 名单是按站点裁剪的部署契约。

## 备选方案

- **按策略延迟（所有第三方包）而非配置名单**：否决——插件安装时静默重分类，且站点承载性的第三方插件会让审计失败而无处可查。
- **会话打开的 store 更新包 `startTransition`**：否决——数据经 SSE 帧路径上的 uSES 适配器到达；把外部 store 通知整体转为 transition 会改变所有流式回显的延迟。
- **聊天行 `content-visibility: auto`**：否决——自定义滚动器（`toBottom`、滚动恢复、折叠）持续读取布局；估算的固有尺寸会扰动它，而收益只是已挂载行的绘制。
- **会话窗口虚拟化**：超范围——host 窗口（page boundary）已限定挂载量，实测 374 ms 冷启动主要是 React 挂载约 215 个 memo 化行，不是布局。

## 验证

`test:gui` 291 文件 / 3852 测试；`test:web` replay lane；modules 与 boot 套件覆盖延迟切分（三类矛盾/失效场景）、两段式启动次序（deferred bundle 仅在挂载后加载）、共同流式提升稳定性。
