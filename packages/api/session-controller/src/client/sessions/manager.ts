/** Host catalog, durable projection caches, and explicitly retained Client instances. */

import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import { SessionSeq, type SessionId, type SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {
  SessionControlBaseline,
  SessionControlFrame,
  SessionProjectionHints,
  SessionRenameValue,
  SessionSummary,
} from '../../types.ts'
import { mergeOrderedBaseline } from '../ordered-baseline.ts'
import { isRemoteFailure } from '@deepseek-ai/dsh-api-gateway/client'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionListEntry, TitledSessionSummary } from './lineage.ts'
import { flattenLineage } from './lineage.ts'
// Type-only merge edge: the title domain's client-namespace outlet declares
// the 'title' projection key this manager projects into list rows (and any
// useProjection('title') consumer reads). Zero value imports by construction.
import type {} from '@deepseek-ai/dsh-session-title/client'
import { Notifier } from './notifier.ts'
import { ProjectionValueStore } from './projection-store.ts'
import { Session } from './session.ts'
import type { SessionRemotes } from './remotes.ts'
import type { SessionTarget } from '../contract/sessions.ts'
// Fork patch (FORK_SURFACE.md): ambient activity events coalesce in
// fork/coalesced-refresh.ts, so continuous streams from other sessions stop
// driving one full list rebuild per event render.
import { ACTIVITY_COALESCE_MS, ActivityCoalescer, affectsSessionList } from './fork/coalesced-refresh.ts'

function sessionSeqCursor(value: number): SessionSeqCursor {
  return value === -1 ? -1 : SessionSeq(value)
}

/**
 * Maximum ancestor parent reads one `loadChildren` walk may add above the
 * opened Session. Subagent depth is a Host-side, deployment-varying
 * configuration, so this client bound is what keeps an unknown or malformed
 * parent chain from turning one open into an unbounded read fan-out. Past it
 * the breadcrumb truncates at the deepest ancestor row read.
 */
const ANCESTRY_READ_LIMIT = 8

/**
 * List arrival lifecycle, orthogonal to the pull-activity `state` axis:
 * `pending` (no successful pull yet — an empty items array means "nothing
 * arrived", not "nothing exists") → `ready` (at least one pull landed).
 * Monotone: `ready` never steps back — later pull failures and reconnect
 * re-pulls ride the `state`/`error` axis, which is where failure is modeled
 * (no `error` phase here; that would duplicate `state`).
 */
export type SessionListPhase = 'pending' | 'ready'

/** Request-local content hit returned to sidebar search consumers. */
export interface SessionSearchResultItem {
  sessionId: SessionId
  snippet: string
}

/** Immutable session-list snapshot for useSessionList. */
export interface SessionListSnapshot {
  items: readonly SessionListEntry[]
  state: 'idle' | 'loading' | 'error'
  /** Arrival lifecycle (see {@link SessionListPhase}); `state` stays the pull-activity axis. */
  phase: SessionListPhase
  error: RemoteFailure | null
  projectionsBySession: Readonly<Record<SessionId, SessionProjectionSnapshot>>

}

/** Shared projection values and the lifecycle of their explicit baseline read. */
export interface SessionProjectionSnapshot {
  readonly values: Readonly<Partial<SessionProjectionMap>>
  readonly state: 'idle' | 'loading' | 'ready' | 'error'
  readonly error: RemoteFailure | null
}

interface ProjectionInflight {
  readonly promise: Promise<void>
  readonly controller: AbortController
}

type ProjectionLoad = Omit<SessionProjectionSnapshot, 'values'>

type SessionListMutation =
  | { kind: 'upsert' | 'placeholder'; summary: SessionSummary }
  | { kind: 'remove'; sessionId: SessionId }
  | { kind: 'status'; sessionId: SessionId; running: boolean; agentAvailable: boolean }
  | { kind: 'activity'; sessionId: SessionId; updatedAt: number }
  /** Local first-send flip: the sender clears blank without waiting for a host frame. */
  | { kind: 'engaged'; sessionId: SessionId }

/** Instance cluster + frame entry + the session list. */
export class SessionManager {
  private readonly sessions = new Map<SessionId, Session>()
  /** In-flight Session disposals remain here after instances leave `sessions`, so manager disposal can await quiescence. */
  private readonly sessionDisposals = new Set<Promise<void>>()
  /**
   * Accepted/running presentation must survive a later empty-history list
   * response. Host-asserted running is recorded even before a row, instance, or
   * address holds the identity — the listing that would hold it may not have
   * landed yet — while the client-local acceptance callback requires a current
   * holder, because it can arrive from a replaced or already-dropped Session.
   */
  private readonly engagedSessions = new Set<SessionId>()
  private disposed = false
  /** Per-session projection value stores, retained independently of instance arrival (the
   *  title-snapshot precedent, generalized): push frames land here whether or not the Session
   *  is instantiated (list rows read the 'title' key), and an instantiated Session adopts the
   *  same store so history-baseline seeding and frames converge on one row set. */
  private readonly projectionStores = new Map<SessionId, ProjectionValueStore>()
  private summaries: SessionSummary[] = []
  private listState: 'idle' | 'loading' | 'error' = 'idle'
  /** Arrival phase; the pending → ready edge fires on the first successful pull (see SessionListPhase). */
  private listPhase: SessionListPhase = 'pending'
  private listError: RemoteFailure | null = null
  private listInflight: Promise<void> | null = null
  /** Active list request's mutation log; its identity also fences completion after reconnect. */
  private listMutations: SessionListMutation[] | null = null
  private readonly addresses = new Map<SessionId, SubagentAddress>()
  /**
   * Subagent rows the client knows about — read for an opened Session or
   * announced by a frame. The listed pull omits subagent rows, so their absence
   * from a response is not a removal; the rows themselves live in `summaries`,
   * where later frames and mutations keep updating them.
   */
  private readonly retainedChildIds = new Set<SessionId>()
  /**
   * Sessions removed since this generation's reads started. A children read
   * response was computed before its removal frame and must not merge the
   * stale row back; a later add or a fresh generation supersedes the mark.
   */
  private readonly removedChildIds = new Set<SessionId>()
  /** Child reads by parent; one request per parent per Host generation. */
  private readonly childReads = new Map<SessionId, Promise<void>>()
  /**
   * Host generation a children read belongs to. `handleConnected` advances it
   * before clearing `childReads`: a response whose generation was superseded
   * reflects pre-reset state and must neither merge over nor forget against the
   * state the fresh reads establish.
   */
  private childReadGeneration = 0
  private readonly projectionLoads = new Map<SessionId, ProjectionLoad>()
  private readonly projectionInflight = new Map<SessionId, ProjectionInflight>()


