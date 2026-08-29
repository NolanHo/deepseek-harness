import { memo } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import { formatRunDuration } from './message-chrome.ts'
import css from './TurnProcessNodeView.module.css'

/** Turn wall-clock duration from the resolved turn boundary, when both edges exist. */
function turnRunMs(node: ChatNodeViewProps<'turn-process'>['node']): number | undefined {
  const location = node.location
  if (location.kind !== 'turn') return undefined
  const start = location.turn.start?.time
  const end = location.turn.end?.time
  if (start === undefined || end === undefined || end <= start) return undefined
  return end - start
}

/** Turn-level process disclosure controller. */
export const TurnProcessNodeView = memo(function TurnProcessNodeView({
  node, turnProcess, t,
}: ChatNodeViewProps<'turn-process'>) {
  if (turnProcess === undefined) throw new Error('turn-process node requires Turn process owner state')
  if (!turnProcess.foldable) return null
  const open = turnProcess.open
  const labels: string[] = []
  if (node.data.toolCallCount > 0) {
    labels.push(t(
      node.data.toolCallCount === 1
        ? 'message.turnProcess.toolCalls.one'
        : 'message.turnProcess.toolCalls.other',
      { count: node.data.toolCallCount },
    ))
  }
  if (node.data.messageCount > 0) {
    labels.push(t(
      node.data.messageCount === 1
        ? 'message.turnProcess.messages.one'
        : 'message.turnProcess.messages.other',
      { count: node.data.messageCount },
    ))
  }
  if (node.data.subagentCount > 0) {
    labels.push(t(
      node.data.subagentCount === 1
        ? 'message.turnProcess.subagents.one'
        : 'message.turnProcess.subagents.other',
      { count: node.data.subagentCount },
    ))
  }
  const separator = t('message.turnProcess.separator')
  const runMs = turnRunMs(node)
  const duration = runMs === undefined ? undefined : formatRunDuration(runMs, t)
  const suffix = duration === undefined ? '' : separator + duration
  // Counted categories carry the collapsed prefix; a turn with nothing
  // countable keeps the plain "thought for a while" label, with the
  // duration appended when the turn boundary provides one.
  const label = labels.length === 0
    ? t('message.turnProcess.thoughtForAWhile') + suffix
    : t('message.turnProcess.collapsed', { parts: labels.join(separator) + suffix })
  return (
    <button
      type="button"
      className={css.root}
      data-open={open || undefined}
      data-turn-process={node.data.turn}
      data-turn-process-messages={node.data.messageCount}
      data-turn-process-tool-calls={node.data.toolCallCount}
      data-turn-process-subagents={node.data.subagentCount}
      aria-expanded={open}
      onClick={(event) => {
        event.currentTarget.focus()
        turnProcess.setOpen(!open)
      }}
    >
      <IconChevronDownOutline14 className={css.chevron} />
      <span className={css.label}>{label}</span>
    </button>
  )
})
