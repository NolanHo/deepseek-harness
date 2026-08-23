/**
 * Wire types for the Zhihu developer search API
 * (`GET {base}/api/v1/content/{zhihu_search|global_search}`). Types only — no
 * runtime code. Both backends share one response envelope: a `Data` object
 * whose `Items[]` carries each hit's title, URL, author, summary text, vote and
 * comment counts, and edit time.
 *
 * @module @deepseek-ai/dsh-web-search-zhihu/types
 */

/** One entry of a Zhihu search backend's `Data.Items[]`. */
export interface ZhihuSearchItem {
  Title?: string | null | undefined
  Url?: string | null | undefined
  AuthorName?: string | null | undefined
  ContentText?: string | null | undefined
  VoteUpCount?: number | null | undefined
  CommentCount?: number | null | undefined
  /** Unix seconds since epoch; `0` when the item carries no edit time. */
  EditTime?: number | null | undefined
}

/** The `Data` envelope shared by `zhihu_search` and `global_search`. */
export interface ZhihuSearchData {
  Items?: ZhihuSearchItem[] | null
  HasMore?: boolean | null
  SearchHashId?: string | null
}

/** A Zhihu search backend response envelope. */
export interface ZhihuSearchResponse {
  Data?: ZhihuSearchData | null
}
