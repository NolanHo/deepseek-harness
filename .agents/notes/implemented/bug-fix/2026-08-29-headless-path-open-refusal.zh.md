# Agent Note：无桌面打开器的主机上，工作区路径打开快速拒绝

状态：已实施

[English](2026-08-29-headless-path-open-refusal.md) | 中文

> 范围：`session/openWorkspacePath` RPC 的门控与 Chat 文件打开对话框的本地化拒绝文案。不改线上类型、持久化或激活策略。

## 问题

无桌面的部署仍然接受文件打开点击：`session/openWorkspacePath` 无视部署自身的 `canOpenWorkspacePath()` 探测，直接运行平台打开器。于是没有显示服务器、没有 MIME 处理器的主机 spawn 出 `xdg-open`，失败后把多行 `no "view" rule for type "text/markdown"` 的报错堆进 Chat 的文件打开对话框。能力探测一直存在——产出文件行已经用它来门控 **在文件夹中显示**——但打开 RPC 从未参考它。

## 决策

**能力探测宣告的门控现在也守护这个操作。** `openWorkspacePath` 在 abort 检查之后查询 `canOpenPath()`（与客户端可查询的 `nativeOpen` 配置 / 注入打开器 / 平台探测同一来源），为 false 时沿用既有错误词汇快速失败：`internal` / `path open failed: desktop unavailable`。Host 不再 spawn 一个它明知到不了桌面的平台打开器。Chat 的打开接口识别该拒绝，抛出 locale 所有的 `fileOpen.desktopUnavailable` 文案而非线上消息；其他失败继续转发线上原因。

**核心文件表面在 better-sidebar 安装时改走其侧栏编辑器。** 第三方插件 `dsh-better-sidebar` 已经劫持产出文件芯片并在自己的侧栏编辑器里打开；核心表面（行内引用、工具行路径、通用文件卡片）仍走 Host 打开器——这正是无桌面部署无法服务的那块。Chat 打开接口现在优先使用该插件服务——结构化 `ctx.get('betterSidebar')` 的 `openTab` duck 检查，不引入包依赖——打开 `{ type: 'editor', title: basename, path: absolute, id: 'editor:<absolute>' }`；原生打开器保留为无插件配置的回落路径，文件夹揭示（`.` 没有编辑器文件）也保持原生。

## 后果

- 本部署点击文件现在在 better-sidebar 存在时打开侧栏编辑器；不存在时显示一句本地化说明，不再出现 `xdg-open` 报错堆。
- `canOpenWorkspacePath()` 与 `openWorkspacePath` 不再可能不一致：操作恰好在探测为 `false` 时拒绝，探测仍对注入打开器报 `true`（测试钉住两者）。
- 保持 `nativeOpen: true` 而平台打开器本身损坏的部署，仍会转发平台自身的失败文本。

## 备选方案

- **像 settings 控制器的目录打开那样返回 `{ opened: false }`** —— 对用户静默；对话框的重试/关闭交互与失败词汇都已存在，拒绝文案比无操作更好。
- **客户端在每次点击前先查能力** —— 重复 Host 的单一事实来源，且与探测存在竞态；RPC 门控才是执行点，客户端只负责本地化拒绝。
- **在 fork 自有插件里重做 turn-tail 劫持，而非改 `ui-chat`** —— 行内引用与工具行路径根本不经过 turn-tail 链，fork 插件够不到它们；`openFile` 闭包是所有核心表面共享的唯一漏斗。
- **通过 HTTP 提供文件内容给远程预览** —— 2026-07-31 的工作区文件链接决策已将其排除在范围外并退役了原型；此处不再重访。
