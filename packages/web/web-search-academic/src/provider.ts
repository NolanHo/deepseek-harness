/**
 * `AcademicSearchProvider`: a `WebSearchProvider` that composes the arXiv Atom
 * API and the Semantic Scholar Graph API. Both backends are queried in
 * parallel; Semantic Scholar results come first, arXiv entries second, and the
 * merge is truncated to the request's `maxResults`. Semantic Scholar requests
 * are throttled to a minimum interval because its free tier rate-limits
 * aggressively. The provider carries no credential, so redirects follow by
 * default.
 *
 * @module @deepseek-ai/dsh-web-search-academic/provider
 */

import { XMLParser } from 'fast-xml-parser'
import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { ArxivEntry, ArxivFeed, S2Paper, S2SearchResponse } from './types.ts'

/** Stable id this provider registers under. */
export const ACADEMIC_PROVIDER_ID = 'academic'

/** Default arXiv Atom API query endpoint (a full endpoint, not a base). */
export const ARXIV_DEFAULT_BASE_URL = 'https://export.arxiv.org/api/query'

/** Default Semantic Scholar Graph API base; `/paper/search` is appended. */
export const S2_DEFAULT_BASE_URL = 'https://api.semanticscholar.org/graph/v1'

/** Default per-backend result count when the plugin config omits `count`. */
export const ACADEMIC_DEFAULT_COUNT = 5

/** Default minimum interval between Semantic Scholar requests, in milliseconds. */
export const S2_MIN_INTERVAL_MS = 1500

/** Maximum `snippet` length for arXiv summaries and Semantic Scholar abstracts. */
const ACADEMIC_SUMMARY_LENGTH = 300

