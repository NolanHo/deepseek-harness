/**
 * Public records for exact reads and relationship traces over the
 * live-preferred logical session corpus.
 *
 * @module @deepseek-ai/dsh-session-query/types
 */

import type {
  SessionEvent,
  SessionEventType,
  SessionHeader,
  SessionId,
  SessionLogOffset,
  SessionSeq,
  OptionalSessionSeq,
  SurfaceEvent,
} from '@deepseek-ai/dsh-session'
import type { SessionTitleSnapshot } from '@deepseek-ai/dsh-session-title'
import type { SessionSearchCursor } from './cursor.ts'

export type { SessionSearchCursor } from './cursor.ts'

/** Whether an event is current model context, replaced context, or raw-log-only. */
export type SessionEventSurface = 'current' | 'shadowed' | 'log-only'

/** Lightweight identity and source availability for one logical session. */
export interface SessionRecord {
  /** Cloned session header selected from the live-preferred corpus. */
  header: SessionHeader
  /** Whether the id currently exists in `ctx.sessions`. */
  live: boolean
  /** Whether the active persistence backend currently lists the id, including a created-but-unmaterialized session it already observes. */
  persisted: boolean
}

/** Row selection for one logical-corpus listing. */
export interface SessionListScope {
  /**
   * Origins the listing keeps: `listed` keeps every row whose origin is not
   * `subagent` — roots and fork children alike — while `all` keeps every row.
   * Defaults to `all`.
   */
  readonly scope?: 'listed' | 'all'
  /**
   * When set, the listing keeps exactly the rows whose `parentSession` is this
   * id, whatever their origin, and ignores {@link SessionListScope.scope}.
   */
  readonly parentSessionId?: SessionId
}

/** One atomic live-preferred observation of a session's current model surface. */
export interface SessionSurfaceSnapshot {
  /** Cloned session header selected from the same corpus observation as `events`. */
  session: SessionHeader
  /** Exact number of fork-inherited events in the observed log. */
  inheritedEventCount: SessionLogOffset
  /** Highest raw-log seq included in the observation, or `null` for an empty log. */
  capturedThroughSeq: OptionalSessionSeq
  /** Cloned current surface events in model-history order. */
  events: SurfaceEvent[]
}

/** One validated detached observation of a logical session's complete raw log. */
export interface SessionLogSnapshot {
  /** Cloned session header selected from the same observation as `events`. */
  session: SessionHeader
  /** Exact number of fork-inherited events in the observed log. */
  inheritedEventCount: SessionLogOffset
  /** Cloned contiguous raw events after in-memory interrupted-turn balancing and replay validation. */
  events: SessionEvent[]
}

/** Lightweight metadata for one event within a logical session. */
export interface SessionEventRecord {
  /** Session that owns the event. */
  sessionId: SessionId
  /** Monotonic event seq within the session. */
  seq: SessionSeq
  /** Discriminant of the session event. */
  type: SessionEventType
  /** Event timestamp in Unix epoch milliseconds. */
  time: number
  /** Event placement in the folded session surface. */
  surface: SessionEventSurface
}

/** Recursive descendant node in a session-lineage trace. */
export interface SessionLineageNode {
  /** Detached logical-corpus record for this descendant. */
  session: SessionRecord
  /** Direct children, each carrying its own recursive descendants. */
  descendants: SessionLineageNode[]
}

/** Known ancestry and descendants for one logical session. */
export type SessionLineageTrace = {
  /** Detached record for the session that was traced. */
  target: SessionRecord
  /** Known parents from the immediate parent outward. */
  ancestors: SessionRecord[]
  /** Complete known descendant trees rooted at the target's direct children. */
  descendants: SessionLineageNode[]
} & (
  | {
    /** The complete parent chain is present in the logical corpus. */
    complete: true
    /** Detached record at the top of the complete lineage. */
    root: SessionRecord
  }
  | {
    /** The parent chain leaves the visible logical corpus. */
    complete: false
    /** First parent id that is not present in the logical corpus. */
    unresolvedParentId: SessionId
  }
)

/** Request for direct surface replacements and relationships to cited source events around one event. */
export interface SessionEventTraceRequest {
  /** Session that owns the target event. */
  sessionId: SessionId
  /** Target event seq. */
  seq: SessionSeq
}

