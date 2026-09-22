# Agent Note: Session hover card removal — the sidebar keeps only the Workspace card

Status: implemented

English | [中文](2026-09-22-session-hover-card-removal.zh.md)

> Scope: the sidebar Session row's hover card in the fork's Web client. The [ui-workspace README](../../../../packages/client/ui-workspace/README.md) owns the package's current behavior; [FORK_SURFACE.md](../../../../FORK_SURFACE.md) owns the divergence's re-apply procedure.

## Problem

A Session row in the left sidebar opened a portaled hover card after a 500 ms dwell: the full display title, a relative time wrapped in the ago template ("1分钟前" / "1min ago"), and one status line per live status ("空闲", "已完成", "进行中", a subagent count, a pending interaction). The card was reachable — it sits 8 px off the row and stays open while the pointer rests on it — and its whole surface was one copy action that wrote the full title to the clipboard.

The owner does not want that popup in this deployment's session list. It duplicates what the row already shows (title, compact relative time, status dot with its screen-reader label), and it follows the pointer along the list while browsing. The Workspace row's card is wanted and stays.

## Decision

`SessionNodeItem` returns its row element directly. The `HoverCard` wrapper, the `SessionHoverContent` body, and the `hoverTimeLabel` helper are deleted, together with the `.hoverStatus` CSS block and both dictionaries' `time.ago` entries. A `// Fork patch (FORK_SURFACE.md)` marker records the removal at the return site.

The row itself is unchanged: status dot, title, active-Schedule marker, compact relative time, and the Rename/Fork/Archive menu. `menuOpen` still marks the open menu on the row.

The Workspace row keeps its card and every part it uses: `WorkspaceHoverContent`, `createdLabel`, `abbreviateHomePath`, the `.hoverContent`/`.hoverTitle`/`.hoverPath`/`.hoverTime` rules, and the `hover.created`/`hover.copied`/`date.ymd` keys. `HoverCard` and its pointer grace stay in `ui-primitives` for that consumer.

Removing the wrapper also removes the `display: block` span HoverCard rendered around each Session row. The row is now a direct child of its group section (grouped view) or of the `role="tree"` list (flat view), and `.groupSection > * + *` keeps the 2 px separation that the wrapper spans used to carry. Session drag markers already position against the row itself (`.sessionRow.dropBefore`/`.dropAfter` set `position: relative`), so the drop indicator is unaffected.

## Alternatives considered

**Keep the card behind a deployment flag or a CSS hide.** The typed dictionary and the card code would both survive, and the per-file 100% coverage gate would keep demanding tests for a surface the deployment never renders. The owner asked for the surface to be gone, not hidden.

**Keep the card on selected or blank rows only.** The card's content is not the objection; a popup that opens on dwell in the session list is.

**Move the copy action into the row menu.** It would add a menu row and a locale key to preserve a value the row's own Rename dialog already shows in full, and the request was to remove the card, not to re-home its action.

**Drop both hover cards.** The Workspace card is not the reported surface: its row clips a directory path that has no other full-path display, and the owner wants it kept.

## Consequences

- Session rows no longer preview the full title or copy it by a click on the row's card; the row keeps its own click, menu, drag, and selection behavior.
- Any consumer that anchored to a Session row's parent element sees one less `span`: the row's parent is now the group section (grouped) or the tree (flat). First-party specs and the sidebar e2e address rows through `[role="treeitem"]` itself, and the assembly specs that walk up from a row to the tree keep working because they stop at the `tree` role.
- `time.ago` has no consumer left, including the typed workspace dictionary's key union, which rejects an unused key only because the two dictionaries are declared complete against each other.
- The divergence is registered as a tier C row in `FORK_SURFACE.md` and its Chinese twin, with the re-apply procedure for an upstream sync; `FORK_CHANGES.md` carries the append-only bilingual entry.
- Upstream's session card is unchanged in the primitive: a later sync that restores `SessionHoverContent` and its row wrapper is a re-apply of the deletion, which the row and the file's marker both name.

## Testing

- `packages/client/ui-workspace/tests/rows.client.spec.tsx` drops the three session-card cases and the card halves of four others while keeping every row-level and Workspace-card assertion; the flat-row, pending-interaction, drag, and menu cases are untouched. The suite reports 26 cases in that file.
- `apps/web/tests/workspace-management.e2e.ts` drops the dwell-and-copy case; `seededSessionRow()` and the row-menu case that uses it stay.
- `pnpm vitest run packages/client/ui-workspace` — 10 files / 159 tests green.
- `npx tsx scripts/verify-fork-surface.ts` green with the new tier C row (English/Chinese row parity, marker census, reverse check).
- `pnpm run verify-client-ui-i18n` reports no violation in this package after the ago template's removal from both dictionaries; its one remaining violation is the pre-existing `packages/client/ui-chat/src/client/chat/fork/open-file-routing.ts` literal ("path open failed:"), which reproduces with this change stashed.
- `pnpm run test:docs` green after the README pair update and the re-recorded consistency record.
