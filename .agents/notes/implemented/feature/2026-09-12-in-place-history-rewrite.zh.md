# Agent Note: 编辑重发的就地历史重写——持久日志在轮次边界截断

Status: implemented

[English](2026-09-12-in-place-history-rewrite.md) | 中文

## Problem

`dsh-rewind` 插件的按钮此前点击即 fork 一个**新**会话，但用户要的是就地编辑：把某条历史 user message 的文本放进当前会话的 composer，编辑后发送——同一会话 id 随即丢弃该条消息所在的轮次及其后的所有内容，并在切点处继续。插件自身做不到：它没有 host 半身、`ctx.agents` 没有 dispose、agent 生命周期归 fiber。截断需要持久化写句柄与已销毁的 agent，因此重写必须在 host 上、与提示词接纳原子地完成。

## Decision

重写在 host 上、与接纳原子完成，意图随 prompt 请求（`rewriteFrom`）上行，而非另设 staging RPC——一次操作、一个结算点，没有需要取消的陈旧 host 状态，也不怕服务重启丢失。`commands.prompt` 通过 fork 模块 `resolveRewriteCut` 依据已存日志校验武装锚点（仅 queue；live Agent 必须 idle 且 inbox 为空；子代理会话拒绝），销毁 Agent（`disposeAgent` 释放持久化写句柄），经写句柄截断已存日志，再恢复 Agent；响应以 `rewrote` 标记。切点是最后一个不晚于武装 `user/message` 的 `turn/start` 的 seq，并**只**向前越过该消息自己的准入 `agent/inbox/spliced` 事件（别人的准入记录不归这次重写处置）——轮次边界，绝不切入轮次中间（切进轮次会让恢复把合成的中断轮次 closer 追加进新历史）、绝不进入 fork 继承前缀，也绝不留下去被替换消息的准入痕迹：该 splice 内嵌被替换的文本（客户端据此渲染出 user 气泡），而它的移除事件落在被丢弃的轮次里。上一轮运行中排队发送的消息，其准入 splice 留在该上一轮里、被切点保留（回退无法越过两者之间已提交的 `turn/end`，而中间事件也无法靠截断删除）：重写会为它补写一条移除 splice，使保留前缀折叠后没有任何 pending 项，恢复后的 driver 不会把被替换的消息重放成新轮次。重写同时丢弃该会话的投影缓存记录，缓存读路径也改为拒绝水位在目标 durable prefix 之上的行——缓存只可落后于日志、绝不可超前，而日志倒退恰好会破坏这条前提。持久化 seam 以可选成员 `SessionHandle.truncate?` 承载该能力：无法重写已提交日志的后端省略它，消费者响亮失败（`session/rewrite-unsupported`）。fork 的 SQLite 后端实现了它；随产品交付的 JSONL 后端省略它。

客户端绝不拦截发送路径：武装值存放在逐会话输入机中、草稿旁（`InputState.rewriteFrom`/`setRewriteFrom`），原生提交携带它，它随已提交草稿清空、失败发送时随草稿恢复，提交客户端在 host 回报 `rewrote === true` 时重建窗口（`resync()`）。武装提示词被接纳却没有 `rewrote` 时——与未重启的旧 host 的版本偏差——结算为可见的 `session/rewrite-missed` 失败，绝不静默追加。

## Mechanism

- **持久化**：seam 上新增 `SessionHandleTruncateOptions { signal? }` 与可选 `truncate?(toSeq, options?)`；SQLite 后端的 `truncateLog` 删除切点起的行，重写唯一跨切点的 packed 行以只保留其切点以下成员，递增一次已存 revision（FTS 与投影缓存按 revision 差对账），失败即回滚；句柄游标随之重置，收缩守卫改按已存 revision 判定，句柄自己的重写得以作为新的更短日志读通。
- **Host**：`resolveRewriteCut` 是对观测到的 header、事件、武装 seq 与 `inheritedEventCount` 的纯函数；幂等优先于一切重写步骤——live Agent 已持有的重试 requestId 直接以 `{ accepted: true }` 结算，绝不二次重写。
- **客户端**：`ClientSession.prompt` 把 `rewriteFrom` 放上 wire 请求，在 `rewrote === true` 时先重建再结算；follow 流会静默丢弃不高于自身游标的事件，因此显式 `resync()` 是唯一可信的重建路径。
- **Inbox 中和**：`planInboxRepair` 按与 inbox 投影完全相同的语义折叠保留前缀的 splice，找到武装消息的 pending 下标，返回一条带 `outcome: 'canceled'` 的移除 splice；重写通过 `SessionHandle.truncate` 的 `append` 选项把它落在切点——截断与该批次在同一事务内提交，因为把中和留给第二次 append 会在崩溃后暴露一段没有被中和的短日志。被替换文本本身仍留在保留下来的 insert 里（连续截断删不掉中间事件），但它已被中和：没有 pending 项、没有 `user/message`、不会被重放。
- **投影缓存**：重写在截断后调用 `SessionProjectionCache.discard(id)`（为没有日志可校验的零 I/O 列表读做尽力失效），而种子读（`hydratePrepared`、`coldSnapshot`）会把已存行与它将要折叠进的 durable prefix 对照校验。水位在该 prefix 之上的行是从当前日志已不存在的事件折叠出来的，不能作为种子：种下它会把已删除的消息恢复成排队项并重放成新轮次（本条规则落地前，第二实例上实测复现）。

