# Agent Note: 统一 composer 提交路径——Enter 换行，Cmd/Ctrl+Enter 与发送按钮共用繁忙态策略

Status: implemented

[English](2026-08-28-composer-submission-chord-and-button.md) | 中文

## Problem

composer 有三个提交表面、三套不同规则：普通 Enter 提交（按 busy-Enter 偏好走 Queue），Cmd/Ctrl+Enter 以相反投递方式提交，发送按钮永远排队；并且普通会话运行期间主按钮会换成停止按钮，根本无法发送。Enter 即发送还会在打字时误发；而空草稿 Cmd/Ctrl+Enter 又表示「整队列插话」——一种与提交无关的队列改写含义。由此出现的故障模式：用户以为自己在排队，消息却落进了运行中的轮次，因为投递方式取决于按的是哪个键。

## Decision

Web composer 提交只有一种模型：

- Enter 与 Shift+Enter 插入换行。只有 Cmd/Ctrl+Enter 提交；命令菜单打开时 Enter 仍会被菜单认领以选中高亮项。
- 发送按钮与 Cmd/Ctrl+Enter 和弦共用一条提交路径，`ComposerSubmissionPolicy.resolve(running, steeringAvailable)`：在支持 steering 的繁忙态之外，每次提交都是 Queue；支持 steering 的会话运行期间，持久化的 `ui-conversation.busyEnter` 偏好（默认 `queue`）同时为两者选择 Queue 或 Steer。不再有和弦取反。
- 任何可发送会话（普通会话或 continuable subagent）运行期间，主控件保持为发送按钮，旁边有独立的停止按钮；one-shot subagent 运行两者都不暴露。本决策取代并合并「运行中草稿使用主发送按钮」note：保留该 note 的修复（运行中的可操作草稿通过指针控件提交、不再误停轮次，issue #2850），把 continuable subagent 的双控件模式推广到普通会话，并反转该 note「指针操作绝不套用 busy-Enter 偏好」的约束——投递方式必须只来自设置，这样和弦与按钮才不会分叉。
- 空草稿整队列插话和弦被移除：空草稿上的 Cmd/Ctrl+Enter 与按钮一样是空操作。QueueDock 的逐条严格插话是把排队项转入当前轮次的唯一途径。本 note 合并并取代整队列手势 note：其动机、移除理由与重新引入条件记录如下，其三元组在同一变更中删除。
- 设置行文案改为「繁忙时发送行为 / Send behavior while busy」；持久化字段名与默认值保持 `busyEnter` / `queue`，遵循[偏好持久化决策](../bug-fix/2026-08-06-host-backed-web-preferences.zh.md)。

自被删除的整队列手势 note 合并而来：该手势存在，是因为空 composer 草稿没有任何键盘动作，而逐条插话多条排队消息是多击摩擦。它失败的原因是让提交和弦承载了队列改写含义，且其唯一发现表面是一条空草稿 placeholder 提示。一旦 Enter 不再发送，和弦就是唯一的提交手势，必须处处与发送按钮一致——空草稿空操作正是保持这一点。完全移除之外的选择还有：保留和弦作为整队列冲刷（拒绝：再次让和弦语义与按钮分裂），或把冲刷移到 dock 级按钮（推迟：逐条操作已存在）。放弃的能力是整队列键盘冲刷；如果该需求回归，dock 级 steer-all 控件是自然的归宿，且提交和弦不得再次被重载。完整移除通过删除 `ComposerKeyboard.steerQueue`、`InputHub.steerQueue`、placeholder 文案、`expected/steer-all` e2e 场景及其 Agent Note 三元组验证：`rg steerQueue` 与 `rg STEER_ALL` 无任何结果。

## Alternatives considered

- **保留和弦取反（和弦 = 偏好的反面）。** 拒绝：投递方式应只取决于设置；两个键上两套镜像规则正是本次要消除的混乱。
- **保留 Enter 提交，仅 Shift+Enter 换行。** 拒绝：Enter 即换行是要求的防误发措施，且 Shift+Enter 本来就是换行。
- **发送按钮保持仅排队。** 拒绝：繁忙时按钮与和弦会分叉——正是被报告的矛盾。
- **保留停止按钮作为运行中的主按钮。** 拒绝：繁忙时按钮必须像和弦一样能发送；把 continuable subagent 的独立停止模式推广到普通会话，保留停止能力。
- **保留空草稿整队列和弦。** 拒绝：它给提交和弦赋予了第二种队列改写含义（见 Decision）。

## Consequences

- 一条投递规则覆盖所有提交表面；steering 只能由繁忙态偏好产生，因此被报告的「总是插进 loop」的意外不再可能来自所按的键。
- composer 默认多行：Enter 插入换行（Lexical 编辑器此前已通过 Shift+Enter 支持多行草稿）。
- 纯键盘用户必须按 Cmd/Ctrl+Enter 才能发送——这是防误发的刻意取舍。
- 整队列键盘冲刷能力不复存在；QueueDock 的逐条严格插话仍在。
- 此前用普通 Enter 提交的 Web e2e 场景现在按 Control+Enter。`DSH_SNAPSHOT=refresh` 下，settings 对话框金样重录新的设置行文案，queue-actions、turn-tail-actions、live-interactions 与 streaming-fence 金样新增运行中 composer chrome 的禁用 `Send message` 按钮；steering 金样只拾取了 fork 自有提交带来的无关折叠文案标签。

## Related

- 逐条严格插话及其 host 边界：[Steer a queued Web message into the active turn](../feature/2026-07-30-web-queue-steer-action.zh.md)
- 偏好持久化边界：[Persist Web user preferences through Host settings](../bug-fix/2026-08-06-host-backed-web-preferences.zh.md)