  private listSnapshotCache: SessionListSnapshot
  /** Entry-identity cache (reference stability): list rebuilds reuse the previous entry
   *  object when every field matches — wire refreshes mint all-new summary objects, so identity
   *  must be recovered by value or every SessionListItem memo misses on every refresh. */
  private entryCache = new Map<SessionId, SessionListEntry>()
  private itemsCache: readonly SessionListEntry[] = []
  /** Fork patch (FORK_SURFACE.md): continuous activity frames buffered per session
   *  (latest timestamp wins) and flushed about once per second. */
  private readonly activityCoalescer = new ActivityCoalescer<SessionId>(ACTIVITY_COALESCE_MS, (pending) => {
    for (const [sessionId, updatedAt] of pending) {
      this.recordMutation({ kind: 'activity', sessionId, updatedAt })
    }
  })
  private readonly notifier = new Notifier(() => {
    this.listSnapshotCache = this.buildListSnapshot()
  })

  /** @param remote - generated Remote namespaces used by catalog and history readers. */
  constructor(private readonly remote: SessionRemotes) {
    this.listSnapshotCache = this.buildListSnapshot()
  }

  /**
   * Resolve an acquisition target without materializing a Session.
   * @param target - known identity or durable direct-parent address.
   * @returns the resolved identity with its explicit or catalog-derived history route installed.
   */
  resolveTarget(target: SessionTarget): SessionId {
    const id = typeof target === 'string' ? target : target.childSessionId
    const address = typeof target === 'string' ? this.subagentAddress(id) : target
    if (typeof target === 'string'
      && !this.sessions.has(id)
      && !this.summaries.some(summary => summary.sessionId === id)
      && address === undefined) {
      throw new Error(`sessions.retain: unknown session ${id}`)
    }
    if (address !== undefined) this.addresses.set(id, address)
    this.sessions.get(id)?.configureSubagent(
      address,
      address === undefined
        ? undefined
        : this.agentAvailable(address.parentSessionId),
    )
    return id
  }

  /**
   * Resolve an address for breadcrumb navigation without retaining transport authority.
   * @param sessionId - possible child id in an already-loaded catalog.
   * @returns A retained or catalog-derived direct-parent address.
   */
  subagentAddress(sessionId: SessionId): SubagentAddress | undefined {
    const retained = this.addresses.get(sessionId)
    if (retained !== undefined) return retained
    for (const parentSessionId of this.projectionStores.keys()) {
      const child = this.projectionStores.get(parentSessionId)?.values().subagentCatalog
        ?.find(entry => entry.id === sessionId)
      if (child !== undefined) {
        return {
          parentSessionId,
          childSessionId: sessionId,
          mode: child.mode,
        }
      }
    }
    return undefined
  }

  // ---- Instance management ----

