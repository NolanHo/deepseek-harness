// Fork-owned turn-process summary module (see FORK_SURFACE.md): the folded
// Turn disclosure label — counted categories plus the wall-clock duration
// suffix — extracted from upstream's TurnProcessNodeView. The view keeps only
// the disclosure chrome; locale copy stays in the upstream dictionary and the
// fold CSS stays inline.

import type { ChatNodeViewProps } from '../../contract/slots.ts'
import { formatRunDuration } from '../message-chrome.ts'

/** Turn wall-clock duration from the resolved turn boundary, when both edges exist. */
function turnRunMs(node: ChatNodeViewProps<'turn-process'>['node']): number | undefined {
  const location = node.location
  if (location.kind !== 'turn') return undefined
  const start = location.turn.start?.time
  const end = location.turn.end?.time
  if (start === undefined || end === undefined || end <= start) return undefined
  return end - start
}

/**
 * Collapsed label for the Turn process disclosure: the counted categories
 * (tool calls, messages, subagents) carry the folded prefix, and a turn
 * boundary with both edges appends its localized wall-clock duration. A turn
 * with nothing countable keeps the plain "thought for a while" label, with
 * the duration appended when the boundary provides one.
 * @param node - The turn-process Chat Node supplying counts and location.
 * @param t - Chat locale seat supplying the turn-process templates.
 * @returns The disclosure button's localized label text.
 */
export function turnProcessSummaryLabel(
  node: ChatNodeViewProps<'turn-process'>['node'],
  t: ChatNodeViewProps<'turn-process'>['t'],
): string {
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
  return labels.length === 0
    ? t('message.turnProcess.thoughtForAWhile') + suffix
    : t('message.turnProcess.collapsed', { parts: labels.join(separator) + suffix })
}
