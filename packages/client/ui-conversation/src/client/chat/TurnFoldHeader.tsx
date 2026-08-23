// TurnFoldHeader: the single collapsed summary row replacing a settled
// turn's intermediate content (tool calls, narration, retry/compaction rows).

import { memo } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { formatRunDuration } from './message-chrome.ts'
import css from './TurnFoldHeader.module.css'

/** Locale keys consumed by the fold header label and its control. */
export type TurnFoldTranslate = Translate<
  | 'chat.fold.toggle'
  | 'chat.fold.collapsed'
  | 'chat.fold.tools'
  | 'chat.fold.steps'
  | 'chat.fold.generic'
  | 'duration.seconds'
  | 'duration.minutes'
>

interface TurnFoldHeaderProps {
  /** Foldable rows of kind `tool-call`. */
  readonly toolCalls: number
  /** Foldable rows of kind `assistant-step` (intermediate replies). */
  readonly steps: number
  /** Total foldable rows, including kinds with no dedicated count. */
  readonly total: number
  /** Turn duration in ms; undefined when the timeline lacks a boundary. */
  readonly runMs: number | undefined
  /** Whether the owning turn currently renders all rows. */
  readonly expanded: boolean
  /** Toggle the owning turn's expanded state. */
  readonly onToggle: () => void
  /** The owning view's locale seat. */
  readonly t: TurnFoldTranslate
}

/** Collapsed-turn summary row: counts, optional duration, and the chevron. */
export const TurnFoldHeader = memo(function TurnFoldHeader({
  toolCalls, steps, total, runMs, expanded, onToggle, t,
}: TurnFoldHeaderProps) {
  // Zero categories are omitted; only when every counted category is zero
  // does the generic row count own the label.
  const parts: string[] = []
  if (toolCalls > 0) parts.push(t('chat.fold.tools', { tools: String(toolCalls) }))
  if (steps > 0) parts.push(t('chat.fold.steps', { steps: String(steps) }))
  const label = toolCalls === 0 && steps === 0
    ? t('chat.fold.generic', { count: String(total) })
    : t('chat.fold.collapsed', {
      parts: runMs === undefined ? parts.join(' · ') : `${parts.join(' · ')} · ${formatRunDuration(runMs, t)}`,
    })
  return (
    <button
      type="button"
      className={css.toggle}
      aria-expanded={expanded}
      aria-label={t('chat.fold.toggle')}
      onClick={onToggle}
    >
      <IconChevronDownOutline14 className={expanded ? css.chevronExpanded : css.chevronCollapsed} />
      <span className={css.label}>{label}</span>
    </button>
  )
})
