# Agent Note：跳过空转会话列表重建并放宽环境活动窗口

Status: implemented

[English](2026-09-05-ambient-rebuild-skip.md) | 中文

> 范围：`api/session-controller` 会话列表变更路径。扩展环境活动合并器（`sessions/fork/coalesced-refresh.ts`，FORK_SURFACE 行）。

## 问题

在 4,373 行生产会话上的长帧实测（CDP CPU 采样 + Long Animation Frames）显示，其他运行中会话的环境活动时间戳让会话列表重建链——`buildListSnapshot` → `flattenLineage` → `stableEntries`——每秒最多跑五次，而列表唯一可见的影响是一个以分钟粒度显示的相对时间单元格。每个时间戳都经一个无变化也照样 mint 新 summaries 数组的 mutation 应用，于是每个这样的帧都全额支付重建。

## 决策

`applyMutation` 现在在变更不翻转任何字段时返回输入数组引用（upsert 合并字段全等、移除不存在的 id、status 的 running 位相同且无 blank 翻转、activity 时间戳不更新、engaged 落在非 blank 行），`recordMutation` 在该引用不变时跳过完成通知同步与脏冲刷——空转帧完全不再重建列表。环境活动冲刷窗口从 200 ms 放宽到 1 s（`ACTIVITY_COALESCE_MS`）：时间戳以分钟粒度显示，侧栏 updated 排序可容忍一秒滞后，忙碌的旁路会话现在大约每秒只驱动一次重建链而不是至多五次。

选择逐字段增量重建之外的方案：列表投影要跨所有行摊平 lineage、子代理索引与投影值，在变更层做内容短路是最小的正确切法；完整的增量投影属于上游规模的改动。选择仅合并之外的方案：窗口只降低节奏，幸存帧仍会为一个分钟粒度的时间戳支付完整重建。

## Alternatives considered

- **仅放宽合并窗口**：降低节奏，但每个幸存帧仍为分钟粒度时间戳支付完整重建。
- **增量列表投影**：从根上正确，但重构 lineage 摊平与逐行投影——上游规模。
- **完全丢弃环境时间戳**：丢失侧栏展示的运行中会话排序提示。

## 验证

`manager.client.spec.ts` 三个红先测试钉住重建跳过（status 空转、activity 相同时间戳空转）与一秒窗口（首戳立即、窗口内第二戳缓冲、在首戳窗口终点冲刷一次——滑动去抖实现会红）。聚焦套件 57/57，session-controller 套件 443/443，`git diff --check` 干净。生产前后 Long Animation Frames 对比是验收测量。

## 后果

- 空转 status/activity 帧不再重建会话列表；环境时间戳大约每秒至多落地一次，实测长帧链约降至五分之一。
- engaged 空转早退无专门测试；它与其余四种同构，且该文件在仓库逐文件覆盖门禁之外。
- 侧栏相对时间与 updated 排序最多滞后时间戳一秒——在分钟显示粒度下不可见。
