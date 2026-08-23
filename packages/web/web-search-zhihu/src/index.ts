/**
 * `@deepseek-ai/dsh-web-search-zhihu`: registers a Zhihu-backed
 * `WebSearchProvider` with `ctx.web`. A function/namespace plugin (NOT a
 * default-export service): a search provider does not own the `ctx.web` key —
 * it registers INTO the seam's provider registry, exactly as
 * `@deepseek-ai/dsh-llm-deepseek` registers an adapter into `ctx.llm`. The key
 * is owned by `@deepseek-ai/dsh-web`.
 *
 * @module @deepseek-ai/dsh-web-search-zhihu
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  ZhihuSearchProvider,
  ZHIHU_DEFAULT_BASE_URL,
  ZHIHU_DEFAULT_COUNT,
} from './provider.ts'

export {
  ZHIHU_DEFAULT_BASE_URL,
  ZHIHU_DEFAULT_COUNT,
  ZHIHU_PROVIDER_ID,
  ZhihuSearchProvider,
} from './provider.ts'
export type { ZhihuSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-zhihu'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Zhihu access secret. Falls back to `$ZHIHU_ACCESS_SECRET`. Empty → provider unavailable. */
  apiKey?: string
  /** Endpoint base; `/api/v1/content/<backend>` is appended. Defaults to the developer API. */
  baseURL?: string
  /** Per-backend result count. Defaults to 5. Must be a positive integer. */
  count?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string(),
  baseURL: z.string(),
  count: z.number().step(1).min(1),
})

/** Register the Zhihu search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new ZhihuSearchProvider({
    // Every environment layer may name this key: the product trusts the
    // project it is launched in, and the managed store is not involved here.
    apiKey: config.apiKey ?? launchEnvironmentOf(ctx).get('ZHIHU_ACCESS_SECRET')?.value ?? '',
    baseURL: config.baseURL ?? ZHIHU_DEFAULT_BASE_URL,
    count: config.count ?? ZHIHU_DEFAULT_COUNT,
  }))
}
