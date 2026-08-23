import { describe, expect, it } from 'vitest'
import {
  AcademicSearchProvider,
  ACADEMIC_DEFAULT_COUNT,
  ARXIV_DEFAULT_BASE_URL,
  S2_DEFAULT_BASE_URL,
  S2_MIN_INTERVAL_MS,
} from '../src/provider.ts'

/**
 * Real-API smoke for the academic search provider. It carries no credential, so
 * it always runs; the 30s timeout absorbs the Semantic Scholar throttle.
 */
describe('AcademicSearchProvider real API', () => {
  it('returns sources for a live query', async () => {
    const provider = new AcademicSearchProvider({
      arxivBaseURL: process.env.ARXIV_BASE_URL ?? ARXIV_DEFAULT_BASE_URL,
      s2BaseURL: process.env.S2_BASE_URL ?? S2_DEFAULT_BASE_URL,
      count: ACADEMIC_DEFAULT_COUNT,
      minS2IntervalMs: S2_MIN_INTERVAL_MS,
    })
    const result = await provider.search({ query: 'DeepSeek Harness', maxResults: 5 })
    expect(result.sources.length).toBeGreaterThan(0)
    for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//)
  }, 30_000)
})