/** Direct surface replacements and relationships to cited source events for one event. */
export interface SessionEventTrace {
  /** Lightweight target record. */
  target: SessionEventRecord
  /** Immediate positional replacement event, when the target was shadowed. */
  replacedBy?: SessionSeq
  /** Positional replacers from the immediate replacement to the final replacement. */
  replacementChain: SessionSeq[]
  /** Surface nodes directly removed when the target itself performed a replacement. */
  replacedEventSeqs: SessionSeq[]
  /** Earlier events cited directly as sources, in their recorded order. */
  sourceEventSeqs: SessionSeq[]
  /** Later events that directly cite the target as a source, in log order. */
  derivedEventSeqs: SessionSeq[]
}

/** Event relationships bound to the same session-header observation. */
export interface SessionEventTraceObservation extends SessionEventTrace {
  /** Cloned header selected with the event log used for the trace. */
  session: SessionHeader
}

/** Request for one event plus raw neighboring log context. */
export interface SessionEventReadRequest {
  /** Session that owns the target event. */
  sessionId: SessionId
  /** Target event seq. */
  seq: SessionSeq
  /** Number of preceding raw events to include. */
  before?: number
  /** Number of following raw events to include. */
  after?: number
}

/** Full target event and a bounded raw-log window. */
export interface SessionEventWindow {
  /** Cloned header for the live-preferred source read. */
  session: SessionHeader
  /** Exact number of fork-inherited events in the observed log. */
  inheritedEventCount: SessionLogOffset
  /** Full cloned target event. */
  target: SessionEvent
  /** Full cloned events from `startSeq` through `endSeq`. */
  events: SessionEvent[]
  /** First seq included in `events`. */
  startSeq: SessionSeq
  /** Last seq included in `events`. */
  endSeq: SessionSeq
}

/** Latest folded title bound to the same session-header observation. */
export interface SessionTitleObservation {
  /** Cloned header selected with the event log used for the title fold. */
  session: SessionHeader
  /** Latest title snapshot, absent when the observed log has no title. */
  title?: SessionTitleSnapshot
}

/** One ordered result from a batch title observation. */
export type SessionTitleObservationResult =
  | {
    /** Requested session id. */
    sessionId: SessionId
    /** Successful atomic header/title observation. */
    status: 'fulfilled'
    /** Header and optional latest title from one logical source. */
    value: SessionTitleObservation
  }
  | {
    /** Requested session id. */
    sessionId: SessionId
    /** Operational failure isolated to this session. */
    status: 'rejected'
    /** Original failure from logical-source resolution or title folding. */
    reason: unknown
  }

/** Inclusive numeric interval used by time and sequence filters. */
export interface SessionResultRange {
  /** Inclusive lower bound. */
  from?: number
  /** Inclusive upper bound. */
  to?: number
}

/** Source availability predicates understood by logical-session filters. */
export type SessionAvailability = 'live' | 'persisted'

/**
 * One logical-session predicate. A filter array is ANDed; `values` within a
 * clause are ORed.
 */
export type SessionResultFilter =
  | { kind: 'id'; values: readonly SessionId[] }
  | { kind: 'cwd'; values: readonly (string | null)[] }
  | ({ kind: 'created-at' } & SessionResultRange)
  | { kind: 'parent'; values: readonly (SessionId | null)[] }
  | { kind: 'availability'; values: readonly SessionAvailability[] }

/**
 * One event predicate. A filter array is ANDed; list-valued clauses are ORed.
 * Text is a literal, case-insensitive, whitespace-flexible semantic-text scan.
 */
export type SessionEventResultFilter =
  | ({ kind: 'seq' } & SessionResultRange)
  | ({ kind: 'time' } & SessionResultRange)
  | { kind: 'type'; values: readonly SessionEventType[] }
  | { kind: 'surface'; values: readonly SessionEventSurface[] }
  | { kind: 'text'; text: string }

/** Event predicates a full-text provider can apply before relevance ranking. */
export type SessionEventMetadataFilter = Exclude<SessionEventResultFilter, { kind: 'text' }>

/** Searchable semantic document derived from one session event. */
export interface SessionEventSearchDocument extends SessionEventRecord {
  /** First-party semantic text used by scan filters and full-text indexes. */
  text: string
}

/** One cursor-paginated result page. */
export interface SessionSearchPage<T> {
  /** Results for this page in contract-defined order. */
  items: readonly T[]
  /** Opaque continuation cursor, absent on the final page. */
  nextCursor?: SessionSearchCursor
}

/** Event-search results bound to the indexed target-session observation. */
export interface SessionEventSearchPage extends SessionSearchPage<SessionEventSearchHit> {
  /** Cloned target header from the same indexed generation as `items`. */
  session: SessionHeader
}