  /**
   * Withdraw an exact Client instance before running its teardown callbacks.
   * @param sessionId - identity to withdraw.
   * @param expected - instance being released; a replacement is left untouched.
   * @returns completion of the detached instance's stream teardown.
   */
  drop(sessionId: SessionId, expected: Session): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session !== expected) return Promise.resolve()
    this.sessions.delete(sessionId)
    this.addresses.delete(sessionId)
    this.pruneEngagement(sessionId, this.retainedIds(this.summaries))
    return this.startSessionDisposal(session)
  }

  /**
   * Stop catalog requests and dispose every resident Session.
   * @returns once catalog requests and every Session stream have stopped.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    this.activityCoalescer.dispose()
    this.listMutations = null
    this.listInflight = null
    this.engagedSessions.clear()
    this.retainedChildIds.clear()
    this.childReads.clear()
    const reads = [...this.projectionInflight.values()]
    for (const { controller } of reads) controller.abort()
    this.projectionInflight.clear()
    await Promise.all(reads.map(read => read.promise))
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    this.addresses.clear()
    for (const session of sessions) void this.startSessionDisposal(session)
    await this.drainSessionDisposals()
  }

  private startSessionDisposal(session: Session): Promise<void> {
    const disposal = session.dispose()
    this.sessionDisposals.add(disposal)
    void disposal.then(
      () => { this.sessionDisposals.delete(disposal) },
      () => { this.sessionDisposals.delete(disposal) },
    )
    return disposal
  }

  private async drainSessionDisposals(): Promise<void> {
    while (this.sessionDisposals.size > 0) {
      await Promise.allSettled([...this.sessionDisposals])
    }
  }

  /**
   * Lazy build: return the existing instance or construct one (no auto-open —
   * the reference allocator opens history after binding the scope).
   * New instances reconcile retained metadata before returning.
   * @param sessionId - the session to get.
   * @returns the resident instance.
   */
  get(sessionId: SessionId): Session {
    let session = this.sessions.get(sessionId)
    if (session === undefined) {
      session = this.createSession(sessionId)
      this.sessions.set(sessionId, session)
      // Sync the running and blank bits from the list snapshot into the new
      // instance (consistency when the list precedes open).
      const summary = this.summaries.find(s => s.sessionId === sessionId)
      if (summary !== undefined) {
        session.handleBlank(this.effectiveBlank(summary))
        session.handleRunning(summary.running)
      } else {
        const address = this.addresses.get(sessionId)
        const child = address === undefined ? undefined : this.projectionStores.get(address.parentSessionId)?.values().subagentCatalog
          ?.find(entry => entry.id === sessionId)
        if (child !== undefined) {
          // A catalogued child exists only after its delegated session has
          // durable history, even though child rows do not carry `blank`.
          session.handleBlank(false)
          session.handleRunning(false)
        } else {
          // Retained metadata may have notified before this Session existed.
          session.handleBlank(true)
        }
      }
    }
    return session
  }

  private createSession(sessionId: SessionId): Session {
    const address = this.addresses.get(sessionId)
    const parentAvailable = address === undefined
      ? undefined
      : this.agentAvailable(address.parentSessionId)
    return new Session(sessionId, this.remote, {
      ...(address === undefined ? {} : {
        address,
        ...parentAvailable === undefined ? {} : { parentAvailable },
      }),
      // The sender's local first-send flip mirrors into the list row so the
      // session surfaces (lists filter on blank) before any host frame lands.
      onEngaged: (engaged) => {
        if (this.disposed || !this.retainedIds(this.summaries).has(engaged.sessionId)) return
        // An identity already on the ledger needs no second row mutation.
        if (!this.engagedSessions.has(engaged.sessionId)) {
          this.engagedSessions.add(engaged.sessionId)
          this.recordMutation({ kind: 'engaged', sessionId: engaged.sessionId })
        }
        this.sessions.get(engaged.sessionId)?.handleBlank(false)
      },
      projections: this.projectionStore(sessionId),
    })
  }

  private effectiveBlank(summary: SessionSummary): boolean {
    return summary.blank && !this.engagedSessions.has(summary.sessionId)
  }

  /**
   * Identities an engagement may still belong to: the given list rows, resident
   * Session instances, retained child addresses, and retained subagent rows.
   * @param summaries - list rows of the caller's snapshot.
   * @returns the retained identity set.
   */
  private retainedIds(summaries: readonly SessionSummary[]): Set<SessionId> {
    const retained = new Set(summaries.map(summary => summary.sessionId))
    for (const sessionId of this.sessions.keys()) retained.add(sessionId)
    for (const sessionId of this.addresses.keys()) retained.add(sessionId)
    for (const sessionId of this.retainedChildIds) retained.add(sessionId)
    return retained
  }

  /**
   * Forget one engagement that no retained identity holds.
   * @param sessionId - identity whose engagement may be dropped.
   * @param retained - identities from {@link retainedIds} for the caller's snapshot.
   */
  private pruneEngagement(sessionId: SessionId, retained: ReadonlySet<SessionId>): void {
    if (!retained.has(sessionId)) this.engagedSessions.delete(sessionId)
  }

  /** Resident per-session projection store (create-on-demand; outlives instantiation). */
  private projectionStore(sessionId: SessionId): ProjectionValueStore {
    let store = this.projectionStores.get(sessionId)
    if (store === undefined) {
      store = new ProjectionValueStore()
      const projections = store
      store.subscribeAny((key) => {
        // Newer history or control metadata corrects a resident Session's stale list hint.
        if (key === 'sessionListMetadata' && projections.values().sessionListMetadata?.blank === false) {
          this.sessions.get(sessionId)?.handleBlank(false)
        }
        // Fork patch (FORK_SURFACE.md): the list plane republishes each row's
        // whole value map, so a frame carrying a key no list consumer reads must
        // not rebuild it (the exempt set and its evidence live in
        // fork/coalesced-refresh.ts).
        if (affectsSessionList(key)) this.notifier.markDirty()
      })
      this.projectionStores.set(sessionId, store)
    }
    return store
  }

  /**
   * Load a complete projection baseline once per connection; retry unsuccessful reads.
   * @param sessionId - Session to inspect without opening its conversation.
   * @returns completion of the current or newly started read.
   */
  refreshProjections(sessionId: SessionId): Promise<void> {
    const existing = this.projectionInflight.get(sessionId)
    if (existing !== undefined) return existing.promise
    if (this.projectionLoads.get(sessionId)?.state === 'ready') return Promise.resolve()
    const controller = new AbortController()
    const store = this.projectionStore(sessionId)
    const initialValues = store.values()
    // Fork patch (FORK_SURFACE.md): a frame that republishes its row's value
    // advances the watermark without touching values(), so the existence probe
    // below reads the watermarks too — an equal-valued landing during this read
    // must not let the missing answer clear the row it just confirmed.
    const initialSeqs = Object.keys(initialValues).map(key => store.seqOf(key))
    this.projectionLoads.set(sessionId, { state: 'loading', error: null })
    this.notifier.markDirty()
    const operation = (async () => {
      try {
        const result = await this.remote.session.projections({ sessionId }, controller.signal)
        if (controller.signal.aborted) return
        if (result.ok) {
          if (result.value !== null) {
            store.seed({ ...result.value, asOfSeq: sessionSeqCursor(result.value.asOfSeq) })
          } else if (store.values() === initialValues
            && Object.keys(initialValues).every((key, index) => store.seqOf(key) === initialSeqs[index])) {
            // A later frame proves existence independently of an earlier missing read.
            store.clear()
          }
          this.projectionLoads.set(sessionId, { state: 'ready', error: null })
        } else {
          this.projectionLoads.set(sessionId, { state: 'error', error: result.error })
        }
      } catch (error: unknown) {
        if (controller.signal.aborted) return
        if (!isRemoteFailure(error)) throw error
        this.projectionLoads.set(sessionId, { state: 'error', error })
      } finally {
        if (!controller.signal.aborted) {
          this.projectionInflight.delete(sessionId)
          this.notifier.markDirty()
        }
      }
    })()
    this.projectionInflight.set(sessionId, { promise: operation, controller })
    return operation
  }

  private agentAvailable(sessionId: SessionId): boolean | undefined {
    return this.summaries.find(summary => summary.sessionId === sessionId)?.agentAvailable
      ?? (this.listPhase === 'ready' ? false : undefined)
  }

  private updateParentAvailability(): void {
    for (const [childId, address] of this.addresses) {
      const available = this.agentAvailable(address.parentSessionId)
      if (available !== undefined) this.sessions.get(childId)?.handleSubagentParentAvailable(available)
    }
  }

  // ---- List API ----

  /** Full refresh of the listed scope via session.list (single-flight within one Host generation). */
  refreshList(): Promise<void> {
    if (this.listInflight !== null) return this.listInflight
    this.listState = 'loading'
    this.listError = null
    const established = this.summaries
    const mutations: SessionListMutation[] = []
    this.listMutations = mutations
    this.notifier.markDirty()
    this.listInflight = (async () => {
      try {
        const result = await this.remote.session.list({ scope: 'listed' })
        if (this.listMutations !== mutations) return
        if (result.ok) {
          const baseline: SessionSummary[] = this.listPhase === 'pending'
            ? [...result.value.items]
            : mergeOrderedBaseline(established, result.value.items, summary => summary.sessionId)
          // A removal supersedes running observed in the pull, including after re-addition.
          const removedSincePull = new Set<SessionId>()
          for (const mutation of mutations) {
            if (mutation.kind === 'remove') removedSincePull.add(mutation.sessionId)
          }
          for (const s of baseline) {
            if (s.running && !removedSincePull.has(s.sessionId)) this.engagedSessions.add(s.sessionId)
          }
          const summaries = this.retainScopedChildren(
            mutations.reduce(applyMutation, baseline),
            mutations.reduce(applyMutation, established),
          )
          this.summaries = summaries
          // A full list can remove identities without a removal frame.
          const retained = this.retainedIds(summaries)
          for (const sessionId of this.engagedSessions) this.pruneEngagement(sessionId, retained)
          this.listState = 'idle'
          this.listPhase = 'ready'
          this.updateParentAvailability()
          // Resident Sessions and list rows share one display blank, reconciled with the metadata projection.
          for (const s of this.summaries) {
            const session = this.sessions.get(s.sessionId)
            if (session === undefined) continue
            session.handleBlank(this.effectiveBlank(s))
            session.handleRunning(s.running)
          }
          // Land each row's projection block in the per-session value store
          // (cold titles surface without opening the session). A list block is
          // partial — only the keys its source holds — so an absent key never
          // clears; how the present keys merge depends on the block's kind.
          for (const s of result.value.items) {
            if (s.projections !== undefined) this.applyListBlock(s.sessionId, s.projections)
          }
        } else {
          this.listState = 'error'
          this.listError = result.error
        }
      } catch (error) {
        if (!isRemoteFailure(error)) throw error
        if (this.listMutations !== mutations) return
        this.listState = 'error'
        this.listError = error
      } finally {
        if (this.listMutations === mutations) {
          this.listMutations = null
          this.listInflight = null
          this.notifier.markDirty()
        }
      }
    })()
    return this.listInflight
  }

  /**
   * Read the children of one opened Session into the catalog, then walk the
   * opened Session's ancestry so every subagent ancestor row arrives too. The
   * listed scope omits subagent rows, so a subagent row exists only in its own
   * parent's children read; without the walk a breadcrumb truncates at the
   * first ancestor the client never read. Each parent is read once per Host
   * generation, and the walk stops after {@link ANCESTRY_READ_LIMIT} ancestors.
   * @param sessionId - the opened Session whose children are requested.
   * @returns completion of the current or newly started reads; a failed read
   *   leaves the rows already catalogued in place.
   */
  loadChildren(sessionId: SessionId): Promise<void> {
    const reads = [this.readChildren(sessionId)]
    const seen = new Set<SessionId>([sessionId])
    let cursor = sessionId
    let ancestors = 0
    while (this.isSubagentSession(cursor)) {
      const parentSessionId = this.ancestorParent(cursor)
      if (parentSessionId === undefined || seen.has(parentSessionId)) break
      if (ancestors === ANCESTRY_READ_LIMIT) {
        console.warn(`[session-controller] Session ancestry read stopped at ${String(ANCESTRY_READ_LIMIT)} ancestors for "${sessionId}"`)
        break
      }
      ancestors++
      seen.add(parentSessionId)
      reads.push(this.readChildren(parentSessionId))
      cursor = parentSessionId
    }
    return Promise.all(reads).then(() => undefined)
  }

  /**
   * Resolve one Session's direct parent from client-held knowledge only: its
   * loaded row, an installed address, or a parent catalog that lists it. A
   * Session whose parent is unknown is a chain end, never a fetch.
   * @param sessionId - Session whose direct parent is resolved.
   * @returns the parent identity, or undefined when the client cannot name it.
   */
  private ancestorParent(sessionId: SessionId): SessionId | undefined {
    const row = this.summaries.find(summary => summary.sessionId === sessionId)
    if (row?.parentSessionId !== undefined) return row.parentSessionId
    return this.subagentAddress(sessionId)?.parentSessionId
  }

  /**
   * Whether one identity is a subagent row the ancestry walk may climb. An
   * ordinary Session's own parent never renders, so the walk ends there.
   * @param sessionId - Session whose row identity is classified.
   * @returns true for a known subagent identity.
   */
  private isSubagentSession(sessionId: SessionId): boolean {
    const row = this.summaries.find(summary => summary.sessionId === sessionId)
    if (row !== undefined) return row.origin === 'subagent'
    return this.subagentAddress(sessionId) !== undefined
  }

  /**
   * Read one parent's direct children. Rows merge as ordinary catalog
   * additions, and a successful read is also the membership authority for that
   * parent: retained child rows the Host no longer returns are forgotten, so a
   * deletion cannot leave a phantom row. A failed read retries on the next open
   * instead of failing it, and a response from a superseded Host generation is
   * discarded because the fresh reads own the catalog then.
   * @param parentSessionId - parent whose direct children are requested.
   * @returns completion of the current or newly started read.
   */
  private readChildren(parentSessionId: SessionId): Promise<void> {
    const existing = this.childReads.get(parentSessionId)
    if (existing !== undefined) return existing
    // Children retained when the read starts. A frame can add a child while the
    // read is in flight; that row is not a candidate for this response's removal.
    const candidates = this.retainedChildrenOf(parentSessionId)
    const generation = this.childReadGeneration
    const operation = (async () => {
      try {
        const result = await this.remote.session.list({ parentSessionId })
        if (this.disposed || generation !== this.childReadGeneration) return
        if (!result.ok) {
          this.childReads.delete(parentSessionId)
          return
        }
        // Fork patch (FORK_SURFACE.md): the response merges in one pass instead
        // of one full-array rewrite per child (see mergeChildren).
        this.mergeChildren(result.value.items)
        const present = new Set(result.value.items.map(child => child.sessionId))
        for (const sessionId of candidates) {
          if (!present.has(sessionId)) this.forgetRetainedChild(sessionId)
        }
      } catch (error: unknown) {
        if (generation === this.childReadGeneration) this.childReads.delete(parentSessionId)
        // A read failure is a degradation, not an open failure: the listed rows
        // stay authoritative. Anything but a Remote failure is a defect.
        if (!isRemoteFailure(error)) {
          console.error(`[session-controller] Session children read for "${parentSessionId}" failed:`, error)
        }
      }
    })()
    this.childReads.set(parentSessionId, operation)
    return operation
  }

  /**
   * Restore retained subagent rows over a listed pull. Each restored row
   * carries the values established before the pull plus every replayed frame
   * mutation, and appends after the merged listing rows; display position is
   * re-derived later from parent links by `flattenLineage`.
   * @param summaries - baseline rows plus replayed mutations.
   * @param live - rows established before the pull plus replayed mutations.
   * @returns the rows, with every still-retained child restored.
   */
  private retainScopedChildren(
    summaries: SessionSummary[],
    live: readonly SessionSummary[],
  ): SessionSummary[] {
    if (this.retainedChildIds.size === 0) return summaries
    const present = new Set(summaries.map(summary => summary.sessionId))
    const retained = live.filter(summary => (
      this.retainedChildIds.has(summary.sessionId) && !present.has(summary.sessionId)
    ))
    return retained.length === 0 ? summaries : [...summaries, ...retained]
  }

  /**
   * Retained subagent rows whose direct parent is the given Session.
   * @param parentSessionId - parent whose retained children are collected.
   * @returns the retained child identities known to belong to that parent.
   */
  private retainedChildrenOf(parentSessionId: SessionId): SessionId[] {
    const ids: SessionId[] = []
    for (const summary of this.summaries) {
      if (summary.parentSessionId === parentSessionId && this.retainedChildIds.has(summary.sessionId)) {
        ids.push(summary.sessionId)
      }
    }
    return ids
  }

  /**
   * Forget one retained child the Host no longer returns: its retention flag,
   * its list row, and any engagement that only the row held.
   * @param sessionId - retained child absent from a fresh children read.
   */
  private forgetRetainedChild(sessionId: SessionId): void {
    this.retainedChildIds.delete(sessionId)
    const next = this.summaries.filter(summary => summary.sessionId !== sessionId)
    if (next.length === this.summaries.length) return
    this.summaries = next
    this.pruneEngagement(sessionId, this.retainedIds(next))
    this.notifier.markDirty()
  }

  /**
   * Search visible session message content without adding transient query
   * state to the list snapshot.
   * @param query - non-blank literal phrase.
   * @param signal - cancellation for superseded UI queries.
   * @returns the Host result or a folded transport error.
   */
  async search(
    query: string,
    signal: AbortSignal,
  ): Promise<RemoteResult<{ items: SessionSearchResultItem[]; hasMore: boolean }>> {
    const result = await this.remote.session.search({ query }, signal)
    if (!result.ok) return result
    return {
      ok: true,
      value: {
        items: [...result.value.items],
        hasMore: result.value.hasMore,
      },
    }
  }

  /**
   * Contract session.create; on success merge into summaries immediately (no
   * wait for the next refresh). A created session is blank by definition
   * (entity birth precedes the first message).
   * @param opts - target workspace or working directory, plus an optional caller-owned id.
   * @returns the create result.
  */
  async create(
    opts: {
      workspaceId?: WorkspaceId
      cwd?: string
      sessionId?: SessionId
    } = {},
  ): Promise<RemoteResult<{ sessionId: SessionId }>> {
    const shared = opts.sessionId === undefined ? {} : { sessionId: opts.sessionId }
    const payload = opts.workspaceId !== undefined
      ? { workspaceId: opts.workspaceId, ...shared }
      : { ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }), ...shared }
    const result = await this.remote.session.create(payload)
    if (result.ok) {
      this.recordMutation({ kind: 'placeholder', summary: { agentAvailable: true,
        sessionId: result.value.sessionId, updatedAt: Date.now(), running: false, blank: true,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      } })
    } else {
      const publishedSessionId = workspaceAttachSessionId(result.error)
      // Publication precedes attachment. The error's id is a real Session,
      // so expose it immediately as Ungrouped while the caller keeps the
      // prompt buffer and decides whether to retry attachment.
      if (publishedSessionId !== undefined) {
        this.recordMutation({ kind: 'placeholder', summary: { agentAvailable: true,
          sessionId: publishedSessionId,
          updatedAt: Date.now(),
          running: false,
          blank: true,
        } })
      }
    }
    return result
  }

  /**
   * Contract session.fork; on success merge the child into summaries
   * immediately (same synchronous-addressability guarantee as create).
   * Blankness starts provisionally true so the authoritative Host summary can
   * preserve it or lower it after an exact cut before the first `turn/start`;
   * lineage rides parentSessionId. A child published before Workspace
   * attachment fails is also reconciled into the list.
   * @param opts - source session and the optional exact inclusive boundary seq.
   * @returns the fork result (the child session id).
   */
  async fork(
    opts: { sessionId: SessionId; atSeq?: SessionSeq },
  ): Promise<RemoteResult<{ sessionId: SessionId }>> {
    const source = this.summaries.find(s => s.sessionId === opts.sessionId)
    const result = await this.remote.session.fork({
      sessionId: opts.sessionId,
      ...opts.atSeq === undefined ? {} : { atSeq: opts.atSeq },
    })
    const childId = result.ok
      ? result.value.sessionId
      : workspaceAttachSessionId(result.error)
    if (childId !== undefined) {
      this.recordMutation({ kind: 'placeholder', summary: { agentAvailable: true,
        sessionId: childId, updatedAt: Date.now(), running: false, blank: true,
        parentSessionId: opts.sessionId,
        ...(source?.cwd !== undefined ? { cwd: source.cwd } : {}),
      } })
    }
    return result
  }

  /**
   * Rename a Session and update its title projection without opening its history.
   * @param sessionId - Session to rename.
   * @param title - raw title text for Host normalization.
   * @returns the accepted title and event position, or the Remote failure.
   */
  async rename(sessionId: SessionId, title: string): Promise<RemoteResult<SessionRenameValue>> {
    const result = await this.remote.session.rename({ sessionId, title })
    if (result.ok) {
      this.projectionStore(sessionId).apply('title', result.value.title, SessionSeq(result.value.seq))
    }
    return result
  }

  /**
   * Merge a Host summary, replacing live state and filling missing metadata.
   * Local create/fork placeholders only fill metadata on an existing row.
   */
  private mergeSummary(summary: SessionSummary): void {
    this.recordMutation({ kind: 'upsert', summary })
    this.updateParentAvailability()
  }

  /** Apply immediately and retain for replay when a list response is in flight. */
  private recordMutation(mutation: SessionListMutation): void {
    if (this.disposed) return
    this.listMutations?.push(mutation)
    const next = applyMutation(this.summaries, mutation)
    // Fork patch (FORK_SURFACE.md): a frame that flips nothing keeps the input
    // array identity, so the dirty flush has no rebuild to run.
    if (next === this.summaries) return
    this.summaries = next
    this.notifier.markDirty()
  }

  // ---- Subscription API (for useSessionList) ----

  /**
   * uSES subscription entry for useSessionList.
   * @param listener - change callback.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    return this.notifier.subscribe(listener)
  }

  /**
   * Cached list snapshot (rebuilt lazily when dirty with no listeners).
   * @returns the cached reference (stable until the next flush).
   */
  getListSnapshot(): SessionListSnapshot {
    this.notifier.ensureFresh()
    return this.listSnapshotCache
  }

  /**
   * Read cached projection values for a Session that may exist only in a loaded subagent catalog.
   * @param sessionId - Session whose control or history baseline supplied projections.
   * @returns current values, or undefined before any projection store exists.
   */
  projectionValues(sessionId: SessionId): Readonly<Partial<SessionProjectionMap>> | undefined {
    return this.projectionStores.get(sessionId)?.values()
  }

  // ---- Live control and Host-event sinks ----

  /**
   * Apply a complete control baseline or one later replacement frame.
   * @param frame - baseline or live control replacement from Session Controller.
   */
  handleControlFrame(frame: SessionControlFrame): void {
    if (frame.type === 'baseline') {
      this.replaceControlBaseline(frame.value)
      return
    }
    // The store's change channel drives the dirty flush: it reports the changed
    // key, so a frame that republishes its row's value changes nothing and one
    // carrying a key no list consumer reads rebuilds nothing
    // (fork/coalesced-refresh.ts holds the exempt set).
    this.projectionStore(frame.sessionId).apply(frame.key, frame.value, SessionSeq(frame.seq))
  }

  private replaceControlBaseline(baseline: SessionControlBaseline): void {

    for (const [sessionId, block] of Object.entries(baseline.projections)) {
      const store = this.projectionStore(sessionId as SessionId)
      const asOfSeq = sessionSeqCursor(block.asOfSeq)
      store.seed({ ...block, asOfSeq })
    }
    this.notifier.markDirty()
  }

  /**
   * Apply one Session-list addition forwarded through `ctx.remote.$on`.
   * Subagent rows are retained: the listed scope omits them, so a later pull
   * must not read as their removal. A children read (a whole response at once)
   * merges through {@link mergeChildren} instead.
   * @param summary - current Host summary for the added Session.
   */
  handleSessionAdded(summary: SessionSummary): void {
    if (summary.origin === 'subagent') this.retainedChildIds.add(summary.sessionId)
    // An add is newer than an earlier removal of the same identity.
    this.removedChildIds.delete(summary.sessionId)
    this.mergeSummary(summary)
    this.applyAddedSession(summary)
  }

  /**
   * Merge one children read in a single pass. A read returns a whole batch of
   * direct children at once (2,244 rows for the largest catalog measured), and
   * merging them one at a time through {@link recordMutation} copies the whole
   * summary array per child — O(rows × children) plus one discarded array per
   * child, measured at 99 ms of blocking work when opening one Session with that
   * catalog. The batch keeps every contract of the single-row path: the same
   * row values and positions (the shared {@link mergeSummaryRow}), the same
   * mutation entries in the same order, no rebuild when no row moved, and the
   * same retained-child, engagement, blank, projection-block and parent-
   * availability effects. A row whose removal frame arrived after this
   * response was computed stays out of the merge: the removal is the newer
   * fact, and it already holds the row in its post-removal form.
   * @param children - every row one children read returned, in response order.
   */
  private mergeChildren(children: readonly SessionSummary[]): void {
    if (children.length === 0) return
    // A removal observed after this response was computed is newer than the
    // row it carries, so the response must not raise the removed row's state
    // back. The removal already holds the row in its post-removal form.
    const mergeable = children.filter(child => !this.removedChildIds.has(child.sessionId))
    if (mergeable.length === 0) return
    for (const child of mergeable) {
      if (child.origin === 'subagent') this.retainedChildIds.add(child.sessionId)
    }
    if (!this.disposed) {
      for (const child of mergeable) this.listMutations?.push({ kind: 'upsert', summary: child })
      const merged = mergeSummaryRows(this.summaries, mergeable)
      if (merged !== this.summaries) {
        this.summaries = merged
        this.notifier.markDirty()
      }
    }
    for (const child of mergeable) this.applyAddedSession(child)
    // Once for the batch: a per-child pass recomputed the same parent rows from
    // the same array (and its find is a scan of every summary).
    this.updateParentAvailability()
  }

  /**
   * The effects one added Session's summary has beyond its list row, shared by
   * the single-frame and the batched children paths.
   * @param summary - summary of the Session that arrived.
   */
  private applyAddedSession(summary: SessionSummary): void {
    if (!this.disposed && summary.running) this.engagedSessions.add(summary.sessionId)
    this.sessions.get(summary.sessionId)?.handleBlank(this.effectiveBlank(summary))
    if (summary.projections !== undefined) this.applyListBlock(summary.sessionId, summary.projections)
  }

  /**
   * Merge one list-surface projection block by the sequence space it declares.
   * A `sequenced` block came from the Host's live registry for an attached
   * Session, so each key lands under higher-seq-wins against that Session's
   * baselines and frames. A `cached` block was viewed from the persisted
   * checkpoint by a header-only listing: its watermark is not comparable with
   * this connection's seqs, so it only fills keys no sequenced row holds.
   */
  private applyListBlock(sessionId: SessionId, block: SessionProjectionHints): void {
    const store = this.projectionStore(sessionId)
    switch (block.kind) {
      case 'sequenced': {
        const seq = sessionSeqCursor(block.asOfSeq)
        for (const [key, value] of Object.entries(block.values)) store.apply(key, value, seq)
        return
      }
      case 'cached':
        store.applyCached(block.values)
        return
      default:
        assertNever(block.kind, 'session list projection block kind')
    }
  }

  /**
   * Apply one Session removal forwarded through `ctx.remote.$on`.
   * @param sessionId - removed Session identity.
   */
  handleSessionRemoved(sessionId: SessionId): void {
    // A children read already in flight keeps a row computed before this
    // removal; remember the removal so that response cannot revive the row.
    this.removedChildIds.add(sessionId)
    // A child read for an opened Session is durable history even though the
    // listed scope omitted it: keep its status row rather than removing it.
    const durableSubagent = this.subagentAddress(sessionId) !== undefined
      || this.retainedChildIds.has(sessionId)
      || this.summaries.some(summary => summary.sessionId === sessionId && summary.origin === 'subagent')
    this.recordMutation(durableSubagent
      ? { kind: 'status', sessionId, running: false, agentAvailable: false }
      : { kind: 'remove', sessionId })
    if (durableSubagent) this.sessions.get(sessionId)?.handleRunning(false)
    else this.sessions.get(sessionId)?.handleRemoved()
    const catalog = this.projectionStores.get(sessionId)?.values().subagentCatalog
    if (!durableSubagent && (catalog === undefined || catalog.length === 0)) {
      this.projectionStores.delete(sessionId)
    }
    this.pruneEngagement(sessionId, this.retainedIds(this.summaries))
    this.projectionInflight.get(sessionId)?.controller.abort()
    this.projectionInflight.delete(sessionId)
    this.projectionLoads.delete(sessionId)
    for (const [childId, address] of this.addresses) {
      if (address.parentSessionId === sessionId) {
        this.sessions.get(childId)?.handleSubagentParentAvailable(false)
      }
    }
  }

  /**
   * Apply one live Agent running-state change.
   * @param sessionId - Session whose Agent state changed.
   * @param running - current Agent running state.
   */
  handleSessionStatus(sessionId: SessionId, running: boolean): void {
    if (!this.disposed && running) this.engagedSessions.add(sessionId)
    this.recordMutation({ kind: 'status', sessionId, running, agentAvailable: true })
    this.updateParentAvailability()
    this.sessions.get(sessionId)?.handleRunning(running)
  }

  /**
   * Advance Session-list activity from one user-authored durable message.
   * @param sessionId - Session whose activity changed.
   * @param updatedAt - durable message timestamp.
   */
  handleSessionActivity(sessionId: SessionId, updatedAt: number): void {
    this.activityCoalescer.collect(sessionId, updatedAt)
  }

  /**
   * Surface one live Agent failure on an already-materialized Session.
   * @param sessionId - Session whose Agent failed.
   * @param message - caller-visible failure description.
   */
  handleSessionError(sessionId: SessionId, message: string): void {
    this.sessions.get(sessionId)?.handleAgentError(message)
  }

  /**
   * Repair one re-established Host-event generation with queryable baselines.
   * Discard old projection cuts before new queries, including cold Sessions
   * absent from the process-local control baseline.
   * Opened Session follow streams resume independently through API Gateway.
   */
  handleConnected(): void {
    for (const store of this.projectionStores.values()) store.clear()
    this.listMutations = null
    this.listInflight = null
    void this.refreshList()
    const parents = new Set(this.projectionLoads.keys())
    for (const id of this.sessions.keys()) {
      const address = this.addresses.get(id)
      if (address !== undefined) parents.add(address.parentSessionId)
    }
    // The status stream replays nothing, so a subagent that finished while the
    // connection was down keeps its last running bit. A fresh children read is
    // the repair, and doubles as the membership check that drops rows the Host
    // no longer returns.
    const childParents = this.knownChildParents()
    for (const { controller } of this.projectionInflight.values()) controller.abort()
    this.projectionInflight.clear()
    this.projectionLoads.clear()
    // Advance before clearing: every response from the superseded generation
    // is discarded on arrival instead of merging over the fresh reads below.
    this.childReadGeneration++
    this.childReads.clear()
    this.removedChildIds.clear()
    for (const parentSessionId of parents) void this.refreshProjections(parentSessionId)
    for (const parentSessionId of childParents) void this.readChildren(parentSessionId)
    // Fork patch (FORK_SURFACE.md): a carrier reset aborts every logical stream;
    // failed session windows never re-open on their own (the chat stays frozen
    // on the last frame until a full page refresh), so reset re-opens the
    // errored ones through their existing history route.
    for (const session of this.sessions.values()) {
      if (session.getSnapshot().openState === 'error') {
        void session.resync().catch(() => {
          // A failed re-open keeps the session errored; snapshot.openError
          // already surfaces that failure to the UI.
        })
      }
    }
  }

  /**
   * Parents whose direct children this client already read or holds a row for.
   * A reconnect re-reads exactly these, so status repairs stay bounded by the
   * children the client knows instead of every Session in the new list.
   * @returns the parent identities to re-read.
   */
  private knownChildParents(): Set<SessionId> {
    const parents = new Set<SessionId>(this.childReads.keys())
    for (const summary of this.summaries) {
      if (summary.origin === 'subagent' && summary.parentSessionId !== undefined) {
        parents.add(summary.parentSessionId)
      }
    }
    return parents
  }

  private buildListSnapshot(): SessionListSnapshot {
    const merged: TitledSessionSummary[] = this.summaries.map((summary) => {
      // List rows read the generic 'title' projection key (host-computed unit
      // value; there is no dedicated title frame).
      const projectionStore = this.projectionStores.get(summary.sessionId)
      const title = projectionStore?.get('title')
      const projectionValues = projectionStore?.values()
      const metadata = projectionValues?.sessionListMetadata
      return {
        ...summary,
        // Cached list hints can precede a history opening or control update.
        blank: this.effectiveBlank(summary) && metadata?.blank !== false,
        updatedAt: Math.max(summary.updatedAt, metadata?.lastPromptAt ?? 0),
        ...(typeof title === 'string' && title !== '' ? { title } : {}),
        ...(projectionValues === undefined ? {} : { projectionValues }),
      }
    })
    const fresh = flattenLineage(merged)
    const items = fresh.map((entry) => {
      const prev = this.entryCache.get(entry.sessionId)
      if (
        prev !== undefined && prev.updatedAt === entry.updatedAt && prev.running === entry.running
        && prev.blank === entry.blank
        && prev.parentSessionId === entry.parentSessionId && prev.cwd === entry.cwd
        && prev.origin === entry.origin && prev.title === entry.title && prev.depth === entry.depth
        && prev.projectionValues === entry.projectionValues
      ) return prev
      this.entryCache.set(entry.sessionId, entry)
      return entry
    })
    const itemIds = new Set(items.map(entry => entry.sessionId))
    for (const id of this.entryCache.keys()) {
      if (!itemIds.has(id)) this.entryCache.delete(id)
    }
    const sameOrder = items.length === this.itemsCache.length && items.every((e, i) => e === this.itemsCache[i])
    if (!sameOrder) this.itemsCache = items
    return {
      items: this.itemsCache,
      state: this.listState,
      phase: this.listPhase,
      error: this.listError,
      projectionsBySession: Object.fromEntries([...this.projectionStores].map(([sessionId, store]) => [
        sessionId,
        { values: store.values(), state: 'idle', error: null, ...this.projectionLoads.get(sessionId) },
      ])),
    }
  }
}

