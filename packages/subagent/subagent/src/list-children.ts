/**
 * Read-only enumeration of durable subagent children and descendant trees
 * through the Session query service. Candidates come from one live-preferred
 * corpus; each child's mode/label is the registered `subagent` projection
 * unit's value, resolved
 * down a three-rung ladder: the registry's watermark cache for a live child,
 * an unseeded durable projection-cache row, and one shared Session observation
 * otherwise. A seeded header deliberately lacks its exact inherited cut, so
 * it takes the body-bearing observation path before classifying an identity.
 * The projection fold is the single classification
 * authority — this module parses no descriptor
 * itself. Absent persistence, enumeration is live-only: a cold child is
 * unreachable for resume anyway, so its absence is capability absence, not an
 * error. The module owns no catalog state and does not consult Activation,
 * Agent-registry, continuation-manager, or provider state.
 *
 * @module @deepseek-ai/dsh-subagent
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { SessionProjectionCache } from '@deepseek-ai/dsh-session-projection-cache'
import type { SessionObservation, SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type { SubagentListEntry } from './control-types.ts'
import { SubagentError } from './error.ts'
import type { SubagentIdentityProjection } from './projection-types.ts'

export type { SubagentListEntry } from './control-types.ts'

// Fork patch (FORK_SURFACE.md): upstream starts one read per cold candidate
// behind a hardcoded concurrency; the caller's per-listing budget and the
// projection-cache rung hoisted ahead of it are the fork's.
/**
 * Cold-read bounds one listing applies to its non-live candidates. One cold
 * observation reads and decodes a child's complete stored Session log, so an
 * unbounded listing costs grow with the workspace and can pin the Host on a
 * cold projection cache.
 */
export interface SubagentListingLimits {
  /** Cold observations one listing may keep in flight at once. */
  readonly coldReadConcurrency: number
  /**
   * Cold observations one listing may start. Candidates past the budget stay
   * unread and report the retryable `unavailable` diagnostic.
   */
  readonly coldReadBudget: number
}

/** One cold candidate awaiting its identity observation. */
interface ColdReadJob {
  /** Position of the candidate in the row-aligned candidate list. */
  readonly index: number
  /** Enumerated header of the child to observe. */
  readonly header: SessionHeader
}

/**
 * One entry of a descendant listing: the interpreted subagent facts plus its
 * position in the complete session tree. `parentId` is the durable direct
 * parent from the enumerated header, and `depth` counts edges from the root.
 */
export type SubagentDescendantListEntry = SubagentListEntry & {
  /** Durable direct parent of this candidate in the enumerated tree. */
  readonly parentId: SessionId
  /** Edge distance from the requested root; direct children are `1`. */
  readonly depth: number
}

type CorpusRecord = { readonly header: SessionHeader; readonly live: Session | undefined }

interface ListingRuntime {
  readonly projections: SessionProjectionRegistry
  readonly query: SessionQueryEngine
  readonly cache: SessionProjectionCache | undefined
  readonly corpus: ReadonlyMap<SessionId, CorpusRecord>
  readonly subagentParents: ReadonlySet<SessionId>
  readonly coldReadConcurrency: number
  readonly coldReadBudget: number
}

interface PositionedCandidate {
  readonly record: CorpusRecord
  readonly parentId: SessionId
  readonly depth: number
}

/**
 * Enumerate one parent's origin-classified direct children from the
 * live-preferred merge of `ctx.sessions` and optional session persistence,
 * serving each identity from the `subagent` projection unit: the registry's
 * watermark snapshot for a live child; for a cold one, a durable
 * projection-cache read for an unseeded lifecycle, else one shared Session
 * observation carrying the exact inherited cut, within the caller's per-listing
 * cold-read bounds.
 * @see SubagentRuntime.listChildren for the public cancellation and failure contract.
 * @param ctx - context carrying the session store, the projection registry,
 *   optional persistence, and the optional projection cache.
 * @param parentSessionId - parent session whose direct children are listed.
 * @param limits - cold-read concurrency and per-listing budget.
 * @param signal - caller-owned cancellation observed around every persistence read.
 * @returns children and per-child diagnostics ordered by `createdAt`, then id.
 * @throws {@link SubagentError} when the projection registry or the session
 *   store is not mounted, or the caller cancels the listing.
 */
export async function listChildren(
  ctx: Context,
  parentSessionId: SessionId,
  limits: SubagentListingLimits,
  signal?: AbortSignal,
): Promise<SubagentListEntry[]> {
  const listing = await prepareListing(ctx, limits, signal)
  const candidates = [...listing.corpus.values()]
    .filter(record => record.header.parentSession === parentSessionId
      && record.header.origin === 'subagent')
    .sort(compareCorpusRecords)
  const rows = await resolveCandidateRows(candidates, listing, signal)
  return rows.filter((row): row is SubagentListEntry => row !== undefined)
}

