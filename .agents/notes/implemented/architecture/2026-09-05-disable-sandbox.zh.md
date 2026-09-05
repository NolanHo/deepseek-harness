# Agent Note: fork 组合中禁用沙箱能力

Status: implemented

[English](2026-09-05-disable-sandbox.md) | 中文

## 问题

本 fork 只以 danger-full-access 部署、从不做沙箱约束，因此沙箱机制——沙箱服务、其 policy provider、沙箱化 bash/pwsh/fs 执行器及其单元测试——在 fork 里纯属成本：需要维护的组合面、只能在部署机上触发的 runner 与 landlock/windows-acl 测试、以及无人消费的权限预设表。所有者拍板（2026-09-05，记录于 FORK_CHANGES.md）：从 fork 组合禁用沙箱能力，把 `ctx.shell`/`ctx.fs` 槽位交给本地 provider，并停止运行沙箱域测试。

## 决策

改动主体全部落在 `packages/bundle/base/cordis.patch.yml`（每个 dsh profile 都挂载的唯一下层）；不改任何沙箱包源码，上游同步保持零成本。`verify-cordis-config` 要求 bundle patch 里出现的每个裸插件都声明为该 bundle 的依赖，因此 `packages/bundle/base/package.json` 新增两个换挂的本地包（`dsh-bash-local`、`dsh-pwsh-local`；`dsh-fs-local` 原本已声明），`pnpm-lock.yaml` 同步 importer 增量。

- 行 `sandbox`（`@deepseek-ai/dsh-sandbox-local`）与 `sandbox-policy`（`@deepseek-ai/dsh-sandbox-policy`）置 `disabled: true`，config 原样保留以便干净恢复。
- 执行器行 `bash-sandbox`、`pwsh-sandbox`、`fs-sandbox` 保留行 id 与 `!!js` 平台 `disabled` 表达式——overlay 与 base bundle spec 的平台门断言仍按这些 id 寻址——只更换所挂包为本地 provider：`@deepseek-ai/dsh-bash-local`（config `timeoutMs: 60000` 保持不变）、`@deepseek-ai/dsh-pwsh-local`、`@deepseek-ai/dsh-fs-local`（config `cwd: process.cwd()`，沿用 sdk-minimal 先例）。这些包各自注册能力 Service（`ctx.shell`/`ctx.fs`），每个 host 上恰好一个执行器/后端挂载，与之前完全一致。
- 行 `permission`（`@deepseek-ai/dsh-permission-presets`）一并置 `disabled: true`：该服务构造器拒绝在非约束执行器之上组合（`ctx.shell.sandboxMode === undefined`，其自带的「rejects composition over a non-confining executor at load」套件断言了该行为），换挂 bash-local 后若不关掉该行，每个 profile 启动即失败。行 `approval` 原样保留：approval 服务不依赖沙箱，且升级字段不再对外宣告后没有任何工具会发起审批。
- 消费方降级由能力驱动、与代码无关：`tool-bash` 与 `tool-fs` 读 `ctx.shell.sandboxMode`/`ctx.fs.sandboxMode`；本地 provider 报告 `undefined`，于是既不取 `sandboxPolicy`，工具 schema 与 prompt 文案也不再宣告 `sandbox_permissions`/`justification` 升级参数。`captureDelegatedPolicyOverrides` 走 `ctx.get('sandboxPolicy')?.overrideOf(...)`——本就是可选。`terminal-bash`/持久 shell 硬注入 `sandboxPolicy`，但基于 base 的 profile 都不挂它们；只有 sdk-minimal profile 挂，而 sdk-minimal 是独立完整树、保留其 danger-full-access 的 sandbox-policy 行（不在本次变更范围）。
- 根 `vitest.config.ts` 停止收集被禁套件：`forkDisabledSandboxTests` 从顶层与 thread-safe 项目 exclude 中排除 `packages/sandbox/*/tests`、`packages/shell/bash-sandbox/tests`、`packages/shell/pwsh-sandbox/tests`、`packages/fs/fs-sandbox/tests`，注释写明恢复路径（恢复/回退 base 行后删除该名单）。`forkDisabledSandboxCoverageExclusions` 把这些包的源码移出 per-file 覆盖率门——原先正是它们的单元套件撑起 100%。本地对应套件（`bash-local`、`pwsh-local`、`fs-local`）保持收录——换挂后它们就是被测后端。TypeScript typecheck 仍会编译被排除包的源码与测试（仓库惯例；排除只作用于测试收集）。

恢复路径（同时记录在 patch 注释中）：清除 `sandbox`、`sandbox-policy`、`permission` 的 `disabled: true`，把三条执行器行的 `name` 改回 `@deepseek-ai/dsh-*-sandbox` 包，并删除 vitest 的两份排除名单。

## 备选方案

- **沙箱行保持组合、默认 danger-full-access**——diff 最小，但在一个从不约束的部署里仍挂载沙箱 runner 与审批机制，正是本次决策要消除的摩擦；且 sandbox-policy 行的 mode 来自 `DSH_PERMISSION_MODE`，fork 部署不想依赖该环境变量。
- **保留 `permission` 挂载并修改 `dsh-permission-presets`** 使其容忍非约束执行器——那是上游自有文件的行为改动、不在写集内；而且捆绑沙箱模式的预设表在无沙箱的 fork 里没有消费者；禁用该行才是 fork 形态的答案。
- **重命名执行器行（`bash-sandbox` → `bash-local`）而非原地换名**——被否：`packages/bundle/base/tests/base.spec.ts` 把平台 `disabled` 表达式钉死在 `bash-sandbox`/`pwsh-sandbox` 这两个行 id 上（且该测试文件属上游、不在写集内）；保留行 id 也让任何用户 profile overlay 的寻址继续有效。

## 影响

- 模型面工具名与语义不变（bash/fs/读写/editor 经本地 provider 行为一致）；唯一模型可见差异是工具 schema/prompt 中沙箱升级参数与句子的消失——这正是该决策的目的。
- base 系 profile 不再有权限面（host `/permission` 命令、`permissions` 会话投影、web 权限设置行）；client permission-presets 包在宿主服务缺失时渲染为空。未在真实 web boot 上验证（不在验收范围）——记为假设。
- sdk-minimal profile 未动、仍以 danger-full-access 组合 sandbox-policy 行；若 fork 将来发布该 profile，再禁用它是后续事项。
- 从全新 worktree 跑 profile boot 前需要先 `pnpm run typecheck`（产出 host `lib/`）；loader 从构建后的 `lib/` 解析 `./typert` 贡献者。
- 已验证：`pnpm run typecheck` exit 0；`dsh --profile headless --dump-config` 显示 `sandbox`/`sandbox-policy`/`permission` 已禁用、执行器行为本地挂载；`vitest list` 不再收集被排除族；base bundle spec 全绿。受影响本地套件（fs-local、bash-local、tool-fs、tool-bash、subagent/subagent）全绿，唯一例外是 root 环境下无法构造「无搜索权限目录」的拒绝测试与三个真实 Claude CLI fixture 测试——两者在未改动的 master 控制 worktree 上同样失败，属既有环境基线而非本变更回归。无关三包（tool-fs-search、session-title、storage-json）全绿；spill-local 的清理扫描失败同样在 master 上复现。真实 API bash 往返未跑（无 `DEEPSEEK_API_KEY`）。
