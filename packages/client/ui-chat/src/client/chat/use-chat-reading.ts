/** Follow-tail ownership, saved-position restoration, and sampled reader movement. */
import { useLayoutEffect, useState } from 'react'
import type { ChatScrollPosition, ChatViewSlotProps } from '../contract/slots.ts'
import type { ChatViewport, ViewportLanding, ViewportScroll } from './use-chat-viewport.ts'
import { useScrollFollow, type ScrollFollow } from './use-scroll-follow.ts'

const FOLLOW_THRESHOLD = 24
const SCROLL_SAMPLE_INTERVAL_MS = 500

/** Reading facts that affect Chat chrome and initial rail placement. */
export interface ChatReadingState {
  readonly initialized: boolean
  readonly followingTail: boolean
  readonly activeTurn: number | null
}

/** Settled reader position delivered to history-navigation policy. */
export interface ReadingSample {
  readonly position: ChatScrollPosition | null
  readonly movedByReader: boolean
  readonly followingTail: boolean
}

type PositionStore = ChatViewSlotProps['chatScroll']

/** Owns reading policy and its cancellable sampling work, without DOM access. */
export class ChatReading {
  private sampleTimer: number | null = null
  private probeFrame: number | null = null
  private sampled: ((sample: ReadingSample) => void) | null = null
  // Fork patch (FORK_SURFACE.md): whether the mounted window resolved the saved
  // reader row to a resident order key.
  private anchorResolved = true

  constructor(
    private readonly viewport: ChatViewport,
    private store: PositionStore,
    private state: ChatReadingState,
    private readonly onChange: (state: ChatReadingState) => void,
    private readonly follow: ScrollFollow,
  ) {}

  /**
   * Expose pending reader ownership to navigation and resize handlers.
   * @returns whether reader input still awaits interval or scrollend sampling.
   */
  get pending(): boolean { return this.sampleTimer !== null }
  /**
   * Expose the active follow policy.
   * @returns whether content growth retains bottom-follow ownership.
   */
  get followingTail(): boolean { return this.state.followingTail }

  /**
   * Adopt the committed Session's scroll memory.
   * @param store - scroll memory for the current Session.
   */
  setStore(store: PositionStore): void { this.store = store }

  /**
   * Adopt whether the saved reader row has a resident order key.
   *
   * Fork patch (FORK_SURFACE.md): the mounted window resolves the saved anchor
   * itself, so an anchor it cannot place has no row to restore onto.
   * @param resolved - whether the mounted window resolved the saved anchor row.
   */
  setAnchorResolved(resolved: boolean): void { this.anchorResolved = resolved }

  /**
   * Connect history policy to settled reading observations.
   * @param sampled - receives settled reader positions.
   * @returns a disposer that disconnects only this listener.
   */
  connect(sampled: (sample: ReadingSample) => void): () => void {
    this.sampled = sampled
    return () => { if (this.sampled === sampled) this.sampled = null }
  }

  /** Cancel timers and animation frames and detach the sample listener. */
  dispose(): void {
    this.cancelPending()
    this.sampled = null
  }

  /** Release bottom follow and pending sampling for an explicit navigation. */
  pauseFollowing(): void {
    this.cancelPending()
    this.publish({ ...this.state, followingTail: false })
  }

  /** Land at the current floor and clear saved reader position. */
  followTail(): void {
    const landing = this.viewport.scrollToBottom(this.follow)
    if (landing === null) return
    this.cancelPending()
    // Fork patch (FORK_SURFACE.md): reaching the floor releases the reflow anchor.
    this.viewport.armReflow(null)
    this.commit(landing, true, this.viewport.latestTurn)
  }

