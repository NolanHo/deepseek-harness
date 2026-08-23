/**
 * Wire types for the Bocha search API (`POST https://api.bochaai.com/v1/web-search`).
 * Types only — no runtime code. Bocha nests results under `data.webPages.value[]`;
 * each entry carries a URL, optional name, optional `snippet`/`summary`, and an
 * optional `dateLastCrawled`.
 *
 * @module @deepseek-ai/dsh-web-search-bocha/types
 */

/** Request body sent to Bocha's web-search endpoint. */
export interface BochaSearchRequest {
  query: string
  /** Recency filter; `noLimit` leaves results unfiltered. */
  freshness: string
  /** Ask Bocha to include per-result summaries. */
  summary: boolean
  /** Result-count control; the seam still enforces the bound on return. */
  count: number
}

/** One entry of Bocha's nested `data.webPages.value[]`. */
export interface BochaWebPage {
  name?: string | null
  url?: string | null
  snippet?: string | null
  summary?: string | null
  siteName?: string | null
  siteIcon?: string | null
  dateLastCrawled?: string | null
}

/** Bocha's search response envelope (also the error envelope: `code`/`msg`). */
export interface BochaSearchResponse {
  /** HTTP-style status code: `200` means success; any other value is an error carrying `msg`. */
  code?: number
  msg?: string | null
  message?: string
  data?: {
    webPages?: {
      value?: BochaWebPage[]
    }
  }
}
