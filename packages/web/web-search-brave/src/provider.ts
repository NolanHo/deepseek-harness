/**
 * `BraveSearchProvider`: a `WebSearchProvider` backed by the Brave Search API
 * (`GET /res/v1/web/search`). It maps each `web.results[]` entry's `title` to
 * `title`, `description` to `snippet`, and `published_time` to `publishedAt`,
 * drops entries without a title, and omits `content` because Brave returns no
 * generated answer.
 * @module @deepseek-ai/dsh-web-search-brave/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { BraveError, BraveSearchResponse, BraveSearchResult } from './types.ts'

/** Stable id this provider registers under. */
export const BRAVE_PROVIDER_ID = 'brave'

/** Default Brave Search endpoint; `/res/v1/web/search` is the operation. */
export const BRAVE_DEFAULT_BASE_URL = 'https://api.search.brave.com'

/** Default result count sent as `count` when a request carries no `maxResults`. */
export const BRAVE_DEFAULT_COUNT = 10

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Resolved provider options (the plugin's `apply` supplies env-var and constant defaults). */
export interface BraveSearchProviderOptions {
  /** Brave API key. Empty/absent makes the provider unavailable. */
  apiKey: string
  /** Endpoint base; `/res/v1/web/search` is appended. */
  baseURL: string
  /** Default result count sent as `count`; a request's `maxResults` wins. */
  count: number
}

/**
 * Map one Brave result to a normalized source, or `undefined` when it carries
 * no title (the seam renders `title ?? hostname(url)` for display, so a
 * title-less entry would surface as a bare hostname) or no URL.
 *
 * @param result - one entry of Brave's `web.results[]`.
 * @returns the normalized source, or `undefined` when the entry has no
 *   non-blank title or no URL.
 */
export function mapBraveResult(result: BraveSearchResult): WebSearchSource | undefined {
  const title = result.title
  if (title == null || title.length === 0) return undefined
  const url = result.url
  if (url == null || url.length === 0) return undefined
  return {
    url,
    title,
    ...result.description != null && result.description.length > 0 ? { snippet: result.description } : {},
    // `age` is a relative label ("2 days ago"), not a portable timestamp; only
    // `published_time` (an ISO-8601 timestamp when present) maps to `publishedAt`.
    ...result.published_time != null && result.published_time.length > 0 ? { publishedAt: result.published_time } : {},
  }
}

/**
 * Map a Brave response envelope to a normalized search result.
 *
 * @param response - the parsed `GET /res/v1/web/search` response body.
 * @returns the normalized result; title-less entries are dropped
 *   ({@link mapBraveResult}).
 */
export function mapBraveResponse(response: BraveSearchResponse): WebSearchResult {
  const sources = (response.web?.results ?? [])
    .map(mapBraveResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  // Brave returns no generated answer, so `content` is omitted. The web service owns the
  // final `maxResults` truncation, so this provider reports `truncated: false`.
  return { sources, truncated: false }
}

/** The Brave-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class BraveSearchProvider implements WebSearchProvider {
  readonly id = BRAVE_PROVIDER_ID

  constructor(private readonly options: BraveSearchProviderOptions) {}

  available(): boolean {
    return this.options.apiKey.length > 0
      && isValidBaseUrl(this.options.baseURL)
      && isPositiveInteger(this.options.count)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // A per-request bound wins over the configured default; `count` is always sent.
    const count = request.maxResults ?? this.options.count
    const url = `${this.options.baseURL}/res/v1/web/search?q=${encodeURIComponent(request.query)}&count=${count}`
    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'error',
        headers: {
          'x-subscription-token': this.options.apiKey,
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Brave search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Brave search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Brave API error (HTTP ${status})`
      try {
        const parsed = await response.json() as BraveError
        const detail = parsed.message ?? parsed.detail
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (isAbortError(error)) throw new WebError('Brave search aborted', 'WEB_ABORTED', { cause: error })
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
        // cost a richer provider message, never the real error.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as BraveSearchResponse
      return mapBraveResponse(payload)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Brave search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Brave returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

/** True when `baseURL` parses as an absolute URL (a cheap local config check). */
function isValidBaseUrl(baseURL: string): boolean {
  return URL.canParse(baseURL)
}

/** True for a request limit that can be sent to Brave (a positive whole number). */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
