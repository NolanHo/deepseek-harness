/** Composes viewport operations, reading policy, and history navigation for Chat. */
import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import type { ChatScrollPosition, ChatViewSlotProps } from '../contract/slots.ts'
import type { ChatSnapshot } from '../contract/snapshot.ts'
import { useChatNavigation, type ChatNavigation, type ChatNavigationInput } from './use-chat-navigation.ts'
import { useChatReading, type ChatReadingState } from './use-chat-reading.ts'
import { useChatViewport } from './use-chat-viewport.ts'

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
    const disconnectViewport = viewport.connect({
      scroll: reading.onScroll,
      scrollEnd: () => {
        reading.onScrollEnd()
        navigation.readerSettled()
      },
      interact: () => { navigation.cancel() },
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
      mountSignature, ...navigationInput,
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