/**
 * Merge one incoming summary over the row it replaces, or return that row when
 * no field it publishes moves. The single-mutation arm and the batched children
 * merge both call this, so one value contract governs them.
 * @param existing - the row the summary merges into.
 * @param incoming - the Host summary, or the local placeholder, to merge.
 * @param kind - `upsert` replaces live state, `placeholder` only fills metadata.
 * @returns the merged row, or `existing` itself when nothing moved.
 */
function mergeSummaryRow(
  existing: SessionSummary,
  incoming: SessionSummary,
  kind: 'upsert' | 'placeholder',
): SessionSummary {
  const filled: SessionSummary = {
    ...existing,
    // Blank only lowers: a stale true (session-added racing the local
    // first send) never re-hides an already-surfaced session.
    blank: existing.blank && incoming.blank,
    ...(kind === 'upsert' ? {
      agentAvailable: incoming.agentAvailable,
      running: incoming.running,
    } : {}),
    ...(existing.cwd === undefined && incoming.cwd !== undefined ? { cwd: incoming.cwd } : {}),
    ...(existing.parentSessionId === undefined && incoming.parentSessionId !== undefined
      ? { parentSessionId: incoming.parentSessionId } : {}),
    ...(existing.origin === undefined && incoming.origin !== undefined
      ? { origin: incoming.origin } : {}),
  }
  if (filled.cwd === existing.cwd && filled.parentSessionId === existing.parentSessionId
    && filled.origin === existing.origin && filled.blank === existing.blank
    && filled.agentAvailable === existing.agentAvailable && filled.running === existing.running
  ) return existing
  return filled
}