  /** Restore the Session's semantic position, or follow the tail when none is saved. */
  restore(): void {
    const saved = this.store.read()
    if (saved === null) { this.followTail(); return }
    const landing = this.viewport.restore(saved)
    if (landing === null) return
    this.cancelPending()
    // Fork patch (FORK_SURFACE.md): the raw-position fallback lands on the mounted
    // floor rather than the reader's row, so an anchor with no resident row has
    // nothing to restore onto: keep the saved position and leave the tail
    // unowned instead of committing the fallback as a tail landing.
    if (landing.position === null && !this.anchorResolved) {
      this.commit(landing, false, this.state.activeTurn)
      this.refreshActiveTurn()
      return
    }
    const following = this.follow.nearBottom(landing.metrics)
    this.commit(landing, following, following ? this.viewport.latestTurn : this.state.activeTurn, following)
    if (this.state.followingTail) this.viewport.armReflow(null)
    else {
      const position = landing.position ?? this.viewport.capturePosition()
      if (landing.position === null && position !== null) this.store.save(position)
      // Fork patch (FORK_SURFACE.md): a restored off-bottom position must arm the
      // reflow anchor, or later folds and image loads above the reading line have
      // no row to compensate after this mount.
      this.viewport.armReflow(position)
    }
    this.refreshActiveTurn()
  }

  /**
   * Adopt a known landing without rediscovering its anchor.
   * @param landing - measured navigation result that replaces pending reader input.
   */
  acceptNavigation(landing: ViewportLanding): void {
    this.cancelPending()
    const following = this.follow.nearBottom(landing.metrics)
    this.commit(landing, following, landing.turn ?? (following ? this.viewport.latestTurn : this.state.activeTurn))
    // Fork patch (FORK_SURFACE.md): the jump's own write suppresses the next
    // reader sample, so re-arm the reflow hold from the row it landed on.
    this.viewport.armReflow(following ? null : landing.position)
  }

  /**
   * Retain reading policy while history changes the anchor's geometry.
   * @param landing - compensated position that retains the current reading policy.
   */
  preservePosition(landing: ViewportLanding): void {
    this.cancelPending()
    this.commit(landing, this.state.followingTail, this.state.activeTurn)
  }

  /**
   * Handle pinned layout movement and reader arrivals at the floor immediately.
   * @param scroll - attributed scroll delivery; other reader movement remains pending until sampled.
   */
  readonly onScroll = (scroll: ViewportScroll): void => {
    if ((!scroll.movedByReader && this.state.followingTail)
      || (scroll.movedByReader && scroll.metrics.top >= scroll.metrics.floor)) {
      this.followTail()
      this.sampled?.({ position: null, movedByReader: scroll.movedByReader, followingTail: true })
      return
    }
    this.sampleTimer ??= window.setTimeout(this.flushSample, SCROLL_SAMPLE_INTERVAL_MS)
  }

  /** Settle pending reader movement at the browser's scrollend. */
  readonly onScrollEnd = (): void => { this.flushSample() }

  /**
   * Re-read the reader's position after their own gesture stepped the window head.
   *
   * Fork patch (FORK_SURFACE.md): the step mounts rows above the reading line, so
   * the held row moved; re-asserting it would write the scrollport back down and
   * undo the gesture. The row now at the reading line is the reader's position, so
   * the reflow hold and the saved memory move to it instead.
   */
  settleStep(): void {
    this.cancelPending()
    const scroll = this.viewport.readScroll()
    if (scroll === null) return
    const position = this.viewport.capturePosition()
    this.viewport.armReflow(position)
    if (position !== null) this.store.save(position)
    const activeTurn = this.follow.nearBottom(scroll.metrics)
      ? this.viewport.latestTurn
      : this.viewport.readVisibleTurn(scroll.metrics)
    this.publish({ ...this.state, initialized: true, activeTurn })
  }

  /**
   * Hold one known reader row for reflows that no prepend compensates.
   *
   * Fork patch (FORK_SURFACE.md): the mounted window re-mounts the session's
   * saved row itself, so its position re-arms the reflow hold.
   * @param position - semantic reader position to hold; null releases the hold.
   */
  hold(position: ChatScrollPosition | null): void { this.viewport.armReflow(position) }

  /** Reconcile a layout change without overriding unsampled reader input. */
  onResize(): void {
    if (this.pending) return
    if (this.state.followingTail) this.followTail()
    else this.refreshActiveTurn()
  }

