// An enclosing `[data-conversation-scroll]` owns scrolling when present;
// otherwise this view owns it. Each row subscribes to one stable node key.

import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import type {
  NodeKey, RenderEntry, RenderMessageImages,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InboxState } from '@deepseek-ai/dsh-agent/types'
import type { PendingSubmission } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  Button, IconChevronDownOutlineRegular, MarkdownDelegateProvider, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps, OpenFileOptions } from '../contract/slots.ts'
import type { ChatSnapshot } from '../contract/snapshot.ts'
import { PendingSteeringBubble, PendingSubmissionBubble } from './MessageItem.tsx'
import { ChatNodeSeat } from './ChatNodeSeat.tsx'
import { ChatGroupSeat } from './ChatGroupSeat.tsx'
import { chatRenderKey } from './render-entry.ts'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { TurnNavigator } from './TurnNavigator.tsx'
import { mergeTurnRailItems, type TurnRailItem } from './turn-rail-items.ts'
import { useChatScroll } from './use-chat-scroll.ts'
// Fork patch (FORK_SURFACE.md): bound the mounted transcript to the reader's window.
import { useMountedWindow } from './fork/mounted-window.ts'
import { fileMediaUrl, resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import css from './ChatView.module.css'

/** Host/OS refusal text for the file-open dialog; empty throws keep a locale fallback. */
function openFailureMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return message === '' ? fallback : message
}

/**
 * Durable input identities suppress matching echoes in the same render.
 * The last input's Turn also distinguishes an empty opening control from
 * one whose human input or trigger notice is already present.
 */
function observedInputs(
  order: readonly string[],
  nodes: ChatSnapshot['nodes'],
): { readonly rpcIds: ReadonlySet<string>; readonly lastInputTurn: number | undefined } {
  const observed = new Set<string>()
  let lastInputTurn: number | undefined
  for (const key of order) {
    const node = nodes.get(key)
    if (node === undefined || (node.kind !== 'user' && node.kind !== 'steering' && node.kind !== 'turn-trigger')) continue
    if (node.location.kind === 'turn' || node.location.kind === 'step') lastInputTurn = node.location.turn.turn
    if (node.kind === 'turn-trigger') continue
    const source = (node.data as { readonly source?: unknown }).source as
      | { readonly kind?: unknown; readonly rpcId?: unknown }
      | undefined
    if (source?.kind === 'user' && typeof source.rpcId === 'string') observed.add(source.rpcId)
  }
  return { rpcIds: observed, lastInputTurn }
}

type PendingInput = PendingSubmission | InboxState['next-step'][number]

type ChatNodeListProps = Omit<ComponentProps<typeof ChatNodeSeat>, 'nodeKey' | 'groupPart'> & {
  readonly entries: readonly RenderEntry[]
  readonly useChatGroup: ChatViewSlotProps['useChatGroup']
  readonly pendingInputs: readonly PendingInput[]
  readonly lastInputTurn: number | undefined
  // Fork patch (FORK_SURFACE.md): whether the mounted entries reach the resident tail.
  readonly mountedTail: boolean
}