## Alternatives considered

- **客户端拦截发送路径。** 否决：武装意图必须随原生提交上行——拦截层会分叉发送路径、自持陈旧状态，任何它漏掉的提交入口都会静默追加。
- **点击即截断。** 否决：产品决策是发送时截断；发送之前数据库什么都不写，武装值与草稿并存，取消零成本。
- **插件旁路写库。** 否决：插件没有 host 半身、没有持久化访问，且 agent 生命周期归 fiber，插件无法销毁 agent。

## Consequences

- 持久日志只承认一条已提交日志重写路径：host 发起、轮次边界、无 live writer（单写者所有权 + 已销毁的 Agent）、绝不进入 fork 继承前缀。
- 没有该能力的后端让消费者响亮失败（`session/rewrite-unsupported`）；JSONL 不实现 `truncate`，SQLite 实现。
- 正在运行的轮次或有排队的 inbox 拒绝重写，而不是取消他人的工作；已提交的重写没有 UNDO。
- 编辑后的草稿是纯文本：被替换消息的附件与引用 chip 按设计随之消失。
- 武装值是逐会话的输入机内存态，因此**页面重载会卸下武装而草稿（按会话持久化）仍在**：恢复出来的草稿会以普通追加方式发送——没有横幅提示、也不丢任何数据，用户再次点击该消息即可重新武装。已在第二实例上实测。
- 已存 `revision` 递增会使以此为键的 FTS 索引与投影/检查点缓存失效。
- 投影缓存的行水位只有在日志只增时才可作为种子下界：重写之后，切点及以上的行由缓存自身的读路径拒绝、由写入方丢弃。
- 一次重写会写入两类持久事件：截断本身，以及为中和保留下来的准入 insert 而补写的那一条 inbox 移除。两者都是在切点处的追加，都不虚构对话内容。

## Verification

由 Lead 于 2026-09-12 补录，全部命令在改动 worktree 内执行：

- `pnpm vitest run packages/api/session-controller packages/session/session-persistence-sqlite packages/session/session-projection-cache packages/client/ui-conversation packages/client/ui-chat`——在变基后的 tip 上 109 个文件 / 1710 测试全绿（1 skipped）；同一改动的早前一次运行还覆盖了 `packages/session/session-persistence` 与 `packages/session-query/session-query-sqlite`（95 文件 / 1918 测试全绿，其中包含 609 例持久化 seam 与 JSONL 契约套件）。承载本特性行为的套件：以真实 SQLite 存储 + 生产 Agent loop + 真实投影缓存运行的 `session-rewrite.host.spec.ts`（11 例）；含 `truncate` 取 0/中间/末尾、packed 行跨切点、读句柄拒绝、截断后续写的 `sqlite.spec.ts`（75 例，1 skipped）；含 `discard` 与水线规则的 `cache.spec.ts`（31 例）；客户端侧的 `session.client.spec.ts`（56 例）与 `service-orchestration.client.spec.ts`（32 例）；以及 `session-rewrite.host.spec.ts` 的「运行中排队」用例——用带闸门的首轮、把第二条提示词排进该轮、随后编辑这条消息，断言持久日志里没有它的重放、且切点处带着中和用的移除事件。
- 第二隔离 `dsh web` 实例（独立 `DSH_HOME`、独立会话库、3097 端口、worktree 源码）：发两轮、对第二条消息武装重写、确认草稿已预填且武装期间数据库无任何写入，随后编辑发送。转录只显示第一条与编辑后的消息、被替换的那条消失且无需刷新页面；存储日志结束于第一轮的 `turn/end` 加恢复标记，编辑后的提示词落在切点处；对数据库与其 WAL 做 `strings` 检索，被替换文本出现 0 次；投影缓存重折为两个轮次。本次实测发现并修掉三个缺陷：承载被替换文本的准入 splice 原本留在切点之下；agent 销毁时写下的陈旧检查点把已删除消息重新种成排队项；以及上一轮运行中排队的消息因准入 insert 非相邻而未被中和，恢复后的 driver 把它重放成新轮次（修复落地前在第二实例上复现）。三者现各有专门测试。

## Related

- 基于句柄的持久化 seam：[Handle-based session persistence](../architecture/2026-08-27-handle-based-session-persistence.zh.md)
