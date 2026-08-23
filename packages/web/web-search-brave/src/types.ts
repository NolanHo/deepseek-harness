/**
 * Wire types for the Brave Search API (`GET https://api.search.brave.com/res/v1/web/search`).
 * Types only — no runtime code. Brave returns results under `web.results[]`; each
 * entry carries a URL, title, optional `description`, an `age` label (relative
 * text, never mapped), and an optional `published_time` timestamp.
 *
 * @module @deepseek-ai/dsh-web-search-brave/types
 */

/** One entry of Brave's `web.results[]`. */
export interface BraveSearchResult {
  title?: string | null
  url?: string | null
  description?: string | null
  /** Relative age label ("2 days ago"); not portable, so never mapped. */
  age?: string | null
  /** ISO-8601 publication timestamp when Brave reports one. */
  published_time?: string | null
}

/** Brave's search response envelope. */
export interface BraveSearchResponse {
  web?: {
    results?: BraveSearchResult[]
  }
}

/** Brave's error response envelope (best-effort; fields vary by failure). */
export interface BraveError {
  message?: string
  detail?: string
}
