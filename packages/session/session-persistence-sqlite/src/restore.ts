/**
 * Stored-log restore glue: the fork's schema-20 physical rows decode to
 * stored-format logical events, which the released format catalog restores
 * into current-format (V3) logs — legacy version-0 databases migrate through
 * the same v0→v1→v2→v3 chain as the JSONL backend's historical generations.
 * @module @deepseek-ai/dsh-session-persistence-sqlite/restore
 */

import {
  SessionLogOffset,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import {
  SessionFormatUnsupportedError,
  SessionPersistenceCorruptionError,
  assertStoredId,
  assertVersion,
  sessionFormatVersionRefusal,
  validateStoredEvents,
} from '@deepseek-ai/dsh-session-persistence'
import {
  SessionFormatUnsupportedMigrationError,
  createSessionFormatCatalogWithChildren,
  sessionFormatCatalog,
} from '@deepseek-ai/dsh-session-format-catalog'
import type { ChildCatalogEvidence } from './child-catalog.ts'
import type { StoredLogicalEvent } from './codec.ts'

/** One stored log restored to the current logical format. */
export interface RestoredStoredLog {
  /** Validated immutable current-format header. */
  readonly meta: SessionHeader
  /** Exact fork-inherited prefix length in current coordinates. */
  readonly inheritedEventCount: SessionLogOffset
  /** Validated, deeply frozen current-format events. */
  readonly events: SessionEvent[]
}

/**
 * Deep-freeze one decoded event graph iteratively so restored logs can be
 * shared across handles as `shared-frozen`.
 * @param event - decoded event whose graph this call freezes in place.
 */
function freezeEventGraph(event: SessionEvent): void {
  const pending: object[] = [event]
  while (pending.length > 0) {
    const current = pending.pop() as object
    Object.freeze(current)
    for (const key in current) {
      const child = (current as Record<string, unknown>)[key]
      if (child !== null && typeof child === 'object') pending.push(child)
    }
  }
}

/**
 * Restore stored-format logical events to the current logical format through
 * the released format catalog, then validate them against this build's
 * vocabulary and freeze the header and events for shared reads.
 * @param physicalHeader - the stored header record rebuilt from the session row.
 * @param storedEvents - physical-row-decoded stored-format events, in seq order.
 * @param id - the requested session id for identity diagnostics.
 * @param childEvidence - the parent's complete direct-child evidence; a stored
 *   version below V4 binds it to the catalog's V3→V4 edge, and a current-format
 *   row restores through the flat catalog without consulting it.
 * @returns the validated current-format log.
 * @throws {SessionFormatUnsupportedError} when the stored format has no
 *   upgrade path or the migration refuses the contents.
 * @throws {SessionPersistenceCorruptionError} when stored rows are malformed.
 */
export function restoreStoredLog(
  physicalHeader: Record<string, unknown>,
  storedEvents: readonly StoredLogicalEvent[],
  id: SessionId,
  childEvidence: ChildCatalogEvidence,
): RestoredStoredLog {
  const restore = createRestore(physicalHeader, id, childEvidence)
  for (const event of storedEvents) {
    try {
      restore.decodeRow(event)
    } catch (error: unknown) {
      throw corruptionFailure(id, error)
    }
  }
  let artifact: ReturnType<ReturnType<typeof sessionFormatCatalog.createRestore>['finish']>
  try {
    artifact = restore.finish()
  } catch (error: unknown) {
    throw corruptionFailure(id, error)
  }
  const meta = artifact.header as unknown as SessionHeader
  assertStoredId(id, meta)
  assertVersion(meta)
  const events = artifact.events as SessionEvent[]
  validateStoredEvents(meta, events)
  for (const event of events) freezeEventGraph(event)
  Object.freeze(events)
  // The header is a flat record of primitives, so its shallow freeze is
  // complete. The decoded-log cache serves this object to every read at the
  // same revision, and the current-format codec spreads its decoded header into
  // a new unfrozen object.
  Object.freeze(meta)
  return {
    meta,
    inheritedEventCount: SessionLogOffset(artifact.inheritedEventCount),
    events,
  }
}

/**
 * Restore one stored header without reading event rows — the lightweight
 * header translation behind `stat` and `list`.
 * @param physicalHeader - the stored header record rebuilt from the session row.
 * @param id - the requested session id for identity diagnostics.
 * @returns the validated current-format header.
 */
export function restoreStoredHeader(
  physicalHeader: Record<string, unknown>,
  id: SessionId,
): SessionHeader {
  const read = sessionFormatCatalog.readHeader(physicalHeader)
  if (read.status === 'unsupported') {
    throw new SessionFormatUnsupportedError(
      read.storedVersion > sessionFormatCatalog.currentVersion
        ? sessionFormatVersionRefusal(id, read.storedVersion)
        : read.reason,
    )
  }
  if (read.status === 'malformed') {
    throw new SessionPersistenceCorruptionError(
      `session "${id}": stored metadata is malformed: ${read.reason}`,
      { cause: new Error(read.reason) },
    )
  }
  const meta = read.header as unknown as SessionHeader
  assertStoredId(id, meta)
  assertVersion(meta)
  return meta
}

/**
 * Highest stored format version whose restore runs the V3→V4 edge; a
 * current-format row restores natively and never reaches a migration stage.
 */
const CHILD_EVIDENCE_STORED_VERSION = 3

/**
 * Create one single-pass restore, translating format-edge failures into the seam
 * vocabulary. A stored version at or below {@link CHILD_EVIDENCE_STORED_VERSION}
 * binds the parent's direct-child evidence to the V3→V4 edge, which refuses a
 * historical body without it.
 * @param physicalHeader - the stored header record rebuilt from the session row.
 * @param id - the requested session id for identity diagnostics.
 * @param childEvidence - the parent's complete direct-child evidence.
 * @returns the restore for the stored header's generation.
 */
function createRestore(
  physicalHeader: Record<string, unknown>,
  id: SessionId,
  childEvidence: ChildCatalogEvidence,
): ReturnType<typeof sessionFormatCatalog.createRestore> {
  const classification = sessionFormatCatalog.readHeader(physicalHeader)
  if (classification.status === 'unsupported') {
    throw new SessionFormatUnsupportedError(
      classification.storedVersion > sessionFormatCatalog.currentVersion
        ? sessionFormatVersionRefusal(id, classification.storedVersion)
        : classification.reason,
    )
  }
  if (classification.status === 'malformed') {
    throw new SessionPersistenceCorruptionError(
      `session "${id}": stored metadata is malformed: ${classification.reason}`,
      { cause: new Error(classification.reason) },
    )
  }
  const catalog = classification.storedVersion <= CHILD_EVIDENCE_STORED_VERSION
    ? createSessionFormatCatalogWithChildren(childEvidence)
    : sessionFormatCatalog
  try {
    return catalog.createRestore(physicalHeader, {
      recovery: 'recoverable',
      validation: 'transformed',
    })
  } catch (error: unknown) {
    if (error instanceof SessionFormatUnsupportedMigrationError) {
      throw new SessionFormatUnsupportedError(
        `session "${id}": stored format cannot be migrated to v${sessionFormatCatalog.currentVersion}: ${error.message}`,
      )
    }
    throw corruptionFailure(id, error)
  }
}

/** Classify one restore failure: refusal of intact contents versus damage. */
function corruptionFailure(id: SessionId, error: unknown): Error {
  if (error instanceof SessionFormatUnsupportedMigrationError) {
    return new SessionFormatUnsupportedError(
      `session "${id}": stored format cannot be migrated to v${sessionFormatCatalog.currentVersion}: ${error.message}`,
    )
  }
  if (error instanceof SessionFormatUnsupportedError
    || error instanceof SessionPersistenceCorruptionError) return error
  const detail = error instanceof Error ? error.message : String(error)
  return new SessionPersistenceCorruptionError(
    `session "${id}": stored log is corrupt: ${detail}`,
    { cause: error },
  )
}