/**
 * Enumerate every session-backed subagent below one root in stable pre-order.
 * Ordinary sessions and one-shot children remain traversal nodes, so a
 * continuable child below either is still discovered. Classification uses the
 * same projection-backed runtime as {@link listChildren}; no Agent is loaded or
 * resumed.
 * @see SubagentRuntime.listDescendants for the public cancellation and failure contract.
 * @param ctx - context carrying the session store, projection registry, and optional persistence/cache.
 * @param rootSessionId - session whose complete descendant tree is listed.
 * @param limits - cold-read concurrency and per-listing budget.
 * @param signal - caller-owned cancellation observed around every persistence read.
 * @returns interpreted subagents with durable direct-parent and root-relative depth.
 * @throws {@link SubagentError} under the same conditions as {@link listChildren}.
 */
export async function listDescendants(
  ctx: Context,
  rootSessionId: SessionId,
  limits: SubagentListingLimits,
  signal?: AbortSignal,
): Promise<SubagentDescendantListEntry[]> {
  const listing = await prepareListing(ctx, limits, signal)
  const positioned = descendantCandidates(listing.corpus, rootSessionId)
  const rows = await resolveCandidateRows(
    positioned.map(candidate => candidate.record),
    listing,
    signal,
  )
  const entries: SubagentDescendantListEntry[] = []
  positioned.forEach((position, index) => {
    const row = rows[index]
    if (row !== undefined) {
      entries.push({ ...row, parentId: position.parentId, depth: position.depth })
    }
  })
  return entries
}

/** Resolve listing services once and build one live-preferred session corpus. */
async function prepareListing(
  ctx: Context,
  limits: SubagentListingLimits,
  signal: AbortSignal | undefined,
): Promise<ListingRuntime> {
  const projections = ctx.get('sessionProjections')
  // Checked before any read, even with zero candidates: mode/label are the
  // row's strong contract, so a missing fold capability is a deterministic
  // deployment configuration error, never an empty success.
  if (projections === undefined) {
    throw new SubagentError(
      'listing subagents requires the sessionProjections registry (load @deepseek-ai/dsh-session-projection)',
      'SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE',
    )
  }
  // Strict global read, never the `ctx.sessions` property proxy: the proxy is
  // caller-scope bound, so a consumer plugin without its own `sessions`
  // injection (the model-facing tool, the API proxy) would throw on access.
  const sessions = ctx.get('sessions')
  if (sessions === undefined) {
    throw new SubagentError(
      'listing subagents requires the session store (load @deepseek-ai/dsh-session)',
      'SUBAGENT_CONTROL_SESSION_STORE_UNAVAILABLE',
    )
  }
  assertListingNotCancelled(signal)
  const query = ctx.get('sessionQuery')
  if (query === undefined) {
    throw new SubagentError(
      'listing subagents requires the sessionQuery service (load @deepseek-ai/dsh-session-query)',
      'SUBAGENT_CONTROL_QUERY_UNAVAILABLE',
    )
  }
  // Optional acceleration only: an absent cache service just means every
  // cold candidate takes the authoritative preparation rung, so it carries
  // no error code and no configuration check.
  const cache = ctx.get('sessionProjectionCache')
  let records: Awaited<ReturnType<SessionQueryEngine['listSessions']>>
  try {
    records = await query.listSessions(signal)
  } catch (error: unknown) {
    assertListingNotCancelled(signal)
    throw error
  }
  assertListingNotCancelled(signal)
  // Live-preferred merge without header reconciliation: a live record wins
  // its id wholesale, exactly as a live-preferred corpus would serve it.
  const corpus = new Map<SessionId, CorpusRecord>()
  for (const record of records) {
    const live = sessions.get(record.header.id)
    corpus.set(record.header.id, {
      header: live?.header ?? record.header,
      live,
    })
  }
  const subagentParents = new Set<SessionId>()
  for (const record of corpus.values()) {
    if (record.header.origin === 'subagent' && record.header.parentSession !== undefined) {
      subagentParents.add(record.header.parentSession)
    }
  }
  return { projections, query, cache, corpus, subagentParents, ...limits }
}

