# Agent Note: Collapsed Think row carries the reasoning character count

Status: implemented

English | [中文](2026-09-12-collapsed-think-character-count.zh.md)

## Problem

A collapsed Think row in the conversation transcript previews reasoning prose — the first line, or the streaming tail while the block runs. That preview is the densest, most volatile text in a transcript's process scan, and it competes for attention with the answer body. The row needs only to report that reasoning happened and how much there is.

## Decision

The collapsed summary renders the reasoning block's character count and no reasoning text, as one locale-owned string: an exact digit-grouped integer plus its unit. The count follows the block's length live while reasoning streams, so a running row still reads as moving, and the row keeps its sweep animation, `data-state` attributes, and visually-hidden running label.

Expansion renders the complete reasoning text byte for byte, including any `**` the model emits, because the double-asterisk stripping lived in the collapsed preview alone; it opens from the row title and from the count.

The count is the block text's UTF-16 code unit length (`text.length`), the package's existing `json.truncated` convention.

Once a block settles, the summary appends its streaming duration to the count (`1,234 字符 · 12.3s`), taken from the timed stream embedded in the settled message: the span runs from the first to the last reasoning delta of that block. The duration is deliberately absent while the block still runs and when no span was recorded, so a running row keeps the single moving number.

## Surface

- `packages/client/ui-chat/src/client/chat/ReasoningRow.tsx` — the collapsed summary is `t('message.think.chars', { count: formatExactCount(text.length, t) })`; the two line helpers are deleted; the summary span carries no `data-follow-end` attribute; the expanded `thinkBody` renders the complete text.
- `packages/client/ui-chat/src/client/chat/ReasoningRow.module.css` — upstream's two `[data-follow-end]` rules are deleted with the attribute, leaving a `/* Fork patch (FORK_SURFACE.md) */` marker.
- `packages/client/ui-chat/src/client/chat/token-format.ts` — `formatExactCount(value, t)` owns locale-grouped exact-integer formatting through `number.groupSeparator`; `formatExactTokens` delegates to it.
- `packages/client/ui-chat/src/client/locale.ts` — the added `message.think.chars` is `{count} characters` (en) and `{count} 字符` (zh), and `message.think.charsWithDuration` (`{chars} · {duration}`) composes it with the shared compact duration formatter.
- `packages/client/ui-chat/src/client/contract/chat-nodes.ts` — `AssistantChatData.reasoningSpans` carries one span per reasoning block index.
- `packages/client/ui-chat/src/client/conversation-nodes/assistant.ts` — `settleMessage` folds the settled message's embedded timed stream into spans; several packed `reasoning-chunks` runs for one index union into one span, and a retry resets them with the rest of the step state.
- `packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx` and `AssistantNodeView.tsx` — derive the settled duration per block and keep it hidden while that block is the streaming tail.
- Tests — `tests/reasoning-row.client.spec.tsx` covers the count, grouping, live growth while streaming, and expansion from title or count; obsolete collapsed-preview assertions are replaced in `tests/coverage-tails.client.spec.tsx` and `tests/chat-view.client.spec.tsx`, one obsolete case is deleted from `tests/chat-branch-tails.client.spec.tsx`, `apps/web/tests/lifecycle-chrome.e2e.ts` drops the `[data-follow-end]` viewport-pin poll, and the opt-in stress lane `apps/web/stress-tests/reasoning-chunks.stress.ts` asserts the displayed count equals the fixture's emitted reasoning length (`reasoningCharacters` on the fixture storm state in `packages/client/connection/src/client/fixture.ts`). The Think-bearing `snapshots/web/**/*.expected.md` goldens take their count-and-duration lines from a `DSH_SNAPSHOT=refresh` run filtered to those rows, so the refresh's unrelated composition drift (the removed Access-mode chip, the TurnProcess label, and machine-specific session rows) stays out of this change: eighteen files carry `· {{duration}}`, while `cordis-tool-round` keeps count-only rows because its recorded stream holds no reasoning deltas to span. Eight further Think-bearing goldens keep the prose form deliberately and are not counted above: the three `snapshots/web/seeded-history/*.expected.md` files (six rows) belong to the suite this fork excludes from the lane, and the two `apps/web/tests/expected/steer-all/*.expected.md` files (two rows) belong to a scenario whose `session.jsonl` fixture is missing, so the reasoning block's full length beyond the preview's first line is unknown.
- Fork registration — this deliberate divergence is a Tier C row in `FORK_SURFACE.md` and an entry in `FORK_CHANGES.md`.

## Alternatives considered

- **Compact count (`1.2K`).** Rejected: the collapsed row is the only place the exact size is visible, and precision costs nothing there.
- **Keep the text preview and append the count.** Rejected: that leaves the prose, which is the noise being removed.
- **Bare number without the unit.** Rejected: locale-owned copy must say what the number measures.
- **Change the trajectory view's thinking preview in the same change.** Rejected: it is a separate implementation (`ui-trajectory`) outside the conversation transcript, so scope stays on the Chat transcript.
- **Reveal the reasoning text from the count on hover or as a tooltip.** Rejected: a hover-only affordance is invisible in dense transcript scanning and to non-pointer readers.

## Consequences

- The expanded row remains the single place reasoning text is readable.
- Because the collapsed row renders no reasoning text, browser find-in-page cannot locate reasoning prose while a Think row is collapsed. Accepted: the count still reports presence and size, and expansion restores the text.
- A collapsed row reports that reasoning is still arriving but not which prose arrived: the sweep animation and `data-state` attributes carry that signal alone.
- The duration measures the delivered reasoning stream, not turn wall-clock time: it excludes the wait before the first reasoning delta and any gap after the last one, and a block whose message carries no stream records keeps the count alone.
- The opt-in stress lane cannot execute on the current tree: `vitest.web-stress.config.ts` is the only browser config missing the shared `standardDecoratorPlugin`, so the suite fails at load with `SyntaxError: Invalid or unexpected token` (reproduced with the unmodified file). Its assertion was moved to the displayed count, but it stays unexecuted until that config gains the plugin.
- Archived upstream notes [`2026-08-02-web-thinking-tail-scroll`](../../archived/feature/2026-08-02-web-thinking-tail-scroll.md) and [`2026-08-14-web-turn-process-folding`](../../archived/feature/2026-08-14-web-turn-process-folding.md) stay frozen history for the upstream collapsed-preview and tail-follow behavior this divergence replaces.
- [Frame-coalesced reasoning-chunk publication and browser stress validation](../testing/2026-08-03-opt-in-reasoning-chunk-browser-stress.md) stays current for publication scheduling; its pinned horizontal-tail alignment is superseded here.
