# Agent Note: Session-row menu contributions — a plugin adds a row to the sidebar's `⋯` menu

Status: implemented

English | [中文](2026-09-22-session-row-menu-contributions.zh.md)

> Scope: the sidebar Session row's `⋯` menu in the fork's Web client. [FORK_SURFACE.md](../../../../FORK_SURFACE.md) owns the divergence's re-apply procedure; [packages/client/AGENTS.md](../../../../packages/client/AGENTS.md) owns the slot, hook and service discipline this contribution point follows.

## Problem

A Session row's `⋯` menu is a hardcoded array in `ui-workspace`'s `Rows.tsx` — Rename, Fork, Archive — with its dispatch written as an `if (id === …)` chain. No slot, service or registry reaches that array: the generated client slot catalog has no row-level key, and the only session-list seat (`sidebar.workspaces`) is a single-occupant seat whose registration replaces the whole browsing region. An out-of-tree plugin therefore cannot add a row, and copying the list to own it is not an option.

The deployment's `dsh-session-snooze` plugin needs exactly that row: its first version put a bell in the sidebar footer, which the owner rejected — the deferral action belongs on the Session it applies to.

## Decision

Add one contribution point, owned by the fork module `packages/client/ui-workspace/src/client/fork/session-row-menu.ts`:

- `createSessionRowMenu()` returns a registry with `register(contribution)` (duplicate `id` throws, the returned disposer removes it), `snapshot()` (one array reference until a registration changes) and `subscribe(listener)`.
- `SessionRowMenuContribution` is `{ id, label, icon?, submenu(sessionId), onSelect(sessionId, leafId) }` — data, not React: the registrant localizes its own copy, decides per Session which leaves exist (an empty array hides the row for that Session), and receives the Session id with the leaf it selected.

`packages/client/ui-workspace/src/client/index.ts` provides the registry as the client service `sessionRowMenu` and publishes its source through the browser registration's inject `hooks` compartment, so `WorkspaceBrowser` reads it as `useSessionRowMenu` — the same route `hostInfo` takes. `WorkspaceBrowser.tsx` threads the snapshot into both row call sites (the grouped `SessionTree` and the flat `FlatList`). `Rows.tsx` appends each contribution after the three built-in rows, hides a contribution whose `submenu(sessionId)` returns no leaf, and namespaces the leaves handed to `Menu` as `<contributionId>\u0000<leafId>`; the `onSelect` handler resolves that prefix back to the owning contribution and calls it with the contributor's own leaf id. The built-in chain keeps its unknown-id-free form — the contributed ids are resolved after it, never as its `else` fallback, because that fallback would hand a future unknown id the Archive branch.

`Menu`'s one-level hover submenu needs no change: `MenuItem.submenu` is upstream, so the second level the deferral action needs already exists.

A contribution's `label` accepts a thunk and is re-read where the row builds its menu items. The registrant cannot bake localized copy at registration time: the client locale service still carries its provisional value while `apply` runs, so a label read there freezes in the bootstrap language. The rule matches the slot `label` option's.

## Alternatives considered

**A slot for menu items.** Slots render React nodes; `Menu` renders a data array. A slot would either force the row menu onto a React composition path it does not use, or ask registrants to render `MenuItem`-shaped nodes the primitive cannot consume.

**A fork-side hardcoded row that calls an optional plugin service.** Smaller at the menu, but the fork would name one plugin's feature in its own source, and the row would have to render (disabled or absent) when that plugin is not installed — the divergence would outlive its consumer.

**A leaf-id convention instead of a namespace.** Requiring globally unique leaf ids puts the collision risk on every future registrant; the row can prefix them for free.

## Consequences

- A contribution is data evaluated per render: the `submenu(sessionId)` callback reads the registrant's live snapshot and the row's clock, so the labels are current whenever the row renders. Nothing else re-renders the row on the registrant's behalf, which is why the deferral plugin's "time left" reading is as fresh as the sidebar's own clock.
- The consumer is the deployment's `dsh-session-snooze` plugin. If it is uninstalled, the registry keeps its `register`/`snapshot`/`subscribe` shape but contributes nothing — no dead menu row and no plugin name in fork code.
- A sync must re-apply four marked injections; the registry module itself is copied verbatim. The verification command and the consumer are recorded in the `FORK_SURFACE.md` row.

## Verification

`npx vitest run packages/client/ui-workspace` — the new `tests/session-row-menu.client.spec.ts` covers registration order, duplicate-id rejection, disposal, the empty-submenu hiding rule, the `\u0000` namespace round trip, and that the built-in rows keep their order and behavior; `tests/rows.client.spec.tsx`, `tests/workspace-browser.client.spec.tsx` and `tests/apply.client.spec.ts` carry the injected plumbing. `npx tsx scripts/verify-fork-surface.ts` proves the new row is registered in both language files, and a second `dsh web` instance (port 3097, its own `DSH_HOME` and session database) exercised the row, its hover submenu, a preset deferral, the `取消延后（剩余 1 小时）` leaf and the custom-duration dialog in the browser.
