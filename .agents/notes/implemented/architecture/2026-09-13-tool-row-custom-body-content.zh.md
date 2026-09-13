# Agent Note: 工具行接受调用方自定义的展开体

Status: implemented

[English](2026-09-13-tool-row-custom-body-content.md) | 中文

## Problem

本仓库之外的一个 Client 插件接管了 `wait_subagent` 工具卡：折叠行必须保持与其他所有工具相同的通用行——即 bash、search 与回退调用树渲染的那一行——而展开体改为展示被等待子代理的实时信息，而非该调用的参数 JSON。

该插件无法自行构造这一行。`@deepseek-ai/dsh-client-ui-tool` 以裸包名把模块注册进客户端模块表，插件 bundle 因此可以 `require()` 该包，但 `/client` 入口只导出 `apply`/`inject` 与契约类型，`GenericToolCard` 与 `ToolRow` 仍是内部实现。该行的展开体也只接受两个字符串位——`bodyRaw`（参数 JSON）与 `output`（展平的结果文本）——因此即便插件够到了组件，也没有位置放入自己的 React 内容。

没有扩展位时，插件只有两条路：注册 keyed `tool.call.toolview` 条目（会替换整行），或复制该行的标记（每次上游同步都会与包内实现漂移）。

## Decision

`ToolRow` 新增可选的 `bodyContent: ReactNode`，`GenericToolCard` 把自己的同名可选属性透传给它，包的浏览器入口在原有 `apply`/`inject` 与契约类型之外导出 `GenericToolCard` 与 `GenericToolCardProps`。

`bodyContent` 的行为如下：

- 它的存在本身就让该行可展开，无需 `bodyRaw`、`output` 或卡片；折叠行不变。
- 它作为展开体的第一个子节点、以块级元素渲染在 Input/Output 卡片之外——排版由调用方自己负责，不继承 `ioCard`/`ioText` 的样式。
- 它取代默认的「参数」（INPUT）段。存在 `bodyContent` 时该行不格式化参数 JSON、不打印 INPUT 标签，并且在同样没有 `output` 时不渲染卡片。
- OUTPUT 段照旧与它并列渲染；卡片链、折叠摘要、错误摘要与后缀规则、Inspect 胶囊同样不受影响。
- 不传时该行与改动前渲染完全一致，可展开条件也一致。

该值导出是有意为之并已获用户同意：`packages/client/AGENTS.md` 把 Client 插件的值导出限制在 cordis 加载所需范围内，而这次导出服务于一个包外消费方——它没有任何基于 slot 的途径取得这个共享行。

## Surface

- `packages/client/ui-tool/src/client/tool/components/ToolRow.tsx`——`bodyContent` 属性、`hasBodyContent`、替代 `cardBody` 的 `inputBody`，以及展开体的第一个子节点。
- `packages/client/ui-tool/src/client/tool/toolviews/GenericToolCard.tsx`——`GenericToolCardProps.bodyContent`，透传给 `ToolRow`。
- `packages/client/ui-tool/src/client/index.ts`——`GenericToolCard` 与 `GenericToolCardProps` 两个导出。
- `packages/client/ui-tool/tests/tool-row.client.spec.tsx`——下述规格。
- `docs/cookbook/adding-a-tool.md`——Web Client 展示一节写明该组合方式。
- Fork 登记——`FORK_SURFACE.md` 的一条 Tier C 行与 `FORK_CHANGES.md` 的一条记录。

相关注记[Client 派生展示](2026-08-23-client-derived-tool-presentation.zh.md)的所有权不变：卡片与该行仍由 `ui-tool` 内部从原始 Session 事件派生；本次改动只是让包外插件能在 `ui-tool` 已渲染的那一行的展开体里放入自己的内容。

## Testing

`packages/client/ui-tool/tests/tool-row.client.spec.tsx` 钉住每个分支：只带 `bodyContent` 的行可展开并显示它；参数既不格式化也不带标签；自定义展开体旁仍渲染 OUTPUT 段；带 `bodyContent` 的 `GenericToolCard` 去掉 INPUT 段而保留 OUTPUT 段。`ui-tool` 包在 GUI 债务覆盖排除清单中（`vitest.config.ts`），因此承载这些行为的是上述规格，而不是 per-file 阈值。

## Alternatives considered

- **注册 keyed `tool.call.toolview` 条目。** 否决：keyed 条目替换整行，而需求是保留通用折叠行、只换展开体。
- **在展开体内新增 slot。** 否决：该行由 `ui-tool` 渲染而非由 slot 条目渲染，因此新增 slot 会迫使工具层为一个只有这个插件填充的表面声明 owner，而且实时组件内容无法通过 slot 那套 JSON 兼容的 owner props 传递。
- **扩展 `bodyRaw` 或 `output`。** 否决：两者都是该行自行格式化并加标签的字符串，而该面板是带自身订阅的 React 内容。
- **导出 `ToolRow`。** 否决：插件复用到的组合是 `GenericToolCard`——它负责派生行模型、卡片与文件链接——而该行暴露更宽的属性面，并会让每个消费方重复派生模型。
- **让插件复制该行标记。** 否决：复制品丢失该行的 chevron、悬停、可展开性与错误行为，且每次上游同步都会漂移。
- **把面板作为 JSON 兼容的 owner prop 传递。** 否决：实时 React 子树不属于 JSON 兼容的共享数据，而 `GenericToolCard` 是插件自行渲染的组件，不是经 slot 注册的组件。

## Consequences

- 该行的属性现在携带 React 内容；插件的面板在 `bodyWrap` 内排版，自身没有卡片边距或排版样式。
- 传入 `bodyContent` 的行不再显示其参数。需要参数的消费方在自己的展开体里渲染它们。
- 该导出让 `ui-tool` 的通用行成为面向包外插件的受支持表面，因此其属性会被仓库之外的代码读取，重命名从此会波及消费方。
- `bodyContent` 以属性而非 slot 的方式到达 `GenericToolCard`，因此只有直接渲染该组件的插件能用它；从 slot 接收 props 的插件组合用不了。
