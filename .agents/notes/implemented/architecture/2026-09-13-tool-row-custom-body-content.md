# Agent Note: Tool rows accept a caller-supplied expanded body

Status: implemented

English | [中文](2026-09-13-tool-row-custom-body-content.zh.md)

## Problem

A Client plugin outside this repository takes over the `wait_subagent` tool card: the collapsed row must stay the same generic row every other tool renders — the one bash, search, and the fallback call tree produce — while the expanded body shows live information about the subagents being awaited instead of the call's argument JSON.

The plugin cannot build that row. `@deepseek-ai/dsh-client-ui-tool` registers its modules in the client module table under the bare package name, so the plugin's bundle can `require()` the package, but the `/client` entry exported only `apply`/`inject` and contract types; `GenericToolCard` and `ToolRow` stayed internal. The row's expanded body also accepted only two string slots — `bodyRaw` (the argument JSON) and `output` (flattened result text) — so even a plugin that reached the component had no way to place React content of its own in the body.

Without an extension point the plugin's only options are a keyed `tool.call.toolview` entry, which replaces the whole row, or a copy of the row's markup, which drifts from the package on every upstream sync.

## Decision

`ToolRow` gains an optional `bodyContent: ReactNode`, `GenericToolCard` forwards its own optional `bodyContent` to it, and the package's browser entry exports `GenericToolCard` and `GenericToolCardProps` beside the unchanged `apply`/`inject` and contract types.

`bodyContent` behaves as follows:

- Its presence makes the row expandable by itself, with no `bodyRaw`, `output`, or card; the collapsed row is unchanged.
- It renders as the expanded body's first child, at block level, outside the Input/Output card — the caller owns its layout and inherits no `ioCard`/`ioText` typography.
- It replaces the default Input (arguments) section. The row does not format the argument JSON while `bodyContent` is present, prints no Input label, and renders no card when there is also no `output`.
- The Output section renders beside it unchanged, as do the card chain, the collapsed summary, the error summary and suffix rules, and the Inspect pill.
- Absent, the row renders exactly as before, including its expandability.

The value export is deliberate and signed off by the user: `packages/client/AGENTS.md` keeps Client plugin value exports to what cordis loading needs, and this export exists for a package-external consumer that has no slot-based route to the shared row.

## Surface

- `packages/client/ui-tool/src/client/tool/components/ToolRow.tsx` — the `bodyContent` prop, `hasBodyContent`, the `inputBody` value that substitutes for `cardBody`, and the body's first child.
- `packages/client/ui-tool/src/client/tool/toolviews/GenericToolCard.tsx` — `GenericToolCardProps.bodyContent`, forwarded to `ToolRow`.
- `packages/client/ui-tool/src/client/index.ts` — `GenericToolCard` and `GenericToolCardProps` exports.
- `packages/client/ui-tool/tests/tool-row.client.spec.tsx` — the specs below.
- `docs/cookbook/adding-a-tool.md` — the Web Client presentation section names the composition.
- Fork registration — a Tier C row in `FORK_SURFACE.md` and an entry in `FORK_CHANGES.md`.

The related [Client-derived presentation](2026-08-23-client-derived-tool-presentation.md) note keeps its ownership: cards and the row still derive from raw Session events inside `ui-tool`; this change only lets an out-of-tree plugin place content in the body of the row `ui-tool` already renders.

## Testing

`packages/client/ui-tool/tests/tool-row.client.spec.tsx` pins each branch: a row whose only body is `bodyContent` expands and shows it, the arguments are neither formatted nor labelled, the Output section still renders beside a custom body, and a `GenericToolCard` with `bodyContent` drops the Input section while keeping Output. The `ui-tool` package is on the GUI-debt coverage exclusion list (`vitest.config.ts`), so these specs, not a per-file threshold, carry the behavior.

## Alternatives considered

- **A keyed `tool.call.toolview` entry.** Rejected: a keyed entry replaces the whole row, and the requirement is the generic collapsed row with a different body.
- **A new slot inside the expanded body.** Rejected: the row is rendered by `ui-tool`, not by a slot entry, so a slot would force the tool layer to declare an owner for a surface only this one plugin fills, and live component content cannot cross the slot's JSON-compatible owner props.
- **Widen `bodyRaw` or `output`.** Rejected: both are strings the row formats and labels itself; the panel is React content with its own subscriptions.
- **Export `ToolRow`.** Rejected: `GenericToolCard` is the composition the plugin reuses — it derives the row model, the cards, and the file link — while the row exposes a wider props surface and would make every consumer re-derive that model.
- **Let the plugin copy the row's markup.** Rejected: the copy loses the row's chevron, hover, expandability, and error behavior, and drifts on every upstream sync.
- **Carry the panel as a JSON-compatible owner prop.** Rejected: a live React subtree is not JSON-compatible share data, and `GenericToolCard` is a component the plugin renders itself, not a slot-registered component.

## Consequences

- The row's props now carry React content; the plugin's panel is laid out inside `bodyWrap` with no card gutter or typography of its own.
- A row given `bodyContent` no longer shows its arguments. A consumer that needs them renders them inside its own body.
- The exported component makes `ui-tool`'s generic row a supported surface for package-external plugins, so its props are read outside the repository and renames now reach consumers.
- `bodyContent` reaches `GenericToolCard` as a prop rather than through a slot, so only plugins that render the component directly can use it; plugin composition that receives its props from a slot cannot.