/** Semantic Scholar fields requested; only the fields this provider maps. */
const S2_FIELDS = 'title,abstract,url,publicationDate'

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Resolved provider options (the plugin's `apply` supplies constant defaults). */
export interface AcademicSearchProviderOptions {
  /** arXiv Atom API query endpoint (a full endpoint). */
  arxivBaseURL: string
  /** Semantic Scholar Graph API base; `/paper/search` is appended. */
  s2BaseURL: string
  /** Per-backend result count, also the fallback bound when a request omits `maxResults`. */
  count: number
  /** Minimum interval between Semantic Scholar requests, in milliseconds. */
  minS2IntervalMs: number
}

/**
 * Parse an arXiv Atom feed into its entries, normalizing a single `<entry>` to
 * an array. `fast-xml-parser` returns one `<entry>` as an object and many as an
 * array, so this method normalizes before the caller maps.
 *
 * @param xml - the Atom feed document text.
 * @returns the parsed entries; an absent or empty feed yields `[]`.
 */
export function parseArxivAtom(xml: string): ArxivEntry[] {
  const parser = new XMLParser()
  const parsed = parser.parse(xml) as ArxivFeed
  const entry = parsed.feed?.entry
  if (entry === undefined) return []
  return Array.isArray(entry) ? entry : [entry]
}

/**
 * Map one arXiv entry to a normalized source, or `undefined` when it carries no
 * title. The `id`'s last path segment becomes the `/abs/` URL.
 *
 * @param entry - one parsed `<entry>`.
 * @returns the normalized source, or `undefined` when the title is blank.
 */
export function mapArxivEntry(entry: ArxivEntry): WebSearchSource | undefined {
  const title = normalizeText(entry.title)
  if (title.length === 0) return undefined
  const id = entry.id ?? ''
  const arxivId = id.slice(id.lastIndexOf('/') + 1)
  return {
    url: `https://arxiv.org/abs/${arxivId}`,
    title,
    snippet: normalizeText(entry.summary).slice(0, ACADEMIC_SUMMARY_LENGTH),
    ...(entry.published != null && entry.published.length > 0 ? { publishedAt: entry.published } : {}),
  }
}

/**
 * Map one Semantic Scholar paper to a normalized source, or `undefined` when it
 * carries no title.
 *
 * @param paper - one entry of the response's `data[]`.
 * @returns the normalized source, or `undefined` when the title is blank.
 */
export function mapS2Paper(paper: S2Paper): WebSearchSource | undefined {
  const title = (paper.title ?? '').trim()
  if (title.length === 0) return undefined
  return {
    url: paper.url ?? '',
    title,
    snippet: (paper.abstract ?? '').slice(0, ACADEMIC_SUMMARY_LENGTH),
    ...(paper.publicationDate != null && paper.publicationDate.length > 0 ? { publishedAt: paper.publicationDate } : {}),
  }
}

/** Trim and collapse newlines, matching the arXiv title/summary normalization of the source port. */
function normalizeText(text: string | null | undefined): string {
  return (text ?? '').trim().replace(/\n/g, ' ')
}

/** The arXiv + Semantic Scholar-backed search provider. */
export class AcademicSearchProvider implements WebSearchProvider {
  readonly id = ACADEMIC_PROVIDER_ID

  /** Epoch milliseconds of the last Semantic Scholar request; `0` means never. */
  private lastS2RequestAt = 0

  constructor(private readonly options: AcademicSearchProviderOptions) {}

  available(): boolean {
    return URL.canParse(this.options.arxivBaseURL)
      && URL.canParse(this.options.s2BaseURL)
      && isPositiveInteger(this.options.count)
      && isPositiveInteger(this.options.minS2IntervalMs)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const count = this.options.count
    // Degrade to the surviving backend rather than failing the whole call:
    // Semantic Scholar's free tier rate-limits aggressively, and the arXiv
    // half remains a complete answer. An abort still surfaces; any other
    // failure only throws when both backends rejected.
    const [s2, arxiv] = await Promise.allSettled([
      this.searchSemanticScholar(request.query, count, signal),
      this.searchArxiv(request.query, count, signal),
    ])
    const abortReason = [s2, arxiv].find((result): result is PromiseRejectedResult =>
      result.status === 'rejected' && isWebAbort(result.reason))
    if (abortReason !== undefined) throw abortReason.reason
    if (s2.status === 'rejected' && arxiv.status === 'rejected') throw s2.reason
    // No local truncation: the seam enforces `maxResults` and sets `truncated`,
    // so an over-cap merge surfaces the refine-the-query hint to the model.
    return {
      sources: [
        ...(s2.status === 'fulfilled' ? s2.value : []),
        ...(arxiv.status === 'fulfilled' ? arxiv.value : []),
      ],
      truncated: false,
    }
  }

  /** Query Semantic Scholar, honoring the minimum-interval throttle. */
  private async searchSemanticScholar(query: string, count: number, signal?: AbortSignal): Promise<WebSearchSource[]> {
    await this.throttleS2()
    const url = new URL(`${trimTrailingSlash(this.options.s2BaseURL)}/paper/search`)
    url.searchParams.set('query', query)
    url.searchParams.set('limit', String(count))
    url.searchParams.set('fields', S2_FIELDS)
    const response = await this.fetchResponse(url.toString(), 'Semantic Scholar', signal)
    try {
      const payload = await response.json() as S2SearchResponse
      return (payload.data ?? []).map(mapS2Paper).filter((source): source is WebSearchSource => source !== undefined)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Academic search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Semantic Scholar returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  /** Query arXiv and map the parsed Atom entries. */
  private async searchArxiv(query: string, count: number, signal?: AbortSignal): Promise<WebSearchSource[]> {
    const url = new URL(this.options.arxivBaseURL)
    url.searchParams.set('search_query', `all:${query}`)
    url.searchParams.set('start', '0')
    url.searchParams.set('max_results', String(count))
    url.searchParams.set('sortBy', 'relevance')
    url.searchParams.set('sortOrder', 'descending')
    const response = await this.fetchResponse(url.toString(), 'arXiv', signal)
    let text: string
    try {
      text = await response.text()
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Academic search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`arXiv returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    let entries: ArxivEntry[]
    try {
      entries = parseArxivAtom(text)
    } catch (error: unknown) {
      throw new WebError(`arXiv returned an unparseable Atom feed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    return entries.map(mapArxivEntry).filter((source): source is WebSearchSource => source !== undefined)
  }

  /** Sleep the difference until `minS2IntervalMs` has elapsed since the last Semantic Scholar request. */
  private async throttleS2(): Promise<void> {
    const now = Date.now()
    const elapsed = now - this.lastS2RequestAt
    if (elapsed < this.options.minS2IntervalMs) {
      await sleep(this.options.minS2IntervalMs - elapsed)
    }
    this.lastS2RequestAt = Date.now()
  }

  /** Fetch with a user-agent; no credential, so redirects follow by default. */
  private async fetchResponse(url: string, backend: string, signal?: AbortSignal): Promise<Response> {
    let response: Response
    try {
      response = await fetch(url, {
        headers: {
          'accept': 'application/xml, application/json, */*',
          'user-agent': USER_AGENT,
        },
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Academic search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`${backend} search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (!response.ok) {
      throw new WebError(`${backend} API error (HTTP ${response.status})`, 'WEB_PROVIDER_ERROR')
    }
    return response
  }
}

/** Resolve a millisecond delay as a promise (mockable by `vi.useFakeTimers`). */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Strip trailing slashes so the Semantic Scholar endpoint path is joined without a double slash. */
function trimTrailingSlash(baseURL: string): string {
  return baseURL.replace(/\/+$/, '')
}

/** True for a request limit that can be sent to either backend (a positive whole number). */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** True for a `WebError` carrying the `WEB_ABORTED` code (backend abort wrapping). */
function isWebAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'WEB_ABORTED'
}
