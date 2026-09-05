// Fork-owned snapshot-identity module (see FORK_SURFACE.md): entry-object identity,
// reference-stable subagents/jobs projections, and the equal-content snapshot reuse
// that upstream's session-list manager delegates to. One fork file keeps upstream's
// manager.ts at a minimal injection surface for future syncs.

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionJob as JobView } from '../../../types.ts'
import type { SessionListEntry } from '../lineage.ts'
import type {
  SessionListSnapshot,
  SubagentCatalogSnapshot,
} from '../manager.ts'

/**
 * Cache of the identity-stable parts of a session-list snapshot: entry objects,
 * the items array, and the subagents/jobs projections. The manager owns one
 * instance; its methods return the same object references whenever the content
 * did not move, so every SessionListItem memo and snapshot subscriber misses
 * only on real changes.
 */
export class SessionSnapshotIdentity {
  /** Entry-identity cache (reference stability): list rebuilds reuse the previous entry
   *  object when every field matches — wire refreshes mint all-new summary objects, so identity
   *  must be recovered by value or every SessionListItem memo misses on every refresh. */
  private readonly entryCache = new Map<SessionId, SessionListEntry>()
  private itemsCache: readonly SessionListEntry[] = []
  /** Reference-stable `subagentsByParent` projection: content-compare against the Map, keep
   *  the previous object when no catalog reference moved (Map values are replaced immutably,
   *  so a reference comparison is a complete change check). */
  private subagentsSnapshot: Readonly<Record<SessionId, SubagentCatalogSnapshot>> = {}
  /** Reference-stable `jobsBySession` projection, same policy as {@link stableSubagentsSnapshot}. */
  private jobsSnapshot: Readonly<Record<SessionId, readonly JobView[]>> = {}

  /**
   * Reference-stable list items: reuse the previous entry object when every
   * field matches, drop identities for departed sessions, and keep the previous
   * items array while the entry sequence is unchanged.
   * @param fresh - newly flattened display rows in render order.
   * @returns identity-stable rows (previous object references when content held).
   */
  stableEntries(fresh: readonly SessionListEntry[]): readonly SessionListEntry[] {
    const items = fresh.map((entry) => {
      const prev = this.entryCache.get(entry.sessionId)
      if (
        prev !== undefined && prev.updatedAt === entry.updatedAt && prev.running === entry.running
        && prev.blank === entry.blank
        && prev.parentSessionId === entry.parentSessionId && prev.cwd === entry.cwd
        && prev.origin === entry.origin && prev.title === entry.title && prev.depth === entry.depth
        && prev.projectionValues === entry.projectionValues
        && prev.completed === entry.completed
      ) return prev
      this.entryCache.set(entry.sessionId, entry)
      return entry
    })
    for (const id of this.entryCache.keys()) {
      if (!items.some(e => e.sessionId === id)) this.entryCache.delete(id)
    }
    const sameOrder = items.length === this.itemsCache.length && items.every((e, i) => e === this.itemsCache[i])
    if (!sameOrder) this.itemsCache = items
    return this.itemsCache
  }

  /**
   * Reference-stable `subagentsByParent`: the previous projection object while
   * no catalog reference moved (catalog set sites replace values immutably, so
   * a reference comparison is a complete change check).
   * @param catalogs - live per-session catalog snapshots.
   * @returns the previous projection object unless the Map moved a reference.
   */
  stableSubagentsSnapshot(
    catalogs: ReadonlyMap<SessionId, SubagentCatalogSnapshot>,
  ): Readonly<Record<SessionId, SubagentCatalogSnapshot>> {
    const cached = this.subagentsSnapshot
    const keys = Object.keys(cached)
    if (keys.length !== catalogs.size) return this.rebuildSubagentsSnapshot(catalogs)
    for (const key of keys) {
      if (catalogs.get(key as SessionId) !== (cached as Record<SessionId, SubagentCatalogSnapshot>)[key as SessionId]) {
        return this.rebuildSubagentsSnapshot(catalogs)
      }
    }
    return cached
  }

  private rebuildSubagentsSnapshot(
    catalogs: ReadonlyMap<SessionId, SubagentCatalogSnapshot>,
  ): Readonly<Record<SessionId, SubagentCatalogSnapshot>> {
    this.subagentsSnapshot = Object.fromEntries(catalogs)
    return this.subagentsSnapshot
  }

  /**
   * Reference-stable `jobsBySession`, same policy as
   * {@link stableSubagentsSnapshot}.
   * @param jobsBySession - live per-session background-job sets.
   * @returns the previous projection object unless the Map moved a reference.
   */
  stableJobsSnapshot(
    jobsBySession: ReadonlyMap<SessionId, readonly JobView[]>,
  ): Readonly<Record<SessionId, readonly JobView[]>> {
    const cached = this.jobsSnapshot
    const keys = Object.keys(cached)
    if (keys.length !== jobsBySession.size) return this.rebuildJobsSnapshot(jobsBySession)
    for (const key of keys) {
      if (jobsBySession.get(key as SessionId) !== (cached as Record<SessionId, readonly JobView[]>)[key as SessionId]) {
        return this.rebuildJobsSnapshot(jobsBySession)
      }
    }
    return cached
  }

  private rebuildJobsSnapshot(
    jobsBySession: ReadonlyMap<SessionId, readonly JobView[]>,
  ): Readonly<Record<SessionId, readonly JobView[]>> {
    this.jobsSnapshot = Object.fromEntries(jobsBySession)
    return this.jobsSnapshot
  }

  /**
   * Equal-content snapshot reuse: rebuilds land on the same observable content
   * more often than not (catalog refreshes, jobs frames, and projection echoes
   * that changed no list row), and a fresh object for equal content would
   * re-render and re-derive every subscriber.
   * @param previous - previously published snapshot, when one exists.
   * @param next - the freshly assembled candidate snapshot.
   * @returns `previous` when every observable field is identical, otherwise `next`.
   */
  publish(previous: SessionListSnapshot | undefined, next: SessionListSnapshot): SessionListSnapshot {
    if (previous !== undefined
      && previous.items === next.items
      && previous.current === next.current
      && previous.state === next.state
      && previous.phase === next.phase
      && previous.error === next.error
      && previous.subagentsByParent === next.subagentsByParent
      && previous.jobsBySession === next.jobsBySession
      && previous.currentAddress === next.currentAddress) {
      return previous
    }
    return next
  }
}