const ChatNodeList = memo(function ChatNodeList({
  entries, useChatGroup, pendingInputs, lastInputTurn, mountedTail, ...seatProps
}: ChatNodeListProps) {
  // Fork patch (FORK_SURFACE.md): only a group seat reads the window's key set, and
  // it moves on every resident append, so a node seat never takes it as a prop.
  const { mountedKeys, ...nodeProps } = seatProps
  const rows = entries.map((entry) => {
    switch (entry.kind) {
      case 'node':
        return <ChatNodeSeat {...nodeProps} key={chatRenderKey(entry)} nodeKey={entry.key}
          {...entry.groupPart === undefined ? {} : { groupPart: entry.groupPart }} />
      case 'group':
        return <ChatGroupSeat {...nodeProps} key={chatRenderKey(entry)} groupKey={entry.key}
          useChatGroup={useChatGroup} {...mountedKeys === undefined ? {} : { mountedKeys }} />
      default:
        return assertNever(entry)
    }
  })
  const pendingRows = pendingInputs.map(item => 'requestId' in item ? (
    <PendingSubmissionBubble key={item.requestId} submission={item}
      renderMessageImages={seatProps.renderMessageImages} t={seatProps.t} />
  ) : (
    <PendingSteeringBubble key={item.id} content={item.content}
      renderMessageImages={seatProps.renderMessageImages} t={seatProps.t} />
  ))
  // Fork patch (FORK_SURFACE.md): a frozen window's last mounted entry is not the
  // resident tail, so the opening echo only splices while the tail is mounted.
  const tail = mountedTail ? entries.at(-1) : undefined
  const node = tail?.kind === 'node' ? seatProps.nodeStore.get(tail.key) : undefined
  // An empty opening control follows one local transcript echo, never steering.
  // All rows share this keyed list so inserting the control keeps the echo mounted.
  if (node?.kind === 'turn-process' && node.location.kind === 'turn'
    && node.location.turn.status === 'open' && node.location.turn.turn !== lastInputTurn) {
    const index = pendingInputs.findIndex(item => 'requestId' in item && item.placement === 'transcript')
    if (index !== -1) rows.splice(rows.length - 1, 0, ...pendingRows.splice(index, 1))
  }
  return [...rows, ...pendingRows]
})

/**
 * The chat view slot entry: pure component over the composed props; each
 * ordered business Node crosses the keyed renderer seat.
 */
