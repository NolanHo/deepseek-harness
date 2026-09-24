import type { ConversationSlotProps } from '../contract/slots.ts'
import { conversationPhase } from '../contract/snapshot.ts'
import { ConversationWidthControls } from './ConversationWidthControls.tsx'
import { SETTLE_HIDE_LIMIT_MS, useSettleHide } from './settle-hide.ts'
import css from './ConversationRoot.module.css'

/**
 * Render the existing main Conversation frame around the extracted content.
 * @param props - the original `main.conversation` Slot props.
 * @returns the unchanged root, Header, content, and width-control subtree.
 */
export function ConversationMainPanel(props: ConversationSlotProps) {
  const { sessionId, useSession, useSessions, useConversation, renderSlot, renderFactorySlot } = props
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  const shellPhase = session === undefined || conversation === undefined
    ? 'blank'
    : conversationPhase(session, conversation)
  const openState = session?.openState
  const summaryBlank = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.blank)

  // While a session is still replaying (loading + blank) the hero/docked
  // choice is unknowable — render the composer hidden instead of flashing
  // the centered hero and snapping to the docked bar (or vice versa).
  // Exemption: a session the list summary already proves blank can only
  // land on the hero, so hiding would blank the column for the whole
  // history round-trip (the startup auto-selection flash) for nothing.
  // The exemption is deliberately open-state-wide, not loading-only: a
  // summary-blank session is the hero before its open starts (`cold`) and
  // after one fails (`error`) for the same reason — there is no history.
  // A restored continuable subagent waits for a Host summary to establish
  // parent availability. This keeps the composer
  // hidden instead of briefly rendering the parent-offline takeover.
  const parentAvailabilityPending = session?.subagent?.address.mode === 'continuable'
    && session.subagent.parentAvailable === undefined
  const settlePending = sessionId !== undefined && (
    (shellPhase === 'blank' && openState === 'loading' && summaryBlank !== true)
    || parentAvailabilityPending
  )
  // Fork patch (FORK_SURFACE.md): the settle hide is bounded. Neither settle
  // input must settle — a history open can stall, and a failed or stalled
  // parent-catalog read leaves `parentAvailable` undefined with no retry — so an
  // unbounded hide removes the composer for the life of the page (observed on a
  // restored continuable child) while `ui-subagent`'s elector deliberately keeps
  // the normal composer in place until the parent is known offline. The hide
  // only prevents a layout flash, so it gives way after `SETTLE_HIDE_LIMIT_MS`.
  const settling = useSettleHide(settlePending, sessionId ?? '', SETTLE_HIDE_LIMIT_MS)
  const hero = sessionId === undefined
    || (shellPhase === 'blank' && (openState === 'open' || summaryBlank === true))
  const phase = settling ? 'settling' : hero ? 'hero' : 'active'

  return (
    <div className={css.root} data-phase={phase}>
      {renderSlot('conversation.header', {})}
      {renderFactorySlot('conversation.content', {
        variant: 'main',
        phase,
        hero,
      }, {
        slots: { widthControls: ConversationWidthControls },
      })}
    </div>
  )
}