/** Resolve projection-backed rows for aligned candidates with bounded cold reads. */
async function resolveCandidateRows(
  candidates: readonly CorpusRecord[],
  listing: ListingRuntime,
  signal: AbortSignal | undefined,
): Promise<(SubagentListEntry | undefined)[]> {
  const { projections, query, cache, subagentParents } = listing
  const rows: (SubagentListEntry | undefined)[] = Array.from({ length: candidates.length })
  const coldReads: ColdReadJob[] = []
  candidates.forEach((candidate, index) => {
    const childId = candidate.header.id
    if (candidate.live === undefined) {
      // A durable projection-cache row answers a cold candidate without any
      // Session read, so it spends neither the read budget nor a concurrency
      // slot: a repeated listing advances past what it already resolved
      // instead of re-spending its budget on rows served from the cache.
      const cached = cachedColdIdentity(cache, candidate.header)
      if (cached !== undefined) {
        rows[index] = childRow(childId, cached, 'inactive', subagentParents.has(childId))
        return
      }
      coldReads.push({ index, header: candidate.header })
      return
    }
    // Read only the identity unit. A live child without an identity yet is the
    // creation window before the establishing provider appends its descriptor.
    let identity: SubagentIdentityProjection | null | undefined
    try {
      identity = projections.snapshot(candidate.live, ['subagent']).values.subagent
    } catch {
      // A rejecting identity fold is deterministic data damage in this child;
      // contain it as one diagnostic instead of failing the whole listing.
      rows[index] = { kind: 'diagnostic', id: childId, reason: 'corrupt' }
      return
    }
    // The unit's serializable no-value sentinel is `null`; `undefined` can
    // only mean the key was dropped at a JSON boundary. Both are no value.
    if (identity === undefined || identity === null
      || !candidate.live.isOwnSeq(identity.seq)) return
    rows[index] = childRow(childId, identity, 'running', subagentParents.has(childId))
  })

  // Cold candidates that still need a read are resolved concurrently inside
  // the configured per-listing bounds.
  if (coldReads.length > 0) {
    const { reads, deferred } = selectColdReads(coldReads, listing.coldReadBudget)
    // Beyond-budget candidates keep their corpus position and degrade to the
    // retryable `unavailable` row: the order is stable across listings, so the
    // next one resumes at the front rather than starving the tail.
    for (const job of deferred) {
      rows[job.index] = { kind: 'diagnostic', id: job.header.id, reason: 'unavailable' }
    }
    const queue = [...reads]
    await Promise.all(Array.from(
      { length: Math.min(listing.coldReadConcurrency, queue.length) },
      async () => {
        for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
          rows[job.index] = await observeColdIdentity(
            query, job.header,
            subagentParents.has(job.header.id), signal,
          )
        }
      },
    ))
  }
  assertListingNotCancelled(signal)
  return rows
}

// Fork patch (FORK_SURFACE.md): selection in corpus order is what makes the
// caller's per-listing budget advance monotonically across listings.
/**
 * Take the cold candidates one listing reads now, in corpus order. Candidates
 * the projection cache already serves never reach this selection, so a repeated
 * listing spends its budget on children it has not resolved yet instead of the
 * same head; read survivors keep their corpus position, which makes that
 * advance monotonic.
 * @param coldCandidates - cold candidates still needing a Session read, in corpus order.
 * @param budget - maximum candidates one listing observes.
 * @returns the candidates to observe and those left for a later listing.
 */
function selectColdReads(
  coldCandidates: readonly ColdReadJob[],
  budget: number,
): { readonly reads: readonly ColdReadJob[]; readonly deferred: readonly ColdReadJob[] } {
  return { reads: coldCandidates.slice(0, budget), deferred: coldCandidates.slice(budget) }
}

/** Build origin-classified candidates from the complete tree without recursion. */
function descendantCandidates(
  corpus: ReadonlyMap<SessionId, CorpusRecord>,
  rootSessionId: SessionId,
): PositionedCandidate[] {
  const children = new Map<SessionId, CorpusRecord[]>()
  for (const record of corpus.values()) {
    const parentId = record.header.parentSession
    if (parentId === undefined) continue
    const siblings = children.get(parentId)
    if (siblings === undefined) children.set(parentId, [record])
    else siblings.push(record)
  }
  for (const siblings of children.values()) siblings.sort(compareCorpusRecords)

  const positioned: PositionedCandidate[] = []
  const stack: PositionedCandidate[] = (children.get(rootSessionId) ?? [])
    .map(record => ({ record, parentId: rootSessionId, depth: 1 }))
    .reverse()
  const visited = new Set<SessionId>([rootSessionId])
  while (stack.length > 0) {
    // The length guard proves one frame exists.
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const position = stack.pop()!
    const id = position.record.header.id
    if (visited.has(id)) continue
    visited.add(id)
    if (position.record.header.origin === 'subagent') positioned.push(position)
    const descendants = children.get(id) ?? []
    for (const record of [...descendants].reverse()) {
      stack.push({ record, parentId: id, depth: position.depth + 1 })
    }
  }
  return positioned
}

/** Compare siblings by durable creation time, then id. */
function compareCorpusRecords(a: CorpusRecord, b: CorpusRecord): number {
  return a.header.createdAt - b.header.createdAt || a.header.id.localeCompare(b.header.id)
}