/**
 * Merge one batch of arriving rows in a single pass, with the value, position,
 * and object-identity semantics of one {@link applyMutation} upsert per row: a
 * row already present keeps its position and its object unless a field moves,
 * and a new row lands where the sequential prepend per row would have put it
 * (each new row ahead of the batch's earlier arrivals).
 * @param summaries - the current rows.
 * @param incoming - the batch, in arrival order.
 * @returns the merged rows, or `summaries` itself when the batch moves nothing.
 */
function mergeSummaryRows(
  summaries: SessionSummary[],
  incoming: readonly SessionSummary[],
): SessionSummary[] {
  const current = new Map<SessionId, SessionSummary>(summaries.map(row => [row.sessionId, row]))
  const added: SessionSummary[] = []
  let moved = false
  for (const summary of incoming) {
    const before = current.get(summary.sessionId)
    if (before === undefined) {
      current.set(summary.sessionId, summary)
      added.push(summary)
      moved = true
      continue
    }
    const merged = mergeSummaryRow(before, summary, 'upsert')
    if (merged === before) continue
    current.set(summary.sessionId, merged)
    moved = true
  }
  if (!moved) return summaries
  const rows = summaries.map(row => current.get(row.sessionId) ?? row)
  return added.length === 0 ? rows : [...added.reverse(), ...rows]
}

