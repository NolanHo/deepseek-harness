/** Composes viewport operations, reading policy, and history navigation for Chat. */
import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import type { ChatScrollPosition, ChatViewSlotProps } from '../contract/slots.ts'
import type { ChatSnapshot } from '../contract/snapshot.ts'
import { useChatNavigation, type ChatNavigation, type ChatNavigationInput } from './use-chat-navigation.ts'
import { useChatReading, type ChatReadingState } from './use-chat-reading.ts'
import { useChatViewport } from './use-chat-viewport.ts'
// Fork patch (FORK_SURFACE.md): the mounted window resolves the saved reader row
// and reveals its next step from a settled sample.
import { orderIndexOfAnchor, type MountedWindowState } from './fork/mounted-window.ts'

/** Committed content and Session operations used to reconcile scroll ownership. */
export interface ChatScrollInput extends ChatNavigationInput {
  readonly chatScroll: ChatViewSlotProps['chatScroll']
  readonly ready: boolean
  readonly order: readonly string[]
  readonly lastKey: string | null
  readonly lastIsUser: boolean
  readonly steeringId: string | null
  readonly submissionId: string | null
  readonly running: boolean
  readonly loadedTurns: ReturnType<ChatSnapshot['navigation']['items']>
  // Fork patch (FORK_SURFACE.md): the mounted transcript window's identity, so a
  // moved window re-anchors the reader instead of ResizeObserver timing.
  readonly mountSignature: string
  // Fork patch (FORK_SURFACE.md): the mounted window's sample-driven reveal.
  readonly willRevealAtHead: MountedWindowState['willRevealAtHead']
  readonly revealAtHead: MountedWindowState['revealAtHead']
}

interface ChatScrollState extends ChatReadingState {
  readonly listRef: RefObject<HTMLDivElement>
  readonly columnRef: RefObject<HTMLDivElement>
  readonly busyTurn: number | null
  readonly navigateToTurn: ChatNavigation['navigateToTurn']
  readonly loadEarlier: ChatNavigation['loadEarlier']
  readonly returnToBottom: () => void
  // Fork patch (FORK_SURFACE.md): the mounted window re-mounts the reader's saved
  // row, so the view re-arms the reflow hold from the session's scroll memory.
  readonly holdReader: (position: ChatScrollPosition | null) => void
}

/**
 * Coordinate scroll policy after Chat content commits.
 * New submitted input supersedes pending reader sampling.
 * @param input - current Chat content, scroll memory, and history operations.
 * @returns element refs, visible reading state, and navigation callbacks.
 */
