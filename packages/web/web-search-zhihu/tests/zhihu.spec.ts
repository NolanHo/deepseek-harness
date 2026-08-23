import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { ZhihuSearchProvider, ZHIHU_PROVIDER_ID, mapZhihuItem } from '../src/provider.ts'
import * as zhihuPlugin from '../src/index.ts'
import type { ZhihuSearchItem } from '../src/types.ts'

const options = { apiKey: 'zhihu-secret', baseURL: 'https://developer.zhihu.test', count: 5 }

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

function item(overrides: Partial<ZhihuSearchItem> = {}): ZhihuSearchItem {
  return { Title: 'Title', Url: 'https://a.test', ContentText: 'body text', EditTime: 0, ...overrides }
}

/** A `zhihu_search` response whose item count fills `count` so `global_search` is not queried. */
function fullZhihuResponse(overrides: Partial<ZhihuSearchItem> = {}): Record<string, unknown> {
  return { Data: { Items: Array.from({ length: options.count }, () => item(overrides)) } }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a rejection')
}

describe('Zhihu result mapping', () => {
  it('maps a full item', () => {
    expect(mapZhihuItem({
      Title: '  A title  ',
      Url: ' https://a.test ',
      ContentText: 'salient text',
      EditTime: 1_700_000_000,
    })).toEqual({
      url: 'https://a.test',
      title: 'A title',
      snippet: 'salient text',
      publishedAt: new Date(1_700_000_000 * 1000).toISOString(),
    })
  })

  it('drops an item with a blank title or URL', () => {
    expect(mapZhihuItem(item({ Title: '' }))).toBeUndefined()
    expect(mapZhihuItem(item({ Title: '   ' }))).toBeUndefined()
    expect(mapZhihuItem(item({ Url: '' }))).toBeUndefined()
    expect(mapZhihuItem(item({ Title: undefined, Url: undefined }))).toBeUndefined()
  })

  it('omits publishedAt when EditTime is missing, null, or not positive', () => {
    expect(mapZhihuItem(item({ EditTime: 0 }))).not.toHaveProperty('publishedAt')
    expect(mapZhihuItem(item({ EditTime: -1 }))).not.toHaveProperty('publishedAt')
    expect(mapZhihuItem(item({ EditTime: undefined }))).not.toHaveProperty('publishedAt')
    expect(mapZhihuItem(item({ EditTime: null }))).not.toHaveProperty('publishedAt')
  })

  it('truncates a long ContentText to 200 characters with an ellipsis', () => {
    const long = 'x'.repeat(201)
    expect(mapZhihuItem(item({ ContentText: long }))!.snippet).toBe(`${'x'.repeat(200)}...`)
  })

  it('keeps a short ContentText and omits an empty snippet', () => {
    expect(mapZhihuItem(item({ ContentText: 'short' }))!.snippet).toBe('short')
    expect(mapZhihuItem(item({ ContentText: '' }))).not.toHaveProperty('snippet')
    expect(mapZhihuItem(item({ ContentText: null }))).not.toHaveProperty('snippet')
    expect(mapZhihuItem(item({ ContentText: undefined }))).not.toHaveProperty('snippet')
  })
})

describe('ZhihuSearchProvider availability', () => {
  it('is unavailable without a key', () => {
    expect(new ZhihuSearchProvider({ ...options, apiKey: '' }).available()).toBe(false)
  })

  it('is available with a key and valid base URL and count', () => {
    expect(new ZhihuSearchProvider(options).available()).toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(new ZhihuSearchProvider({ ...options, baseURL: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when count is not a positive integer', () => {
    expect(new ZhihuSearchProvider({ ...options, count: 0 }).available()).toBe(false)
    expect(new ZhihuSearchProvider({ ...options, count: 1.5 }).available()).toBe(false)
  })
})

describe('ZhihuSearchProvider request mapping', () => {
  it('sends GET to zhihu_search with query params, bearer auth, timestamp, and redirect rejection', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(fullZhihuResponse()))
    vi.stubGlobal('fetch', fetchMock)

    const provider = new ZhihuSearchProvider({ ...options, count: 2 })
    await provider.search({ query: 'hello', maxResults: 2 })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://developer.zhihu.test/api/v1/content/zhihu_search?Query=hello&Count=2&Offset=0')
    expect(init).toMatchObject({ redirect: 'error' })
    const headers = init.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer zhihu-secret')
    expect(headers['x-request-timestamp']).toMatch(/^\d+$/)
    expect(headers['user-agent']).toBe('deepseek-harness/0.0.1')
  })

  it('does not query global_search when zhihu_search already fills count', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(fullZhihuResponse()))
    vi.stubGlobal('fetch', fetchMock)
    await new ZhihuSearchProvider({ ...options, count: 3 }).search({ query: 'q' })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toContain('/zhihu_search?')
  })

  it('tops up with global_search and deduplicates by URL when zhihu_search is short', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('zhihu_search')) {
        return jsonResponse({ Data: { Items: [item({ Url: 'https://a.test' })] } })
      }
      return jsonResponse({
        Data: {
          Items: [
            item({ Url: 'https://a.test' }), // duplicate of the in-site result
            item({ Url: 'https://b.test', Title: 'B' }),
            item({ Url: '' }), // dropped for a blank URL
            item({ Url: undefined }), // dropped for a missing URL
          ],
        },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await new ZhihuSearchProvider(options).search({ query: 'q', maxResults: 10 })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const urls = fetchMock.mock.calls.map(call => call[0])
    expect(urls[0]).toContain('/zhihu_search?')
    expect(urls[1]).toContain('/global_search?')
    expect(result.sources.map(source => source.url)).toEqual(['https://a.test', 'https://b.test'])
  })

  it('returns the full merge and leaves truncation to the seam', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(fullZhihuResponse({ Url: 'https://x.test' }))))
    const result = await new ZhihuSearchProvider(options).search({ query: 'q', maxResults: 2 })
    expect(result.sources).toHaveLength(options.count)
    expect(result.truncated).toBe(false)
  })

  it('returns the full merge when maxResults is absent', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('zhihu_search')) return jsonResponse({ Data: { Items: [item({ Url: 'https://a.test' })] } })
      return jsonResponse({ Data: { Items: [item({ Url: 'https://b.test' }), item({ Url: 'https://c.test' })] } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await new ZhihuSearchProvider({ ...options, count: 2 }).search({ query: 'q' })
    expect(result.sources.map(source => source.url)).toEqual(['https://a.test', 'https://b.test', 'https://c.test'])
  })

  it('tolerates a response without Data or Items', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('zhihu_search')) return jsonResponse({})
      return jsonResponse({ Data: { Items: null } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await new ZhihuSearchProvider(options).search({ query: 'q' })
    expect(result.sources).toEqual([])
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(fullZhihuResponse()))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await new ZhihuSearchProvider({ ...options, count: 1 }).search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })
})

