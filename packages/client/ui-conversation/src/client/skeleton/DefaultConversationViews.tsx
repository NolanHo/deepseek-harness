import { useEffect } from 'react'
import type { ConversationSessionSlotProps } from '../contract/slots.ts'
import { conversationPhase } from '../contract/snapshot.ts'
import { resolveActiveView } from '../view-selection.ts'
import css from './ConversationRoot.module.css'

/**
 * Seeds the composer from the persisted draft once per view mount and keeps the
 * draft mirror bound while the view is up.
 *
 * Fork patch (FORK_SURFACE.md): the input and draft subscriptions live in this
 * null leaf. Held in DefaultConversationViews they re-rendered the view area —
 * the whole loaded transcript window — on every keystroke, so per-keystroke
 * work grew with the history window a reader had loaded.
 * @param props - The strict session body shares the seed effect reads.
 * @returns null; this component renders no DOM.
 */
function DraftMirror({
  useInput, inputActions, useStore, actions, bindDraftMirror,
}: Pick<ConversationSessionSlotProps, 'useInput' | 'inputActions' | 'useStore' | 'actions' | 'bindDraftMirror'>) {
  const draftEmpty = useInput(s => s.draft === '')
  const storedDraft = useStore(s => s.draft)
  useEffect(() => {
    if (draftEmpty && storedDraft !== '') inputActions.setDraft(storedDraft)
    const unmirror = bindDraftMirror(actions.setDraft)
    return () => { unmirror() }
    // Mount-only (deps pinned to inputActions): later store writes come from
    // the machine mirror, not this seed effect.
  }, [inputActions])
  return null
}

/**
 * Renders the active Session view inside the resident scrollport and keeps
 * the input draft mirrored while blank Hero chrome is visible.
 * @param props - Strict Session input/store, view ledger, and render shares.
 * @returns the active view area, or null while the Session remains blank.
 */
export function DefaultConversationViews({
  view, useSession, useConversation, useConversationViews, useInput, inputActions, useStore, actions,
  renderSlot, bindDraftMirror, openView, useInspectCall,
}: ConversationSessionSlotProps) {
  const tabs = useConversationViews(value => value)
  const inspectCall = useInspectCall(value => value)
  const selectedId = useStore(s => s.view)
  const active = resolveActiveView(tabs, selectedId)
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  const viewRequest = useStore(s => s.viewRequest ?? null)

  const viewId = view ?? active?.id
  return (
    <>
      <DraftMirror
        useInput={useInput}
        inputActions={inputActions}
        useStore={useStore}
        actions={actions}
        bindDraftMirror={bindDraftMirror}
      />
      {session.blank && conversationPhase(session, conversation) === 'blank' ? null : (
        <div className={css.viewArea}>
          {viewId !== undefined && renderSlot('conversation.view', {
            inspectCall,
            viewRequest,
            openView,
            completeViewRequest: actions.completeViewRequest,
          }, { only: viewId })}
        </div>
      )}
    </>
  )
}
