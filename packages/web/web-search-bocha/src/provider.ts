/**
 * `BochaSearchProvider`: a `WebSearchProvider` backed by the Bocha search API
 * (`POST /v1/web-search`). It maps each `data.webPages.value[]` entry's first
 * non-blank `snippet` (falling back to `summary`) to `snippet`, maps `name` to
 * `title`, maps `dateLastCrawled` to `publishedAt`, drops entries without a
 * snippet or summary, and omits `content` because Bocha returns no generated
 * answer.
 * @module @deepseek-ai/dsh-web-search-bocha/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { BochaSearchResponse, BochaWebPage } from './types.ts'

/** Stable id this provider registers under. */
export const BOCHA_PROVIDER_ID = 'bocha'

/** Default Bocha search endpoint; `/v1/web-search` is the operation. */
export const BOCHA_DEFAULT_BASE_URL = 'https://api.bochaai.com'

/** Default recency filter: leave results unfiltered. */
export const BOCHA_DEFAULT_FRESHNESS = 'noLimit'

/** Default result count sent as `count` when a request carries no `maxResults`. */
export const BOCHA_DEFAULT_COUNT = 10

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Resolved provider options (the plugin's `apply` supplies env-var and constant defaults). */
export interface BochaSearchProviderOptions {
  /** Bocha API key. Empty/absent makes the provider unavailable. */
  apiKey: string
  /** Endpoint base; `/v1/web-search` is appended. */
  baseURL: string
  /** Recency filter sent as `freshness`. */
  freshness: string
  /** Default result count sent as `count`; a request's `maxResults` wins. */
  count: number
}

/**
 * Map one Bocha result to a normalized source, or `undefined` when it carries
 * no portable snippet (both `snippet` and `summary` blank — the seam has no
 * other field to derive a snippet from, and inventing one would lie) or no URL.
 *
 * @param result - one entry of Bocha's `data.webPages.value[]`.
 * @returns the normalized source, or `undefined` when the entry has no
 *   non-blank snippet/summary or no URL.
 */
export function mapBochaResult(result: BochaWebPage): WebSearchSource | undefined {
  const snippet = firstNonBlank(result.snippet, result.summary)
  if (snippet === undefined) return undefined
  const url = result.url
  if (url == null || url.length === 0) return undefined
  return {
    url,
    ...result.name != null && result.name.length > 0 ? { title: result.name } : {},
    snippet,
    ...result.dateLastCrawled != null && result.dateLastCrawled.length > 0 ? { publishedAt: result.dateLastCrawled } : {},
  }
}

/**
 * Map a Bocha response envelope to a normalized search result.
 *
 * @param response - the parsed `POST /v1/web-search` response body.
 * @returns the normalized result; snippet-less entries are dropped
 *   ({@link mapBochaResult}).
 */
export function mapBochaResponse(response: BochaSearchResponse): WebSearchResult {
  const sources = (response.data?.webPages?.value ?? [])
    .map(mapBochaResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  // Bocha returns no generated answer, so `content` is omitted. The web service owns the
  // final `maxResults` truncation, so this provider reports `truncated: false`.
  return { sources, truncated: false }
}

/** The Bocha-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class BochaSearchProvider implements WebSearchProvider {
  readonly id = BOCHA_PROVIDER_ID

  constructor(private readonly options: BochaSearchProviderOptions) {}

  available(): boolean {
    return this.options.apiKey.length > 0
      && isValidBaseUrl(this.options.baseURL)
      && isPositiveInteger(this.options.count)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // A per-request bound wins over the configured default; `count` is always sent.
    const count = request.maxResults ?? this.options.count
    let response: Response
    try {
      response = await fetch(`${this.options.baseURL}/v1/web-search`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({
          query: request.query,
          freshness: this.options.freshness,
          summary: true,
          count,
        }),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Bocha search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Bocha search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `Bocha API error (HTTP ${status})`
      try {
        const parsed = await response.json() as BochaSearchResponse
        const detail = parsed.message
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (isAbortError(error)) throw new WebError('Bocha search aborted', 'WEB_ABORTED', { cause: error })
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
        // cost a richer provider message, never the real error.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as BochaSearchResponse
      // Bocha reports failures in-band: a 2xx body whose `code` is not 200 is an error.
      if (payload.code !== 200) {
        let message = 'Bocha API error (non-200 code)'
        const detail = payload.msg ?? payload.message
        if (detail !== undefined && detail.length > 0) message = detail
        throw new WebError(message, 'WEB_PROVIDER_ERROR')
      }
      return mapBochaResponse(payload)
    } catch (error: unknown) {
      // The in-band non-200 failure above already carries its final code/message.
      if (error instanceof WebError) throw error
      if (isAbortError(error)) throw new WebError('Bocha search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Bocha returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

/** The first non-blank of `snippet`/`summary`, or `undefined` when both are blank. */
function firstNonBlank(a: string | null | undefined, b: string | null | undefined): string | undefined {
  if (a != null && a.trim().length > 0) return a
  if (b != null && b.trim().length > 0) return b
  return undefined
}

/** True when `baseURL` parses as an absolute URL (a cheap local config check). */
function isValidBaseUrl(baseURL: string): boolean {
  return URL.canParse(baseURL)
}

/** True for a request limit that can be sent to Bocha (a positive whole number). */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