describe('ZhihuSearchProvider error handling', () => {
  it('maps 401 and 403 to WEB_PROVIDER_ERROR with an auth hint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))
    const unauthorized = await captureError(new ZhihuSearchProvider(options).search({ query: 'q' }))
    expect(unauthorized).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(unauthorized.message).toContain('ZHIHU_ACCESS_SECRET')

    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })))
    const forbidden = await captureError(new ZhihuSearchProvider(options).search({ query: 'q' }))
    expect(forbidden).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(forbidden.message).toContain('auth failed')
  })

  it('maps 429 to WEB_PROVIDER_ERROR with a rate-limit hint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
    const rateLimited = await captureError(new ZhihuSearchProvider(options).search({ query: 'q' }))
    expect(rateLimited).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(rateLimited.message).toContain('rate limited')
  })

  it('maps another HTTP status to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    await expect(new ZhihuSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Zhihu API error (HTTP 500)' }))
  })

  it('rejects a redirect before the Location target is contacted', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 302, headers: { location: 'https://evil.test/leak' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(new ZhihuSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toContain('developer.zhihu.test')
    expect(url).not.toContain('evil.test')
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(new ZhihuSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(new ZhihuSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps a non-JSON success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(new ZhihuSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(new ZhihuSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

describe('web-search-zhihu plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(fullZhihuResponse())))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: ZHIHU_PROVIDER_ID })
    const fiber = await ctx.plugin(zhihuPlugin, { apiKey: 'zhihu-secret' })
    const result = await ctx.web.search({ query: 'q' })
    expect(Array.isArray(result.sources)).toBe(true)
    expect(result.truncated).toBe(false)
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in zhihuPlugin).toBe(false)
  })

  it('threads count and baseURL config into the request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(fullZhihuResponse()))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: ZHIHU_PROVIDER_ID })
    const fiber = await ctx.plugin(zhihuPlugin, { apiKey: 'zhihu-secret', count: 9, baseURL: 'https://custom.test' })
    await ctx.web.search({ query: 'q', maxResults: 9 })
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toBe('https://custom.test/api/v1/content/zhihu_search?Query=q&Count=9&Offset=0')
    await fiber.dispose()
  })

  it('falls back to $ZHIHU_ACCESS_SECRET and the default base URL when config omits them', async () => {
    const prev = process.env.ZHIHU_ACCESS_SECRET
    process.env.ZHIHU_ACCESS_SECRET = 'env-secret'
    try {
      const fetchMock = vi.fn(async () => jsonResponse(fullZhihuResponse()))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: ZHIHU_PROVIDER_ID })
      const fiber = await ctx.plugin(zhihuPlugin, {})
      await ctx.web.search({ query: 'q' })
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toContain('https://developer.zhihu.com/api/v1/content/zhihu_search?')
      expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer env-secret')
      await fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.ZHIHU_ACCESS_SECRET
      else process.env.ZHIHU_ACCESS_SECRET = prev
    }
  })

  it('is unavailable when neither config nor env supplies a key', async () => {
    const prev = process.env.ZHIHU_ACCESS_SECRET
    delete process.env.ZHIHU_ACCESS_SECRET
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: ZHIHU_PROVIDER_ID })
      await ctx.plugin(zhihuPlugin, {})
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
    } finally {
      if (prev !== undefined) process.env.ZHIHU_ACCESS_SECRET = prev
    }
  })
})
