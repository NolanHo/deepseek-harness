import { memo, useMemo } from 'react'
import { DisclosureRow, IconThinkOutlineRegular, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps, UseDisclosure } from '../contract/slots.ts'
import { markdownLabels } from '../markdown-labels.ts'
import { formatDuration } from './StatsPills.tsx'
import { formatExactCount } from './token-format.ts'
import a11yCss from './accessibility.module.css'
import css from './ReasoningRow.module.css'

const THINK_ICON = <IconThinkOutlineRegular size={14} />

/**
 * Render one assistant reasoning block collapsed until the reader opens it. The
 * collapsed summary carries the reasoning character count and, once the block
 * settled with a recorded span, its streaming duration; expanded content renders
 * the complete Markdown with secondary typography. Mode changes toggle CSS display
 * without unmounting collapsed summaries.
 *
 * Fork patch (FORK_SURFACE.md): the summary is that count rather than upstream's
 * first-line (settled) or streaming-tail preview, so the collapsed row carries
 * no reasoning prose and every display mode shows the same process metadata.
 * @param props.text - complete or streaming reasoning text.
 * @param props.running - whether this block is the streaming tail.
 * @param props.durationMs - recorded span of a settled block; absent while streaming or unrecorded.
 * @param props.useDisclosure - independent open state with enclosing-Turn resets.
 * @param props.t - conversation locale seat for status, summary, and Markdown actions.
 * @returns the reasoning disclosure.
 */
export const ReasoningRow = memo(function ReasoningRow({ text, running, durationMs, useDisclosure, t }: {
  text: string
  running: boolean
  durationMs?: number | undefined
  useDisclosure: UseDisclosure
  t: ChatViewSlotProps['t']
}) {
  const { expanded, toggle } = useDisclosure()
  const labels = useMemo(() => markdownLabels(t), [t])
  const chars = t('message.think.chars', { count: formatExactCount(text.length, t) })
  const summary = durationMs === undefined || running
    ? chars
    : t('message.think.charsWithDuration', { chars, duration: formatDuration(durationMs, t) })
  const collapsedContent = useMemo(() => (
    <>
      <span className={css.separator} aria-hidden />
      <span className={css.summary}>
        <span className={css.summaryText}>{summary}</span>
      </span>
    </>
  ), [summary])
  const content = useMemo(() => expanded ? (
    <div className={css.thinkBody}>
      <MarkdownText text={text} streaming={running} labels={labels} variant="compact" />
    </div>
  ) : undefined, [expanded, labels, running, text])

  return (
    <div
      className={css.root}
      data-variant="think"
      data-state={running ? 'running' : 'ok'}
      data-expanded={expanded || undefined}
      data-preview={!expanded && text !== '' || undefined}
    >
      {running && <span className={a11yCss.visuallyHidden}>{t('row.running')}</span>}
      <DisclosureRow
        rowClassName={css.row}
        leadingClassName={css.leading}
        titleClassName={css.title}
        chevronClassName={css.chevron}
        icon={THINK_ICON}
        title={t('message.think')}
        open={expanded}
        expandable
        expandOnRowClick
        onToggle={toggle}
        collapsedContent={collapsedContent}
        keepContentWhenOpen
      >
        {content}
      </DisclosureRow>
    </div>
  )
})
