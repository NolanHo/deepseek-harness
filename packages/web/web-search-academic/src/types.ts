/**
 * Wire types for the academic search backends: the arXiv Atom API
 * (`GET https://export.arxiv.org/api/query`) and the Semantic Scholar Graph API
 * (`GET {base}/paper/search`). Types only — no runtime code. The Atom feed is
 * parsed by `fast-xml-parser` into the loose shape below; Semantic Scholar
 * returns a flat `data[]` of papers.
 *
 * @module @deepseek-ai/dsh-web-search-academic/types
 */

/** One arXiv Atom `<entry>` after `fast-xml-parser` has parsed the feed. */
export interface ArxivEntry {
  id?: string
  title?: string
  summary?: string
  published?: string
}

/** The parsed arXiv Atom feed envelope (one `<entry>` parses as an object, many as an array). */
export interface ArxivFeed {
  feed?: { entry?: ArxivEntry[] | ArxivEntry } | null
}

/** One Semantic Scholar paper from `/paper/search`'s `data[]`. */
export interface S2Paper {
  title?: string | null
  abstract?: string | null
  url?: string | null
  publicationDate?: string | null
}

/** Semantic Scholar `/paper/search` response envelope. */
export interface S2SearchResponse {
  data?: S2Paper[] | null
}
