/**
 * Historical direct-child evidence for one parent's V3→V4 restore, collected
 * from this database's own session and event rows: the released catalog's
 * V3→V4 edge refuses a V3 body unless the parent supplies the complete set of
 * its direct subagent children, because a parent alone cannot recover a child
 * id, creation time, or descriptor.
 * @module @deepseek-ai/dsh-session-persistence-sqlite/child-catalog
 */

import type { DatabaseSync } from 'node:sqlite'
import { isSessionFormatJsonObject, snapshotSessionFormatJson, type SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'
import { childCatalogFact } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { decodeRow } from './compression.ts'
import { decodeEventRow, decodeSessionRow } from './schema.ts'
import { sql } from './sql.ts'

/**
 * Complete direct-child evidence for one parent, as the children-aware format
 * catalog receives it. An empty array declares a parent without children.
 */
export type ChildCatalogEvidence = readonly SessionFormatJsonValue[]

/** One child's evidence, exactly as the parent's catalog receives it. */
type ChildEvidence = ChildCatalogEvidence[number]

/** One child's stored identity with the cut its own descriptors are counted from. */
interface ChildIdentity {
  readonly childId: string
  readonly childCreatedAt: number
  /** The child's inherited event count; 0 for a child that inherited nothing. */
  readonly readFrom: number
}

/**
 * Collect every direct subagent child of one parent as catalog evidence.
 * @param db - open owned database the parent's rows were read from.
 * @param parentId - the parent's session key, which its children name in `parent_session`.
 * @returns evidence for each child whose stored identity this store can validate;
 *   a child whose own descriptor is unreadable keeps unknown-mode evidence
 *   instead of failing the parent's restore.
 */
export function collectChildCatalogEvidence(db: DatabaseSync, parentId: SessionId): ChildCatalogEvidence {
  const evidence: ChildEvidence[] = []
  for (const row of db.prepare(sql('select-child-sessions')).all(parentId)) {
    const child = childEvidence(db, row)
    // A child row this store cannot validate carries no identity the parent's
    // catalog may record; the remaining children still backfill.
    if (child !== undefined) evidence.push(child)
  }
  return evidence
}

/**
 * Build one child's evidence from its stored identity and its own descriptor
 * rows, without restoring the child's log.
 * @param db - open owned database the child's rows are read from.
 * @param row - one row of the direct-children query.
 * @returns the child's evidence, or `undefined` when its stored identity is unreadable.
 */
function childEvidence(db: DatabaseSync, row: unknown): ChildEvidence | undefined {
  const identity = childIdentity(row)
  if (identity === undefined) return undefined
  const { childId, childCreatedAt, readFrom } = identity
  let descriptorCount = 0
  let descriptor: SessionFormatJsonValue = null
  try {
    descriptorCount = ownDescriptorCount(db, childId, readFrom)
    if (descriptorCount === 1) descriptor = ownDescriptor(db, childId, readFrom)
  } catch {
    // An own descriptor row this store cannot decode or parse is not evidence
    // the parent's catalog may carry: the child keeps unknown-mode membership,
    // and every other child still backfills into the parent.
    return unavailableEvidence(childId, childCreatedAt)
  }
  return interpretedEvidence(childId, childCreatedAt, descriptorCount, descriptor)
}

/**
 * Validate one child's collected evidence with the catalog's own interpreter.
 * @param childId - the child's stored session key.
 * @param childCreatedAt - the child's stored creation time.
 * @param descriptorCount - number of the child's own descriptor events.
 * @param descriptor - the child's first own descriptor payload, or null without one.
 * @returns the evidence, or identity-only evidence when the descriptor's fields
 *   are ones the parent catalog refuses to interpret.
 */
function interpretedEvidence(
  childId: string,
  childCreatedAt: number,
  descriptorCount: number,
  descriptor: SessionFormatJsonValue,
): ChildEvidence {
  const evidence = { childId, childCreatedAt, descriptorCount, descriptor }
  try {
    childCatalogFact(evidence)
  } catch {
    // The interpreter refuses only evidence it cannot interpret — a supported
    // descriptor generation whose provider, mode, or label is invalid — so this
    // call raises nothing else that substituting evidence could hide.
    return unavailableEvidence(childId, childCreatedAt)
  }
  return evidence
}

/**
 * Evidence for a child whose own descriptor the parent catalog cannot
 * interpret: identity and membership without an asserted mode or label, which
 * the migration records as unknown-mode membership.
 * @param childId - the child's stored session key.
 * @param childCreatedAt - the child's stored creation time.
 * @returns evidence declaring no usable own descriptor.
 */
function unavailableEvidence(childId: string, childCreatedAt: number): ChildEvidence {
  return { childId, childCreatedAt, descriptorCount: 0, descriptor: null }
}

/**
 * Read and validate one stored child's catalog identity.
 * @param row - one row of the direct-children query.
 * @returns the child's identity, or `undefined` when the row is unreadable.
 */
function childIdentity(row: unknown): ChildIdentity | undefined {
  try {
    const stored = decodeSessionRow(row)
    return { childId: stored.id, childCreatedAt: stored.created_at, readFrom: stored.seed_length ?? 0 }
  } catch {
    // A stored child row with an unreadable identity (empty id, negative
    // creation time, malformed incarnation) cannot be named in a parent
    // catalog; the remaining children still backfill.
    return undefined
  }
}

/**
 * Count one child's own `subagent/descriptor` events at or after its inherited
 * cut, the same own-descriptor rule the released catalog applies to a restored
 * child artifact.
 * @param db - open owned database the child's events are read from.
 * @param childId - the child's stored session key.
 * @param readFrom - the child's inherited event count.
 * @returns the number of own descriptor events.
 */
function ownDescriptorCount(db: DatabaseSync, childId: string, readFrom: number): number {
  const row = db.prepare(sql('select-child-descriptor-count')).get(childId, readFrom)
  const count = row?.['count']
  /* v8 ignore next 3 -- COUNT(*) aggregates committed rows and always answers a non-negative integer. */
  if (!Number.isSafeInteger(count) || (count as number) < 0) {
    throw new Error('stored child descriptor count must be a non-negative safe integer')
  }
  return count as number
}

/**
 * Decode the child's first own descriptor payload through the schema-20
 * physical codec, which owns the compressed-column dictionary and the JSON
 * interpretation of one stored event.
 * @param db - open owned database the child's events are read from.
 * @param childId - the child's stored session key.
 * @param readFrom - the child's inherited event count.
 * @returns the decoded descriptor payload, or null when it is not a JSON object.
 */
function ownDescriptor(db: DatabaseSync, childId: string, readFrom: number): SessionFormatJsonValue {
  const row = db.prepare(sql('select-child-descriptor')).get(childId, readFrom)
  const payload: unknown = decodeRow(decodeEventRow(row))[0]?.data
  return isSessionFormatJsonObject(payload) ? snapshotSessionFormatJson(payload) : null
}
