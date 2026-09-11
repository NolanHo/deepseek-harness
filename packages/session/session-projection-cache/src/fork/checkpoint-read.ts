// Fork-owned checkpoint read module (see FORK_SURFACE.md): the web
// session-open fast path folds only a Session's history tail by reading its
// stored checkpoint rows instead of the whole log. The cache service registers
// its identity-checked lookup and the registry floor here, so the read stays a
// module-level helper without widening the service's generated public surface.

import type { SessionHeader, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { ProjectionCheckpoint } from '@deepseek-ai/dsh-session-projection'
import type SessionProjectionCache from '../index.ts'
import type { CheckpointRecord } from '../spec.ts'

/** One Session's stored checkpoint rows and the seq a projection tail read starts at. */
export interface CheckpointRead {
  /** Identity-checked rows for this Session lifecycle (possibly stale, never unrelated). */
  readonly rows: ProjectionCheckpoint
  /**
   * Lowest usable row watermark — `SessionProjectionRegistry.restoreFloor` —
   * or `undefined` when the registry holds no unit to seed. A tail restore
   * reads from this seq.
   */
  readonly seq: SessionLogOffset | undefined
}

/** The cache-owned lookups this module delegates to. */
export interface CheckpointCacheSurface {
  /**
   * Identity-checked stored record for one Session lifecycle.
   * @param meta - stored Session header (identity witness).
   * @param inheritedEventCount - exact inherited prefix length completing the identity.
   * @returns the matching record, or `undefined` (absent or unrelated).
   */
  recordFor(meta: SessionHeader, inheritedEventCount: SessionLogOffset): CheckpointRecord | undefined
  /**
   * The registry's restore floor for one checkpoint's rows.
   * @param rows - persisted rows for one Session.
   * @returns the seq a restore tail read starts at, or `undefined` without registered units.
   */
  restoreFloor(rows: ProjectionCheckpoint): SessionLogOffset | undefined
}

/**
 * The channel a cache instance publishes its surface on. A symbol property,
 * not a WeakMap on the instance: cordis hands callers a tracker proxy rather
 * than the registered service object, and only symbol-keyed property reads
 * forward to the service unchanged.
 */
const checkpointSurface: unique symbol = Symbol('dsh.sessionProjectionCache.forkCheckpointSurface')

/** A cache instance carrying its registered checkpoint surface. */
interface CheckpointCacheCarrier {
  readonly [checkpointSurface]?: CheckpointCacheSurface
}

/**
 * Register one cache instance's private checkpoint lookups for
 * {@link readCheckpoint}. Called once from the service constructor; a cache
 * whose registrations land after a read simply has no shortcut to offer.
 * @param cache - the cache service serving the lookups.
 * @param surface - its identity-checked record read and registry floor.
 */
export function registerCheckpointCache(
  cache: SessionProjectionCache,
  surface: CheckpointCacheSurface,
): void {
  Object.defineProperty(cache, checkpointSurface, { value: surface })
}

/**
 * Read one Session's stored checkpoint rows without touching its log.
 * @param cache - the registered cache service.
 * @param meta - stored Session header (identity witness).
 * @param inheritedEventCount - exact inherited prefix length completing the identity.
 * @returns the rows with their restore floor, or `undefined` when no record
 *   matches this lifecycle (the caller falls back to the full observation).
 */
export function readCheckpoint(
  cache: SessionProjectionCache,
  meta: SessionHeader,
  inheritedEventCount: SessionLogOffset,
): CheckpointRead | undefined {
  const surface = (cache as CheckpointCacheCarrier)[checkpointSurface]
  /* v8 ignore next -- the service constructor registers the surface before any caller can hold the instance. */
  if (surface === undefined) return undefined
  const record = surface.recordFor(meta, inheritedEventCount)
  if (record === undefined) return undefined
  return { rows: record.rows, seq: surface.restoreFloor(record.rows) }
}