export function ChatView({
  useSession, useChat, useChatNode, useChatNodeProcess, useChatGroup, useConversation, useSessions, useStore, actions, renderSlot,
  sessionId, openFile, openSkill, openExternalLink, loadOlder, loadThrough, loadImage, inspectCall, chatScroll, forkAt, fileMentions,
  usePresentation, useProjection, t,
}: ChatViewSlotProps) {
  const order = useChat(s => s.order)
  const groupedEntries = useConversation(snapshot => snapshot.views.grouped('chat')?.entries)
  const entries = useMemo<readonly RenderEntry[]>(() => groupedEntries
    ?? order.map(key => ({ kind: 'node', key: key as NodeKey })), [groupedEntries, order])
  const nodeStore = useChat(s => s.nodes)
  // The rail's items are accumulated in the Chat snapshot, so this selector is
  // both the data and its change signal: the array identity moves only when a
  // Turn enters, leaves, or changes its preview.
  const turnNavigationItems = useChat(s => s.navigation.items())
  // Host-computed whole-log outline; the merge is view-layer only (the
  // conversation snapshot never carries projection values).
  const turnOutline = useProjection('turnOutline')
  const railItems = useMemo(
    () => mergeTurnRailItems(turnNavigationItems, turnOutline),
    [turnNavigationItems, turnOutline],
  )
  const inbox = useProjection('inbox') as unknown as InboxState | undefined
  // Workspace root off the session list row: path summaries display relative to it.
  const cwd = useSessions(s => s.byId[sessionId]?.cwd)
  const fileImages = useMemo(() => ({
    resolve: (path: string) => fileMediaUrl(document.baseURI, resolveWorkspacePath(cwd, path)),
    labels: {
      open: t('image.open'), loading: t('image.loading'), failed: t('image.failed'),
      dialog: t('image.dialog'), close: t('image.close'),
    },
  }), [cwd, t])
  const running = useSession(s => s.running)
  const openState = useSession(s => s.openState)
  const openError = useSession(s => s.openError)
  const hasMore = useSession(s => s.hasMore)
  const loadingOlder = useSession(s => s.loadingOlder)
  const [fileOpenError, setFileOpenError] = useState<{ path: string; message: string } | null>(null)
  const [fileOpenBusy, setFileOpenBusy] = useState(false)
  // Close/retry must ignore a settlement that started before the latest
  // gesture; otherwise a cancelled in-flight refusal reopens the dialog.
  const fileOpenRequest = useRef(0)

  const requestOpenFile = useCallback((path: string, options?: OpenFileOptions) => {
    const id = ++fileOpenRequest.current
    setFileOpenBusy(true)
    void (options === undefined ? openFile(path) : openFile(path, options)).then(
      () => {
        if (id !== fileOpenRequest.current) return
        setFileOpenError(null)
        setFileOpenBusy(false)
      },
      (error: unknown) => {
        if (id !== fileOpenRequest.current) return
        setFileOpenError({
          path,
          message: openFailureMessage(
            error,
            t('fileOpen.unknown'),
          ),
        })
        setFileOpenBusy(false)
      },
    )
  }, [openFile, t])

  const closeFileOpenError = useCallback(() => {
    fileOpenRequest.current += 1
    setFileOpenError(null)
    setFileOpenBusy(false)
  }, [])

  const inboxSteering = useMemo(
    () => inbox?.['next-step'].filter(message => message.source.kind === 'user') ?? [],
    [inbox],
  )
  const pendingSubmissions = useSession(s => s.pendingSubmissions)
  // Submission echoes still awaiting their durable counterpart. `order` is the
  // recompute trigger: durable user material always arrives as an append, and
  // every append replaces the order array.
  const [visibleSubmissions, lastInputTurn] = useMemo(() => {
    if (pendingSubmissions.length === 0) return [pendingSubmissions, undefined] as const
    const observed = observedInputs(order, nodeStore)
    return [pendingSubmissions.filter(submission => (
      submission.placement !== 'queued' && !observed.rpcIds.has(submission.requestId)
    )), observed.lastInputTurn] as const
  }, [pendingSubmissions, order, nodeStore])
  const pendingInputs = useMemo(() => {
    const local = new Map(visibleSubmissions.map(submission => [submission.requestId, submission]))
    // Admitted local identities outlive their bubbles until the Inbox claim watermark.
    const localIds = new Set(pendingSubmissions.filter(submission => submission.placement !== 'queued')
      .map(submission => submission.requestId))
    const pending = inboxSteering.flatMap<PendingInput>((item) => {
      const source = item.source
      if (source.kind !== 'user' || !('rpcId' in source)) return [item]
      const submission = local.get(source.rpcId)
      if (submission === undefined) return localIds.has(source.rpcId) ? [] : [item]
      local.delete(source.rpcId)
      return [submission]
    })
    return [...pending, ...local.values()]
  }, [inboxSteering, pendingSubmissions, visibleSubmissions])
  const renderMessageImages = useCallback<RenderMessageImages>(
    owner => renderSlot('conversation.message.images', { ...owner, loadImage }),
    [loadImage, renderSlot],
  )

  const firstKey = order[0]
  const firstSeq = firstKey === undefined ? null : nodeStore.get(firstKey)?.anchorSeq ?? null
  const lastKey = order.at(-1) ?? null
  const latestSteering = pendingInputs.findLast(item => 'source' in item)
  const steeringId = latestSteering?.source.kind === 'user' && 'rpcId' in latestSteering.source
    ? latestSteering.source.rpcId : latestSteering?.id ?? null
  // Fork patch (FORK_SURFACE.md): mount only the reader's window of the resident
  // order; every loaded page stays resident in the snapshot. The session's scroll
  // memory is both the reader's row and the tail signal the window transitions on.
  const readerMemory = chatScroll.read()
  // Fork patch (FORK_SURFACE.md): resident Turn-process control rows. The Turn
  // fold hides a completed Turn's rows behind its control, so the window
  // planner keeps the head Turn's control mounted with the rows it carries.
  const controls = useMemo(() => {
    const indices: number[] = []
    for (let index = 0; index < order.length; index++) {
      if (nodeStore.get(order[index] as string)?.kind === 'turn-process') indices.push(index)
    }
    return indices
  }, [nodeStore, order])
  const mounted = useMountedWindow({
    entries,
    order,
    controls,
    followingTail: readerMemory === null,
    anchorKey: readerMemory?.anchorKey ?? null,
    running,
  })
  const scroll = useChatScroll({
    ready: openState === 'open',
    order, firstSeq, lastKey, running, loadingOlder, hasMore, chatScroll, loadOlder, loadThrough,
    lastIsUser: lastKey !== null && nodeStore.get(lastKey)?.kind === 'user',
    steeringId,
    submissionId: visibleSubmissions.at(-1)?.requestId ?? null,
    loadedTurns: turnNavigationItems,
    mountSignature: mounted.signature,
    // Fork patch (FORK_SURFACE.md): a settled sample at the window head reveals one step.
    willRevealAtHead: mounted.willRevealAtHead,
    revealAtHead: mounted.revealAtHead,
  })
  /**
   * Rail target whose jump waits for its row. `awaited` is set when the window
   * itself was moved for that target, so the jump is re-issued on the commit
   * that mounts the row instead of landing on whatever row is nearest.
   */
  const pendingJump = useRef<{ readonly item: TurnRailItem; readonly awaited: boolean } | null>(null)

  // The commit that re-mounts the tail replaces a frozen window's floor with the
  // transcript floor, so the landing is re-issued against the mounted rows. A
  // window reaches the newest resident row while the reader's own row is still
  // within one reveal step of it, and that reader owns their position: only a
  // cleared scroll memory means the reading policy took the tail back.
  const wasAtTail = useRef(mounted.atTail)
  const landAtTail = scroll.returnToBottom
  useLayoutEffect(() => {
    const previous = wasAtTail.current
    wasAtTail.current = mounted.atTail
    if (mounted.atTail && !previous && chatScroll.read() === null) landAtTail()
  }, [chatScroll, landAtTail, mounted.atTail])

  // The frozen window mounts the session's saved row itself, so freezing re-arms
  // the reflow hold from that row instead of the capture the restore fell back to.
  const holdReader = scroll.holdReader
  const wasFrozen = useRef(false)
  useLayoutEffect(() => {
    const frozen = !mounted.atTail
    const entered = frozen && !wasFrozen.current
    wasFrozen.current = frozen
    if (!entered) return
    const saved = chatScroll.read()
    if (saved !== null) holdReader(saved)
  }, [chatScroll, holdReader, mounted.atTail])

  // A jump whose row the window could not hold yet lands on the commit that
  // brings the row in: an unmounted target mounts here, and a paged target stays
  // pending until its own page turns the rail item loaded.
  const hold = mounted.hold
  const jumpTo = scroll.navigateToTurn
  useLayoutEffect(() => {
    const pending = pendingJump.current
    if (pending === null) return
    const item = railItems.find(candidate => candidate.turn === pending.item.turn)
    if (item === undefined || item.anchor.kind !== 'loaded') return
    if (pending.awaited) {
      if (hold(item.anchor.key)) return
      pendingJump.current = null
      jumpTo(item)
      return
    }
    if (pending.item.anchor.kind !== 'unloaded') { pendingJump.current = null; return }
    // The page arrived: a row the window already holds is the in-flight jump's own
    // landing, and re-issuing it would cancel that jump before it settles.
    if (hold(item.anchor.key)) pendingJump.current = { item, awaited: true }
    else pendingJump.current = null
  }, [hold, jumpTo, railItems, mounted.signature])

  const navigateToTurn = useCallback((item: TurnRailItem) => {
    // Fork patch (FORK_SURFACE.md): mount the target's resident rows first, so the
    // landing below finds its anchor row in the DOM.
    if (item.anchor.kind === 'loaded') {
      pendingJump.current = hold(item.anchor.key) ? { item, awaited: true } : null
      if (pendingJump.current !== null) return
    } else pendingJump.current = { item, awaited: false }
    jumpTo(item)
  }, [hold, jumpTo])

  const reveal = mounted.reveal
  const pageEarlier = scroll.loadEarlier
  const loadEarlier = useCallback(() => {
    // Fork patch (FORK_SURFACE.md): resident rows the window dropped come back
    // before the next server page is requested.
    pendingJump.current = null
    if (reveal() || !hasMore) return
    pageEarlier()
  }, [hasMore, pageEarlier, reveal])

  const release = mounted.release
  const returnToBottom = useCallback(() => {
    // Fork patch (FORK_SURFACE.md): the floor of a frozen window is not the
    // transcript floor; the tail mounts in this commit and the effect re-lands.
    pendingJump.current = null
    release()
    landAtTail()
  }, [landAtTail, release])

  return (
    <div className={css.frame}>
      {scroll.initialized && (
        <TurnNavigator
          items={railItems}
          activeTurn={scroll.activeTurn}
          busyTurn={scroll.busyTurn}
          onNavigate={navigateToTurn}
          t={t}
        />
      )}
      <div className={css.root} data-chat-following-tail={scroll.followingTail ? '' : undefined}>
        <div ref={scroll.listRef} className={css.scroll}>
          <div ref={scroll.columnRef} className={css.column} data-chat-flow="">
            {openState === 'loading' && <div className={css.hint}>{t('chat.loadingHistory')}</div>}
            {openState === 'error' && openError !== null && (
              <div className={css.openError}>
                {t('chat.loadError', { message: openError.message, code: openError.code })}
              </div>
            )}
            {/* Fork patch (FORK_SURFACE.md): resident rows the window dropped are
                reachable before the next server page, and a reveal the reader's own
                row cannot move leaves the control out. */}
            {(hasMore || (mounted.canReveal && mounted.revealable)) && (
              <div className={css.older}>
                <button type="button" disabled={loadingOlder} onClick={loadEarlier}>
                  {loadingOlder ? t('loading') : t('chat.loadOlder')}
                </button>
              </div>
            )}
            <MarkdownDelegateProvider openExternalLink={openExternalLink} openFile={requestOpenFile} fileImages={fileImages}>
              <ChatNodeList
                entries={mounted.entries}
                mountedKeys={mounted.keys}
                mountedTail={mounted.tailMounted}
                pendingInputs={pendingInputs}
                lastInputTurn={lastInputTurn}
                nodeStore={nodeStore}
                useChatGroup={useChatGroup}
                useChatNode={useChatNode}
                useChatNodeProcess={useChatNodeProcess}
                usePresentation={usePresentation}
                useStore={useStore}
                actions={actions}
                cwd={cwd}
                openFile={requestOpenFile}
                openSkill={openSkill}
                inspectCall={inspectCall}
                forkAt={forkAt}
                loadImage={loadImage}
                renderMessageImages={renderMessageImages}
                fileMentions={fileMentions}
                renderSlot={renderSlot}
                t={t}
              />
            </MarkdownDelegateProvider>
            {/* No pending placeholders: questions (ui-user-questions) and approvals
                (ApprovalPanel) both take over the composer, so a flow card would
                double-render the same wait. */}
          </div>
        </div>
      </div>
      {!scroll.followingTail && (
        <div className={css.toBottomSlot}>
          <button
            type="button"
            className={css.toBottom}
            aria-label={t('chat.toBottom')}
            onClick={returnToBottom}
          >
            <IconChevronDownOutlineRegular />
          </button>
        </div>
      )}
      {fileOpenError !== null && (
        <FileOpenErrorDialog
          message={fileOpenError.message}
          busy={fileOpenBusy}
          onClose={closeFileOpenError}
          onRetry={() => { requestOpenFile(fileOpenError.path) }}
          t={t}
        />
      )}
    </div>
  )
}

/** In-page Host open-path refusal: the wire reason plus a retry of the same path. */
function FileOpenErrorDialog({
  message, busy, onClose, onRetry, t,
}: {
  message: string
  busy: boolean
  onClose: () => void
  onRetry: () => void
  t: ChatViewSlotProps['t']
}) {
  return (
    <Modal
      open
      onClose={onClose}
      closeLabel={t('close')}
      title={t('fileOpen.title')}
      description={message}
      footer={(
        <>
          <Button variant="outline" className={css.modalAction} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" className={css.modalAction} disabled={busy} onClick={onRetry}>{t('retry')}</Button>
        </>
      )}
    />
  )
}
