/**
 * `@deepseek-ai/dsh-web-search-academic`: registers an arXiv + Semantic
 * Scholar-backed `WebSearchProvider` with `ctx.web`. A function/namespace
 * plugin (NOT a default-export service): a search provider does not own the
 * `ctx.web` key — it registers INTO the seam's provider registry. The key is
 * owned by `@deepseek-ai/dsh-web`.
 *
 * @module @deepseek-ai/dsh-web-search-academic
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  AcademicSearchProvider,
  ACADEMIC_DEFAULT_COUNT,
  ARXIV_DEFAULT_BASE_URL,
  S2_DEFAULT_BASE_URL,
  S2_MIN_INTERVAL_MS,
} from './provider.ts'

export {
  ACADEMIC_DEFAULT_COUNT,
  ACADEMIC_PROVIDER_ID,
  ARXIV_DEFAULT_BASE_URL,
  AcademicSearchProvider,
  S2_DEFAULT_BASE_URL,
  S2_MIN_INTERVAL_MS,
} from './provider.ts'
export type { AcademicSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-academic'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills constant defaults). */
export interface Config {
  /** arXiv Atom API query endpoint. Defaults to the public export.arxiv.org endpoint. */
  arxivBaseURL?: string
  /** Semantic Scholar Graph API base; `/paper/search` is appended. */
  s2BaseURL?: string
  /** Per-backend result count. Defaults to 5. Must be a positive integer. */
  count?: number
  /** Minimum interval between Semantic Scholar requests, in milliseconds. Defaults to 1500. */
  minS2IntervalMs?: number
}

export const Config: z<Config> = z.object({
  arxivBaseURL: z.string(),
  s2BaseURL: z.string(),
  count: z.number().step(1).min(1),
  minS2IntervalMs: z.number().step(1).min(1),
})

/** Register the academic search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new AcademicSearchProvider({
    arxivBaseURL: config.arxivBaseURL ?? ARXIV_DEFAULT_BASE_URL,
    s2BaseURL: config.s2BaseURL ?? S2_DEFAULT_BASE_URL,
    count: config.count ?? ACADEMIC_DEFAULT_COUNT,
    minS2IntervalMs: config.minS2IntervalMs ?? S2_MIN_INTERVAL_MS,
  }))
}
