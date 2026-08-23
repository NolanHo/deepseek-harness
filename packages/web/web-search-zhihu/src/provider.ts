/**
 * `ZhihuSearchProvider`: a `WebSearchProvider` backed by the Zhihu developer
 * search API. It queries the in-site `zhihu_search` backend first and tops up
 * with the whole-web `global_search` backend when the in-site backend returns
 * fewer than `count` items, deduplicates the merge by URL, and maps
 * `Data.Items[]` into the seam's normalized `WebSearchResult`. Requests carry
 * a bearer credential, so HTTP redirects are rejected before the `Location`
 * target is contacted.
 *
 * @module @deepseek-ai/dsh-web-search-zhihu/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { ZhihuSearchItem, ZhihuSearchResponse } from './types.ts'

/** Stable id this provider registers under. */
export const ZHIHU_PROVIDER_ID = 'zhihu'

/** Default Zhihu developer API base; `/api/v1/content/<backend>` is appended. */
export const ZHIHU_DEFAULT_BASE_URL = 'https://developer.zhihu.com'

/** Default per-backend result count when the plugin config omits `count`. */
export const ZHIHU_DEFAULT_COUNT = 5

/** Maximum `snippet` length; longer `ContentText` is truncated with an ellipsis. */
const ZHIHU_SUMMARY_LENGTH = 200

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** The two search backends this provider composes, in query order. */
type ZhihuBackend = 'zhihu_search' | 'global_search'

/** Resolved provider options (the plugin's `apply` supplies env-var and constant defaults). */
export interface ZhihuSearchProviderOptions {
  /** Zhihu access secret. Empty/absent makes the provider unavailable. */
  apiKey: string
  /** Endpoint base; `/api/v1/content/<backend>` is appended. */
  baseURL: string
  /** Per-backend result count, also the fallback bound when a request omits `maxResults`. */
  count: number
}

/**
 * Map one Zhihu item to a normalized source, or `undefined` when it carries no
 * title or URL (an entry without both is not citeable).
 *
 * @param item - one entry of a backend's `Data.Items[]`.
 * @returns the normalized source, or `undefined` when title or URL is blank.
 */
export function mapZhihuItem(item: ZhihuSearchItem): WebSearchSource | undefined {
  const title = item.Title?.trim() ?? ''
  const url = item.Url?.trim() ?? ''
  if (title.length === 0 || url.length === 0) return undefined
  const editTime = item.EditTime
  const snippet = summarize(item.ContentText)
  return {
    url,
    title,
    ...(snippet.length > 0 ? { snippet } : {}),
    ...(typeof editTime === 'number' && editTime > 0 ? { publishedAt: new Date(editTime * 1000).toISOString() } : {}),
  }
}

/** Truncate `ContentText` to {@link ZHIHU_SUMMARY_LENGTH} characters with an ellipsis. */
function summarize(text: string | null | undefined): string {
  const value = text ?? ''
  if (value.length <= ZHIHU_SUMMARY_LENGTH) return value
  return `${value.slice(0, ZHIHU_SUMMARY_LENGTH)}...`
}

/** The Zhihu-backed search provider. */
export class ZhihuSearchProvider implements WebSearchProvider {
  readonly id = ZHIHU_PROVIDER_ID

  constructor(private readonly options: ZhihuSearchProviderOptions) {}

  available(): boolean {
    return this.options.apiKey.length > 0
      && URL.canParse(this.options.baseURL)
      && isPositiveInteger(this.options.count)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const count = this.options.count
    const inSite = await this.fetchBackend('zhihu_search', request.query, count, signal)
    let items = inSite
    if (inSite.length < count) {
      const globalItems = await this.fetchBackend('global_search', request.query, count, signal)
      const seen = new Set<string>()
      items = [...inSite, ...globalItems].filter((item) => {
        const url = item.Url?.trim() ?? ''
        if (url.length === 0 || seen.has(url)) return false
        seen.add(url)
        return true
      })
    }
    // No local truncation: the seam enforces `maxResults` and sets `truncated`,
    // so an over-cap merged list surfaces the refine-the-query hint to the model.
    return { sources: items.map(mapZhihuItem).filter((source): source is WebSearchSource => source !== undefined), truncated: false }
  }

  /** Query one backend and return its raw items (empty on a missing `Data.Items`). */
  private async fetchBackend(path: ZhihuBackend, query: string, count: number, signal?: AbortSignal): Promise<ZhihuSearchItem[]> {
    const url = new URL(`${trimTrailingSlash(this.options.baseURL)}/api/v1/content/${path}`)
    url.searchParams.set('Query', query)
    url.searchParams.set('Count', String(count))
    url.searchParams.set('Offset', '0')
    let response: Response
    try {
      response = await fetch(url.toString(), {
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${this.options.apiKey}`,
          'x-request-timestamp': String(Math.floor(Date.now() / 1000)),
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Zhihu search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Zhihu search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) throw zhihuHttpError(response.status)

    try {
      const payload = await response.json() as ZhihuSearchResponse
      return payload.Data?.Items ?? []
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Zhihu search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Zhihu returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

/** Map a non-2xx Zhihu status to the matching provider error with its hint. */
function zhihuHttpError(status: number): WebError {
  if (status === 401 || status === 403) {
    return new WebError(`Zhihu API auth failed (HTTP ${status}) — check ZHIHU_ACCESS_SECRET`, 'WEB_PROVIDER_ERROR')
  }
  if (status === 429) {
    return new WebError('Zhihu API rate limited (HTTP 429) — please retry in a few seconds', 'WEB_PROVIDER_ERROR')
  }
  return new WebError(`Zhihu API error (HTTP ${status})`, 'WEB_PROVIDER_ERROR')
}

/** Strip trailing slashes so the endpoint path is joined without a double slash. */
function trimTrailingSlash(baseURL: string): string {
  return baseURL.replace(/\/+$/, '')
}

/** True for a request limit that can be sent to Zhihu (a positive whole number). */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