export function useChatScroll(input: ChatScrollInput): ChatScrollState {
  const {
    ready, order, firstSeq, lastKey, lastIsUser, steeringId, submissionId, running,
    loadedTurns, chatScroll, hasMore, loadingOlder, loadOlder, loadThrough, mountSignature,
    willRevealAtHead,
    revealAtHead,
  } = input
  const { viewport, listRef, columnRef } = useChatViewport()
  const { reading, state } = useChatReading(viewport, chatScroll, loadedTurns.at(-1)?.turn ?? null)
  const navigationInput = useMemo(() => ({
    firstSeq, loadingOlder, hasMore, loadOlder, loadThrough,
  }), [firstSeq, loadingOlder, hasMore, loadOlder, loadThrough])
  const { navigation, busyTurn } = useChatNavigation(viewport, reading, navigationInput)
  const content = useRef<{ input: ChatScrollInput; applied: ChatScrollInput | null; opened: boolean }>({
    input, applied: null, opened: false,
  })

  const processContent = useCallback(() => {
    const current = content.current.input
    const previous = content.current.applied
    const ownInput = (current.lastIsUser && current.lastKey !== previous?.lastKey)
      || (current.steeringId !== null && current.steeringId !== previous?.steeringId
        && current.steeringId !== previous?.submissionId)
      || (current.submissionId !== null && current.submissionId !== previous?.submissionId
        && current.submissionId !== previous?.steeringId)
    if (reading.pending && !ownInput) return
    content.current.applied = current
    if (current.ready && !content.current.opened) {
      content.current.opened = true
      navigation.reset()
      // Fork patch (FORK_SURFACE.md): the mounted window is the only place that
      // resolves the saved row, so the restore path learns whether it has one and
      // keeps an unresolvable saved position instead of flattening it to the tail.
      reading.setAnchorResolved(
        orderIndexOfAnchor(current.order, current.chatScroll.read()?.anchorKey ?? null) >= 0,
      )
      reading.restore()
      return
    }
    if (ownInput) {
      navigation.cancel()
      reading.followTail()
      return
    }
    if (navigation.contentCommitted()) {
      navigation.reconcile()
      return
    }
    const tipChanged = previous === null || current.ready !== previous.ready
      || current.firstSeq !== previous.firstSeq || current.lastKey !== previous.lastKey
      || current.order.length !== previous.order.length || current.running !== previous.running
      || current.steeringId !== previous.steeringId || current.submissionId !== previous.submissionId
    if (tipChanged && reading.followingTail) {
      navigation.cancel()
      reading.followTail()
    } else navigation.reconcile()
  }, [reading, navigation])

  useLayoutEffect(() => {
    /**
     * Step the mounted window's head when the reader's own gesture has reached it.
     * A pending sample blocks the reflow that compensates the rows a reveal adds
     * above the reading line, so the step settles this scroll first: the sample
     * arms the hold on the row the reader has reached and the window move is then
     * absorbed instead of shifting the page down. The settle costs a layout read,
     * so it runs only for a gesture the fork module confirms will step.
     * @param head - reader scroll geometry and attribution.
     */
    const stepHeadAtReader = (head: { top: number; height: number; movedByReader: boolean }): void => {
      const latest = content.current.input
      const historyBusy = viewport.preserving || latest.loadingOlder
      if (!latest.willRevealAtHead(head, historyBusy)) return
      reading.onScrollEnd()
      latest.revealAtHead(head, historyBusy)
    }
    const disconnectViewport = viewport.connect({
      // Fork patch (FORK_SURFACE.md): a reader gesture that comes within one
      // viewport of the mounted head reveals the next window step, so a wheel or
      // touch gesture alone keeps older resident rows coming. The latest
      // committed input carries the history state, and a retained paging anchor
      // or an in-flight page request owns the layout while it runs.
      scroll: (scroll) => {
        reading.onScroll(scroll)
        stepHeadAtReader({
          top: scroll.metrics.top, height: scroll.metrics.height, movedByReader: scroll.movedByReader,
        })
      },
      scrollEnd: () => {
        reading.onScrollEnd()
        navigation.readerSettled()
      },
      interact: () => { navigation.cancel() },
      intent: (event) => {
        // A gesture against the mounted head moves nothing, so it produces no
        // scroll event; the intent itself reads the geometry and steps. A wheel
        // arrives before the position it produces, so its direction decides:
        // only a gesture toward older rows may step the head.
        if (event instanceof WheelEvent && event.deltaY >= 0) return
        const scroll = viewport.readScroll()
        if (scroll === null) return
        stepHeadAtReader({ top: scroll.metrics.top, height: scroll.metrics.height, movedByReader: true })
      },
      resize: () => {
        const committed = navigation.contentCommitted()
        // Fork patch (FORK_SURFACE.md): with no paging anchor retained, a fold
        // collapse, image load, or disclosure above the reading line grows the
        // flow uncompensated; re-assert the held reader row and refresh its
        // saved position before the layout policy reads the new geometry.
        if (!committed) {
          reading.reflow()
          reading.onResize()
        }
        navigation.reconcile()
      },
    })
    const disconnectReading = reading.connect((sample) => {
      navigation.readerSampled(sample)
      processContent()
    })
    return () => {
      disconnectViewport()
      disconnectReading()
      content.current.opened = false
      content.current.applied = null
    }
  }, [viewport, reading, navigation, processContent])

  useLayoutEffect(() => {
    const previous = content.current.input
    content.current.input = {
      ready, order, lastKey, lastIsUser, steeringId, submissionId, running, loadedTurns, chatScroll,
      mountSignature, willRevealAtHead, revealAtHead, ...navigationInput,
    }
    viewport.updateTurns(loadedTurns)
    const layoutChanged = previous.order !== order || previous.ready !== ready
    if (layoutChanged) viewport.invalidate()
    processContent()
    if (layoutChanged) reading.refreshActiveTurn()
    // Fork patch (FORK_SURFACE.md): a moved mounted window changes the flow above
    // the reading line with no prepend to compensate, so re-assert the held row.
    // A prepended page moves the head with the paging anchor already holding the
    // reader's row, and re-asserting it here would compensate the same growth twice.
    if (previous.order[0] === order[0] && previous.mountSignature !== mountSignature) reading.reflow()
  }, [
    viewport, reading, processContent, navigationInput, ready, order, lastKey, lastIsUser,
    steeringId, submissionId, running, loadedTurns, chatScroll, mountSignature,
  ])

  const returnToBottom = useCallback(() => {
    navigation.cancel()
    reading.followTail()
  }, [navigation, reading])

  const holdReader = useCallback((position: ChatScrollPosition | null) => {
    reading.hold(position)
    if (position !== null) reading.reflow()
  }, [reading])

  return {
    listRef, columnRef, ...state, busyTurn,
    navigateToTurn: navigation.navigateToTurn,
    loadEarlier: navigation.loadEarlier,
    returnToBottom,
    holdReader,
  }
}
