// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import type { ChatScrollPosition, ChatViewSlotProps } from '../src/client/contract/slots.ts'
import { ChatReading } from '../src/client/chat/use-chat-reading.ts'
import { ChatViewport, type ViewportLanding } from '../src/client/chat/use-chat-viewport.ts'
import { ScrollFollow } from '../src/client/chat/use-scroll-follow.ts'

/** The saved position every case restores from, unless the case replaces it. */
const readerMemory: ChatScrollPosition = { anchorKey: 'call:tool-1', anchorTop: 8, scrollTop: 640 }

/** Reading policy over a viewport whose DOM work each case replaces. */
function fixture(initial: ChatScrollPosition | null = readerMemory) {
  const viewport = new ChatViewport()
  let saved = initial
  const store: ChatViewSlotProps['chatScroll'] = {
    save: (position) => { saved = position },
    read: () => saved,
  }
  const reading = new ChatReading(
    viewport,
    store,
    { initialized: false, followingTail: false, activeTurn: null },
    () => {},
    new ScrollFollow(false, 25),
  )
  return { reading, viewport, saved: (): ChatScrollPosition | null => saved }
}

/** A clamped fallback landing: the mounted floor, with no semantic anchor row. */
const floorLanding: ViewportLanding = {
  metrics: { top: 1_600, floor: 1_600, height: 400 },
  position: null,
  turn: null,
}

it('keeps a saved anchor the mounted window cannot place', () => {
  const h = fixture()
  vi.spyOn(h.viewport, 'restore').mockReturnValue(floorLanding)
  h.reading.setAnchorResolved(false)

  h.reading.restore()

  // The reader's row has no resident index, so the raw fallback is the mounted
  // floor rather than their place: the memory and the tail ownership both stand.
  expect(h.saved()).toEqual(readerMemory)
  expect(h.reading.followingTail).toBe(false)
})

it('restores a saved anchor the mounted window did place', () => {
  const h = fixture()
  const landed: ViewportLanding = {
    metrics: { top: 480, floor: 1_600, height: 400 },
    position: { anchorKey: 'k40', anchorTop: 24, scrollTop: 480 },
    turn: null,
  }
  vi.spyOn(h.viewport, 'restore').mockReturnValue(landed)
  h.reading.setAnchorResolved(true)

  h.reading.restore()

  expect(h.saved()).toEqual(landed.position)
  expect(h.reading.followingTail).toBe(false)
})

it('follows the tail when the session saved no position', () => {
  const h = fixture(null)
  const scrollToBottom = vi.spyOn(h.viewport, 'scrollToBottom')

  h.reading.restore()

  expect(scrollToBottom).toHaveBeenCalled()
})

it('re-arms the reflow hold from a jump landing', () => {
  const h = fixture()
  const arm = vi.spyOn(h.viewport, 'armReflow')
  const landed: ViewportLanding = {
    metrics: { top: 480, floor: 1_600, height: 400 },
    position: { anchorKey: 'k40', anchorTop: 24, scrollTop: 480 },
    turn: 3,
  }

  h.reading.acceptNavigation(landed)

  expect(h.saved()).toEqual(landed.position)
  expect(arm).toHaveBeenLastCalledWith(landed.position)
})

it('releases the reflow hold when a jump lands at the floor', () => {
  const h = fixture()
  const arm = vi.spyOn(h.viewport, 'armReflow')
  const landed: ViewportLanding = {
    metrics: { top: 1_600, floor: 1_600, height: 400 },
    position: { anchorKey: 'k59', anchorTop: 0, scrollTop: 1_600 },
    turn: 3,
  }

  h.reading.acceptNavigation(landed)

  expect(h.saved()).toBeNull()
  expect(arm).toHaveBeenLastCalledWith(null)
})