/**
 * Ranked-document allowance shared by every call of one caller request.
 *
 * A provider charges each call that ranks a document set — a first page and any
 * re-rank after the relevant corpus changed — and refuses a charge that would
 * take the request past the provider's own configured document bound. A caller
 * that drives pages through cursors passes one budget for the whole sequence, so
 * one request cannot re-rank the same document set once per page; a single-call
 * caller may omit the budget and carries only the per-call document bound.
 */
export interface SessionSearchRankedDocumentBudget {
  /** Documents this request has already spent on ranking. */
  spent: number
}

/**
 * Live-Session observation allowance shared by every call of one caller
 * request.
 *
 * Reconciliation observes each attached Session that changed since the last
 * pass; observing one materializes and fingerprints its whole log, so a
 * request over a set of large attached logs would otherwise read without
 * limit. A provider charges every observation against its own configured
 * event bound and refuses a charge past it with
 * `SESSION_QUERY_SEARCH_BUDGET_EXHAUSTED`. A caller that drives pages through
 * cursors passes one budget for the whole sequence; a single-call caller may
 * omit the budget and carries only the provider's per-call bound.
 */
export interface SessionSearchLiveObservationBudget {
  /** Live-Session events this request has already observed. */
  spent: number
}

/**
 * Reconciliation allowance shared by every call of one caller request.
 *
 * Reconciliation lists the stored corpus, cold-reads the log of every persisted
 * Session the index does not hold at its current revision, and re-indexes its
 * documents; one cold read decodes a whole log and its re-index reads and writes
 * the whole document set, so a request over a pending set would otherwise read
 * without limit and a page sequence would pay that work once per page. A
 * provider charges every cold read against its own configured event bound, stops
 * cold-reading once the request has spent it — leaving the remaining Sessions to
 * the next request — and memoizes the completed reconciliation against this
 * object's identity, so all pages of one request observe one corpus and read it
 * once. A caller that drives pages through cursors allocates one budget per
 * request and passes the same object to every page; a single-call caller may
 * omit it and carries only the provider's per-call bound.
 */
export interface SessionSearchReconciliationBudget {
  /** Persisted-Session events this request has already cold-read. */
  spent: number
}

/** Controls shared by cross-session and within-session search calls. */
export interface SessionSearchExecContext {
  /** Abort caller waiting and interrupt provider work where supported. */
  signal?: AbortSignal
  /**
   * Budget shared by every call of one caller request. The provider owns the
   * increments and the bound; a page sequence that exceeds it fails with
   * `SESSION_QUERY_SEARCH_BUDGET_EXHAUSTED` instead of ranking again.
   */
  rankedDocumentBudget?: SessionSearchRankedDocumentBudget
  /**
   * Budget shared by every call of one caller request. The provider owns the
   * increments and the bound; a page sequence that exceeds it fails with
   * `SESSION_QUERY_SEARCH_BUDGET_EXHAUSTED` before observing a log past the
   * bound.
   */
  liveObservationBudget?: SessionSearchLiveObservationBudget
  /**
   * Request-scoped reconciliation shared by every call of one caller request.
   * The provider owns the increments, the bound, and the memo keyed by this
   * object's identity; a page sequence that exceeds the bound stops
   * cold-reading the remaining persisted Sessions and leaves them to the next
   * request instead of reading a log past the bound.
   */
  reconciliationBudget?: SessionSearchReconciliationBudget
}

/** Cross-session full-text search request. */
export interface SessionSearchRequest {
  /** Full-text query interpreted as data, never executable FTS syntax. */
  query: string
  /** Logical-session predicates applied before event ranking. */
  sessionFilters?: readonly SessionResultFilter[]
  /** Event predicates applied before event ranking. */
  eventFilters?: readonly SessionEventMetadataFilter[]
  /** Maximum sessions in this page. */
  limit?: number
  /** Opaque cursor returned for the identical normalized request. */
  cursor?: SessionSearchCursor
}

/** Within-session full-text search request. */
export interface SessionEventSearchRequest {
  /** Session whose live-preferred logical log is searched. */
  sessionId: SessionId
  /** Full-text query interpreted as data, never executable FTS syntax. */
  query: string
  /** Event predicates applied before ranking. */
  filters?: readonly SessionEventMetadataFilter[]
  /** Maximum events in this page. */
  limit?: number
  /** Opaque cursor returned for the identical normalized request. */
  cursor?: SessionSearchCursor
}

/** One event full-text search hit with a bounded plain-text excerpt. */
export interface SessionEventSearchHit extends SessionEventRecord {
  /** Plain text excerpt selected around the match. */
  snippet: string
}

/** One grouped cross-session hit, ranked by its strongest matching event. */
export interface SessionSearchHit extends SessionRecord {
  /** Strongest matching event for this session. */
  bestMatch: SessionEventSearchHit
}
