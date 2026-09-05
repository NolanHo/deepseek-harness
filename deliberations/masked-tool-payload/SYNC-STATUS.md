# Sync status — absorbing upstream (rolling)

目标：吸收 upstream/master（1079 commits，0.1.2-alpha.1，api-proxy→session-controller 重构）进 fork master。

## 状态（2026-08-28 深夜更新：合并已提交）

- worktree：/data/user/nolanho/code/.worktree/session-chunk-rows，merge 进行中（MERGE_HEAD=upstream/master），未提交。
- 冲突：123 → 当前 69（3 队友在并行解决 client/UI/manifest 批次）。
- 已定案：
  1. wire chunk 打包 = 上游已吸收（history.ts pageRecords 用 packChunkRuns）→ 无需移植。
  2. zstd/gzip 压缩 = 上游新 webserver（packages/host/webserver）自带 gzip，web-app bundle 默认 compression:gzip → 无需移植；zstd 作为后续增强。
  3. 搜索观察记忆化 = 自动合并存活（session-query-sqlite/src/index.ts）。
  4. messageCut seam（coordinator/store/jsonl/abstract）= 自动合并存活。
  5. messageCut 调用点 = 已移植进 packages/api/session-controller/src/history.ts：`tryIndexedPage` 快速路径（session 类地址、messageCut 精确切点 + readFrom 后缀读 + `paginateSuffix`（seq 语义分页，因为上游 paginate 假设稠密数组索引）+ 完整性校验失败回退观察路径）。host face tsc 中本文件零错误。
  6. PAGE_MESSAGES=8 = rt-architect 在 client 批次中移植。
- 剩余尾部问题（后轮）：session-controller 的 agentPreset 投影类型、dsh-native-command 导出、zod 依赖（依赖 manifest 由 rt-integrity 处理）——是合并尾部的旧类型/依赖问题，非移植本身。
- 下一步：等队友批次完成 → 收尾全部冲突 → pnpm install 重建 lockfile → 全量 typecheck/test 修复 → 提交 merge → 主树合并推送（用户 WIP 需协调）。

## 里程碑（第 2 轮）

- **合并提交完成**：`088bc79cbe`（worktree 分支 local/session-chunk-rows），全部 pre-commit 钩子通过。
- **全量构建绿**：`pnpm run build` 成功（220 client artifacts）。
- **typecheck 0 错误**（client + host 两面）。
- **关键套件**：session-controller/session-query/persistence/connection/modules/ui-layout/ui-conversation 共 1868 用例，除 1 个（ui-settings-models welcome 测试）外全绿。
- 本轮修复：fast-path 测试断言（信号参数/end 计算）、消息索引 SQL 的会话键绑定（上游 events.session_id 改数值键）、残留构建产物（旧 apiproxy lib）、4 处新类型字段（isServingAuthority/trustedAuthorities）测试夹具、e2e expandAllTurnFolds 迁移到上游 Turn Process 控制、session.client 页大小 pin 50→8。
- 遗留（下一轮）：ui-settings-models/welcome 1 个失败；主树合并推送（需协调用户 WIP）；FORK_CHANGES 补同步条目。

## 第 3 轮进展

- 合并提交更新为 `0da31a21e4`（含 ui-settings 修复 + FORK_CHANGES 条目 + tsconfig paths 再生 + typert catalog 再生 + settings-scope 测试夹具 isLoopback + messageCut @returns）。
- **全量测试基线**：17,187 绿 / 81 失败（36 文件）。已修复：tsconfig paths 生成、typert catalog（messageCut @returns + 再生）、ui-settings scope（isLoopback 统一）、settings-scope 夹具、ui-settings-models welcome（根因：合并后 scope 读 isServingAuthority 而镜像/测试读 isLoopback——scope 行统一为 isLoopback）。
- 剩余 81 → 已分类：
  A. 文档/快照/产物再生（可修）：4 个 web-search 包 README 骨架（已派 rt-product）、translation-prompt 快照、build-exe-for-python-sdk、webworker transform-corpus、install-lefthook。
  B. 环境敏感（root/权限/符号链接/时间类，需与旧树基线对比确认 pre-existing）：spill-local ×11、settings-file ×2、subagent-acp ×2、subagent ×1、bash-sandbox、tool-fs-search、agent-instructions、storage-sqlite、source-worker、claude-code ×3、llm-properties。
- 下一步：等 rt-product doc 报告；修 A 类；对 B 类在旧树（cc4fc8720f）抽样对比后判定。