/**
 * Apply one list mutation without deriving display order; returns the input
 * array reference when the mutation flips nothing.
 * Fork patch (FORK_SURFACE.md): the no-op identity contract lets recordMutation
 * skip the dirty flush, so unchanged frames never rebuild the list.
 */
function applyMutation(summaries: SessionSummary[], mutation: SessionListMutation): SessionSummary[] {
  switch (mutation.kind) {
    case 'upsert':
    case 'placeholder': {
      const existing = summaries.find(summary => summary.sessionId === mutation.summary.sessionId)
      if (existing === undefined) return [mutation.summary, ...summaries]
      const filled = mergeSummaryRow(existing, mutation.summary, mutation.kind)
      if (filled === existing) return summaries
      return summaries.map(summary => summary.sessionId === mutation.summary.sessionId ? filled : summary)
    }
    case 'remove': {
      if (!summaries.some(summary => summary.sessionId === mutation.sessionId)) return summaries
      return summaries.filter(summary => summary.sessionId !== mutation.sessionId)
    }
    case 'status': {
      // Running converts display state; it does not establish durable history.
      const target = summaries.find(summary => summary.sessionId === mutation.sessionId)
      if (target === undefined
        || (target.running === mutation.running && target.agentAvailable === mutation.agentAvailable
          && !(mutation.running && target.blank))) return summaries
      return summaries.map(summary => summary.sessionId === mutation.sessionId
        ? { ...summary, running: mutation.running, agentAvailable: mutation.agentAvailable, blank: summary.blank && !mutation.running }
        : summary)
    }
    case 'activity': {
      const target = summaries.find(summary => summary.sessionId === mutation.sessionId)
      if (target === undefined || !(mutation.updatedAt > target.updatedAt)) return summaries
      return summaries.map(summary => summary.sessionId === mutation.sessionId
        ? { ...summary, updatedAt: mutation.updatedAt }
        : summary)
    }
    case 'engaged': {
      const target = summaries.find(summary => summary.sessionId === mutation.sessionId)
      if (target === undefined || !target.blank) return summaries
      return summaries.map(summary => summary.sessionId === mutation.sessionId
        ? { ...summary, blank: false }
        : summary)
    }
  }
}

/** Temporary source-plane bridge while the Host contract and client project build independently. */
function workspaceAttachSessionId(error: RemoteFailure): SessionId | undefined {
  return error.code === 'session/workspace-attach-failed' ? error.details.sessionId : undefined
}
