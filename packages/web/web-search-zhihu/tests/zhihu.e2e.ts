import { describe, expect, it } from 'vitest'
import { ZhihuSearchProvider, ZHIHU_DEFAULT_BASE_URL, ZHIHU_DEFAULT_COUNT } from '../src/provider.ts'

/**
 * Real-API smoke for the Zhihu search provider. Self-skips without
 * `$ZHIHU_ACCESS_SECRET` (CI has no secrets), per the with-key e2e policy in
 * docs/testing.md.
 */
const apiKey = process.env.ZHIHU_ACCESS_SECRET
const maybe = apiKey !== undefined && apiKey.length > 0 ? describe : describe.skip

maybe('ZhihuSearchProvider real API', () => {
  it('returns sources for a live query', async () => {
    const provider = new ZhihuSearchProvider({
      apiKey: apiKey!,
      baseURL: process.env.ZHIHU_BASE_URL ?? ZHIHU_DEFAULT_BASE_URL,
      count: ZHIHU_DEFAULT_COUNT,
    })
    const result = await provider.search({ query: 'DeepSeek', maxResults: 5 })
    expect(result.sources.length).toBeGreaterThan(0)
    for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//)
  }, 30_000)
})
