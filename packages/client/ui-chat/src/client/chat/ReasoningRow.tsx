/** Assistant reasoning disclosure, independent of Tool-call presentation. */
import { useState } from 'react'
import { DisclosureRow, IconThinkOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { formatDuration } from './StatsPills.tsx'
import { formatExactCount } from './token-format.ts'
import a11yCss from './accessibility.module.css'
import css from './ReasoningRow.module.css'

/**
 * Render one assistant reasoning block as the Think disclosure row. The
 * collapsed summary carries the reasoning character count and, once the block
 * settled with a recorded span, its streaming duration; expanded content
 * preserves the complete text.
 * @param props.text - complete or streaming reasoning text.
 * @param props.running - whether this block is the streaming tail.
 * @param props.durationMs - recorded span of a settled block; absent while streaming or unrecorded.
 * @param props.t - conversation locale seat for the collapsed summary and the running status.
 * @returns the reasoning disclosure.
 */
export function ReasoningRow({
  text, running, durationMs, t,
}: {
  text: string
  running: boolean
  durationMs?: number | undefined
  t: ChatViewSlotProps['t']
}) {
  const [expanded, setExpanded] = useState(false)
  // Fork patch (FORK_SURFACE.md): the collapsed row carries the reasoning
  // character count and settled duration instead of upstream's preview.
  const chars = t('message.think.chars', { count: formatExactCount(text.length, t) })
  const summary = durationMs === undefined || running
    ? chars
    : t('message.think.charsWithDuration', { chars, duration: formatDuration(durationMs, t) })

  return (
    <div
      className={css.root}
      data-variant="think"
      data-state={running ? 'running' : 'ok'}
      data-expanded={expanded || undefined}
    >
      {running && <span className={a11yCss.visuallyHidden}>{t('row.running')}</span>}
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={<IconThinkOutline14 size={14} />}
        title={t('message.think')}
        open={expanded}
        expandable
        expandOnRowClick
        onToggle={() => { setExpanded(value => !value) }}
        collapsedContent={(
          <>
            <span className={css.separator} aria-hidden />
            <span className={css.summary}>
              <span className={css.summaryText}>{summary}</span>
            </span>
          </>
        )}
      >
        <div className={css.thinkBody}>{text}</div>
      </DisclosureRow>
    </div>
  )
}
