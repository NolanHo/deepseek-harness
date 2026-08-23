import { describe, expect, it } from 'vitest'
import { BochaSearchProvider, BOCHA_DEFAULT_BASE_URL, BOCHA_DEFAULT_COUNT, BOCHA_DEFAULT_FRESHNESS } from '../src/provider.ts'

/**
 * Real-API smoke for the Bocha search provider. Self-skips without `$BOCHA_API_KEY`
 * (CI has no secrets), per the with-key e2e policy in docs/testing.md.
 */
const apiKey = process.env.BOCHA_API_KEY
const maybe = apiKey !== undefined && apiKey.length > 0 ? describe : describe.skip

maybe('BochaSearchProvider real API', () => {
  it('returns sources for a live query', async () => {
    const provider = new BochaSearchProvider({
      apiKey: apiKey!,
      baseURL: process.env.BOCHA_BASE_URL ?? BOCHA_DEFAULT_BASE_URL,
      freshness: BOCHA_DEFAULT_FRESHNESS,
      count: BOCHA_DEFAULT_COUNT,
    })
    const result = await provider.search({ query: 'DeepSeek Harness', maxResults: 5 })
    expect(result.sources.length).toBeGreaterThan(0)
    for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//)
  }, 30_000)
})
