/**
 * `@deepseek-ai/dsh-web-search-bocha`: registers a Bocha-backed `WebSearchProvider`
 * with `ctx.web`. A function/namespace plugin (NOT a default-export service):
 * a search provider does not own the `ctx.web` key — it registers INTO the
 * seam's provider registry, exactly as `@deepseek-ai/dsh-llm-deepseek`
 * registers an adapter into `ctx.llm`. The key is owned by `@deepseek-ai/dsh-web`.
 *
 * @module @deepseek-ai/dsh-web-search-bocha
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  BochaSearchProvider,
  BOCHA_DEFAULT_BASE_URL,
  BOCHA_DEFAULT_COUNT,
  BOCHA_DEFAULT_FRESHNESS,
} from './provider.ts'

export {
  BOCHA_DEFAULT_BASE_URL,
  BOCHA_DEFAULT_COUNT,
  BOCHA_DEFAULT_FRESHNESS,
  BOCHA_PROVIDER_ID,
  BochaSearchProvider,
} from './provider.ts'
export type { BochaSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-bocha'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Bocha API key. Falls back to `$BOCHA_API_KEY`. Empty → provider unavailable. */
  apiKey?: string
  /** Endpoint base; `/v1/web-search` is appended. Defaults to the public API. */
  baseURL?: string
  /** Recency filter sent as Bocha's `freshness`. Defaults to `noLimit`. */
  freshness?: string
  /** Default result count sent as `count` when a request carries no `maxResults`. */
  count?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string(),
  baseURL: z.string(),
  freshness: z.string(),
  count: z.number().step(1).min(1),
})

/** Register the Bocha search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new BochaSearchProvider({
    // Every environment layer may name this key: the product trusts the
    // project it is launched in, and the managed store is not involved here.
    apiKey: config.apiKey ?? launchEnvironmentOf(ctx).get('BOCHA_API_KEY')?.value ?? '',
    baseURL: config.baseURL ?? BOCHA_DEFAULT_BASE_URL,
    freshness: config.freshness ?? BOCHA_DEFAULT_FRESHNESS,
    count: config.count ?? BOCHA_DEFAULT_COUNT,
  }))
}