  /**
   * Re-assert the held reader row after a non-prepend flow-height change.
   *
   * Fork patch (FORK_SURFACE.md): the paging anchor is retained only across
   * history work, so a fold collapse, image load, or disclosure above an
   * off-floor reader otherwise shifts the page by its full growth.
   * @returns whether a held reader row was re-asserted and saved.
   */
  reflow(): boolean {
    if (this.pending) return false
    const position = this.viewport.restoreReflow()
    if (position === null) return false
    this.store.save(position)
    return true
  }

  /** Resolve the active turn from tail ownership or a coalesced reading-line probe. */
  refreshActiveTurn(): void {
    if (this.pending) return
    if (this.state.followingTail) {
      this.publish({ ...this.state, initialized: true, activeTurn: this.viewport.latestTurn })
      return
    }
    if (this.probeFrame !== null) return
    if (typeof requestAnimationFrame !== 'function') this.probe()
    else this.probeFrame = requestAnimationFrame(this.probe)
  }

  private commit(
    landing: ViewportLanding, followingTail: boolean, activeTurn: number | null, initialized = true,
  ): void {
    if (followingTail) this.store.save(null)
    else if (landing.position !== null) this.store.save(landing.position)
    this.publish({ initialized, followingTail, activeTurn })
  }

  private publish(state: ChatReadingState): void {
    this.follow.setFollowing(state.followingTail)
    if (state.initialized === this.state.initialized && state.followingTail === this.state.followingTail
      && state.activeTurn === this.state.activeTurn) return
    this.state = state
    this.onChange(state)
  }

  private cancelPending(): void {
    if (this.sampleTimer !== null) window.clearTimeout(this.sampleTimer)
    if (this.probeFrame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.probeFrame)
    this.sampleTimer = null
    this.probeFrame = null
  }

  private readonly probe = (): void => {
    this.probeFrame = null
    if (this.pending) return
    const scroll = this.viewport.readScroll()
    if (scroll === null) return
    const activeTurn = this.follow.nearBottom(scroll.metrics) ? this.viewport.latestTurn : this.viewport.readVisibleTurn(scroll.metrics)
    this.publish({ ...this.state, initialized: true, activeTurn })
  }

  private readonly flushSample = (): void => {
    if (!this.pending) return
    this.cancelPending()
    const scroll = this.viewport.readScroll()
    if (scroll === null) return
    const followingTail = this.follow.sample(scroll.metrics, scroll.movedByReader)
    let position: ChatScrollPosition | null = null
    if (!scroll.movedByReader && followingTail) this.followTail()
    else {
      position = followingTail ? null : this.viewport.capturePosition()
      this.viewport.acknowledge(scroll.metrics)
      if (followingTail || position !== null) this.store.save(position)
      // Fork patch (FORK_SURFACE.md): hold the reader's row for reflows that no
      // prepend compensates, refreshed by every settled reader sample.
      this.viewport.armReflow(position)
      const activeTurn = this.follow.nearBottom(scroll.metrics) ? this.viewport.latestTurn : this.viewport.readVisibleTurn(scroll.metrics)
      this.publish({ initialized: true, followingTail, activeTurn })
    }
    this.sampled?.({ position, movedByReader: scroll.movedByReader, followingTail })
  }
}

/**
 * Retain reading policy and expose only changes in visible reading state.
 * @param viewport - turn-aware DOM operations.
 * @param store - Session-owned semantic scroll memory.
 * @param initialTurn - latest loaded turn before the first landing.
 * @returns the reading owner and its React-visible state.
 */
export function useChatReading(
  viewport: ChatViewport, store: PositionStore, initialTurn: number | null,
): { reading: ChatReading; state: ChatReadingState } {
  const [state, setState] = useState<ChatReadingState>(() => ({
    initialized: false,
    followingTail: store.read() === null,
    activeTurn: initialTurn,
  }))
  const follow = useScrollFollow(state.followingTail, FOLLOW_THRESHOLD + 1)
  const [reading] = useState(() => new ChatReading(viewport, store, state, setState, follow))
  useLayoutEffect(() => { reading.setStore(store) }, [reading, store])
  useLayoutEffect(() => () => { reading.dispose() }, [reading])
  return { reading, state }
}
