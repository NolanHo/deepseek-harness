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
  sessionFormatCatalog,
} from '@deepseek-ai/dsh-session-format-catalog'
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
 * vocabulary and freeze them for shared reads.
 * @param physicalHeader - the stored header record rebuilt from the session row.
 * @param storedEvents - physical-row-decoded stored-format events, in seq order.
 * @param id - the requested session id for identity diagnostics.
 * @returns the validated current-format log.
 * @throws {SessionFormatUnsupportedError} when the stored format has no
 *   upgrade path or the migration refuses the contents.
 * @throws {SessionPersistenceCorruptionError} when stored rows are malformed.
 */
export function restoreStoredLog(
  physicalHeader: Record<string, unknown>,
  storedEvents: readonly StoredLogicalEvent[],
  id: SessionId,
): RestoredStoredLog {
  const restore = createRestore(physicalHeader, id)
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

/** Create one single-pass restore, translating format-edge failures into the seam vocabulary. */
function createRestore(
  physicalHeader: Record<string, unknown>,
  id: SessionId,
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
  try {
    return sessionFormatCatalog.createRestore(physicalHeader, {
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