/**
 * Read the durable projection-cache rung for one cold candidate: an unseeded
 * lifecycle's stored identity, when the cache holds one.
 * @param cache - mounted projection cache; absent when the deployment has none.
 * @param header - enumerated header of the child.
 * @returns the cached identity, or `undefined` when the cache cannot answer for
 *   this candidate: no cache, a seeded lifecycle, an absent row, the serializable
 *   no-value sentinel, or a throwing derived row.
 */
function cachedColdIdentity(
  cache: SessionProjectionCache | undefined,
  header: SessionHeader,
): SubagentIdentityProjection | undefined {
  // A header deliberately exposes only whether a fork cut exists, not its
  // integer. An unseeded lifecycle has the exact cut 0 and may use the cache;
  // a seeded lifecycle must read the body before an identity seq can be
  // classified as inherited or owned.
  if (cache === undefined || header.isSeeded) return undefined
  try {
    // An unseeded child's descriptor is owned at every valid seq, so only a
    // served identity answers here. The `null` sentinel means no value: its
    // verdict belongs to the authoritative re-fold, not to a derived row.
    return cache.cachedSnapshot(header, SessionLogOffset(0), ['subagent'])?.values.subagent ?? undefined
  } catch {
    // Unlike the live preparation fold, a throwing cache read renders no
    // verdict: the cache is derived data, so its damage (a poisoned stored
    // row of ANY unit) silently falls through to the authoritative re-fold.
    return undefined
  }
}

/**
 * Resolve one cold candidate by observing its stored Session. An absent or
 * transiently failed observation is one `unavailable` row retried on the next
 * listing; an observation source naming another lifecycle, and a settled log
 * the fold cannot identify — or that makes any registered unit throw — are
 * final, so they report `corrupt`.
 * @param query - Session query engine serving the shared observation.
 * @param header - enumerated header of the child to observe.
 * @param hasChildren - whether the enumerated corpus holds descendants of this child.
 * @param signal - caller-owned cancellation observed around the read.
 * @returns the served child row, or this candidate's diagnostic.
 */
async function observeColdIdentity(
  query: SessionQueryEngine,
  header: SessionHeader,
  hasChildren: boolean,
  signal: AbortSignal | undefined,
): Promise<SubagentListEntry> {
  const childId = header.id
  assertListingNotCancelled(signal)
  let observation: SessionObservation
  try {
    observation = await query.observeSession(childId, {
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error: unknown) {
    // Per-child isolation: durable corruption is stable; absence and backend
    // failures remain retryable. Either way, the listing itself still succeeds.
    assertListingNotCancelled(signal)
    return {
      kind: 'diagnostic',
      id: childId,
      reason: sessionQueryCode(error) === 'SESSION_QUERY_CORRUPT_SESSION'
        || sessionQueryCode(error) === 'SESSION_QUERY_SOURCE_CONFLICT'
        ? 'corrupt'
        : 'unavailable',
    }
  }
  using ownedObservation = observation
  assertListingNotCancelled(signal)
  // A session id names a slot, not a lifecycle: a child deleted and
  // re-published under another owner between the enumeration and this read
  // must not leak into the old parent's listing.
  if (!sameLifecycle(ownedObservation.header, header)) {
    return { kind: 'diagnostic', id: childId, reason: 'corrupt' }
  }
  const identity = ownedObservation.projections?.values.subagent
  if (identity === undefined || identity === null
    || identity.seq < ownedObservation.inheritedEventCount) {
    return { kind: 'diagnostic', id: childId, reason: 'corrupt' }
  }
  return childRow(childId, identity, 'inactive', hasChildren)
}

/** Materialize one served identity as its child row. */
function childRow(
  id: SessionId,
  identity: SubagentIdentityProjection,
  activity: 'running' | 'inactive',
  hasChildren: boolean,
): SubagentListEntry {
  return identity.mode === 'one-shot'
    ? {
      kind: 'child',
      id,
      mode: 'one-shot',
      ...identity.label !== undefined ? { label: identity.label } : {},
      activity,
      hasChildren,
    }
    : {
      kind: 'child',
      id,
      mode: 'continuable',
      label: identity.label,
      activity,
      hasChildren,
    }
}

/** Immutable header fields that distinguish one session lifecycle from another under the same id. */
const LIFECYCLE_WITNESS_KEYS = [
  'version', 'id', 'createdAt', 'cwd', 'parentSession', 'isSeeded', 'delegationDepth',
  'origin', 'agentPreset',
] as const

/** Whether an inspected log still belongs to the enumerated lifecycle. */
function sameLifecycle(meta: SessionHeader, expected: SessionHeader): boolean {
  return LIFECYCLE_WITNESS_KEYS.every(key => meta[key] === expected[key])
}

/** Stop a listing at its next cancellation checkpoint. */
function assertListingNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new SubagentError('subagent listing was cancelled', 'CANCELLED')
  }
}

function sessionQueryCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}
