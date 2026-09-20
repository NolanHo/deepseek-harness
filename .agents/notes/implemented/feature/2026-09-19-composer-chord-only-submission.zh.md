# Agent Note: Web composer 仅通过 Cmd/Ctrl 组合键提交

Status: implemented

[English](2026-09-19-composer-chord-only-submission.md) | 中文

## 问题

上游 composer 按普通 Enter 即提交，输入中途误触 Enter 就把草稿发了出去。它的提交面还互不一致：普通 Enter 投递 busy-Enter 偏好，Cmd/Ctrl+Enter 投递其反面，Send 按钮跟随普通 Enter，空草稿组合键则把全部排队消息 steer 进运行中的回合——按下哪个键决定了消息是排队还是打断。上游没有任何能把 Enter 降级为换行的设置。fork 对这个面的第一次尝试（[单一 composer 提交路径](../../archived/feature/2026-08-28-composer-submission-chord-and-button.md)）在 0.1.5-rc.2 同步中退役，因为上游的 `BusyEnterBehavior` 设置、`submit()` 手势与 `steerQueue` 取而代之。

## 决策

普通 Enter 与 Shift+Enter 插入原生换行；仅 Cmd/Ctrl 组合键提交，并经 `resolveSubmitMode(busyEnter, running, 'enter', steeringAvailable)` 解析——与 Send 按钮完全相同的模式，绝不经上游取反的 `accelerated` 手势。[FORK_SURFACE.md](../../../../FORK_SURFACE.md) 登记该行；带标记的编辑为：

- `input/editor/keymap.ts` 在 IME 守卫与菜单仲裁之后对非组合 Enter 返回 `false`，按键因此落回 `@lexical/plain-text` 的换行；null 事件的合成 Enter 仍提交。
- `skeleton/InputBar.tsx` 传入常量 `'enter'` 手势，删除空草稿整队列 steer 分支，并连同喂养两者的 `canSteerQueue` 派生一起移除 placeholder 提示（`placeholder.steerQueue` 两份字典键随之删除）。空草稿组合键转而遭遇 machine 的空草稿拒绝。
- `client/locales.ts` 重写两份字典的 `settings.enter.description`：该设置同时作用于组合键与 Send 按钮。

`submission-policy.ts`、`contract/composer-submission.ts`、`facade.ts`、`hub.ts` 与 `machine.ts` 保持上游原样：`accelerated` 手势保留其直测单元覆盖，`steerQueue` 经 `service-orchestration` 覆盖存活于 shell 接口。QueueDock 的逐行 Steer 仍是从队列进入运行中回合的唯一路径。

## 备选方案

**保留空草稿整队列 steer 组合键。** 组合键成为唯一提交手势后，连按两次——先发送、草稿随即为空——会在默认 Queue 偏好下把刚排队的消息 steer 进运行中的回合，正是本次要消除的事故类别。2026-08-28 的 note 删除该手势时得出过同一结论。

**把提交键做成 Settings 开关。** 所有者拒绝：写死的行为让 fork 面最小——无需在每次同步时重新施加设置行、持久化与双语文案——而且"仅组合键提交"正是本部署想要的。

**从 `resolveSubmitMode` 移除 `accelerated` 手势。** 补丁会扩散进 `submission-policy.ts`、`contract/` 与所有直测 policy 的用例，而这个手势再无其他产生方。保持上游 policy 原样使该文件在每次同步中零冲突。

## 影响

误触 Enter 变为插入换行而非发送；一条投递规则——busy-Enter 设置——覆盖所有会话状态下的组合键与 Send 按钮，设置行文案同时点名两者。代价：纯键盘提交必须使用组合键；整队列的键盘 flush 没有了（QueueDock 逐行 Steer 仍在）；用普通 Enter 提交的 Web e2e 场景改按 Control+Enter。`steering.e2e.ts` 中钉住取反组合键与整队列手势的三个 describe 被 fork 跳过并在文件内留有恢复路径，`subagent-interrupt-ui.e2e.ts` 改为等待默认 placeholder，`queued-image` 与设置对话框金句携带新的 placeholder 与设置文案；重新录制被跳过的场景需要 `DSH_SNAPSHOT=record`，只有该面退役时才值得。

## 测试

`keymap-routing.client.spec.tsx` 通过真实 Lexical 命令层钉住普通 Enter 换行与仅组合键提交。`input-bar.client.spec.tsx` 钉住组合键在空闲与运行中的首选模式投递、空草稿在排队会话与可继续 child 会话上的 no-op，以及取代 steer 提示的 placeholder 回落。`pnpm run test:gui` 全绿，仅有两例在 HEAD 上已证明预先存在的 `ui-tool` 失败。

## 相关

- 已退役的第一次尝试，在此以修订形式取代：[单一 composer 提交路径](../../archived/feature/2026-08-28-composer-submission-chord-and-button.md)
- Send 按钮经同一模式解析：[运行中 Send 按钮跟随 busy-Enter 设置](../bug-fix/2026-09-04-busy-send-button-follows-enter-setting.zh.md)
- 保留的队列进回合路径：[将排队的 Web 消息 steer 进活动回合](../../archived/feature/2026-07-30-web-queue-steer-action.md)
