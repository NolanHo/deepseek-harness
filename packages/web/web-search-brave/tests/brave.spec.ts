import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as bravePlugin from '../src/index.ts'
import { BraveSearchProvider, BRAVE_PROVIDER_ID, mapBraveResponse, mapBraveResult } from '../src/provider.ts'

const options = { apiKey: 'brave-key', baseURL: 'https://api.search.brave.test', count: 10 }

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Brave result mapping', () => {
  it('maps a full result entry', () => {
    expect(mapBraveResult({
      title: 'A',
      url: 'https://a.test',
      description: 'salient description',
      age: '2 days ago',
      published_time: '2026-01-01T00:00:00Z',
    })).toEqual({ url: 'https://a.test', title: 'A', snippet: 'salient description', publishedAt: '2026-01-01T00:00:00Z' })
  })

  it('drops a result with no title', () => {
    expect(mapBraveResult({ url: 'https://a.test', description: 'hi' })).toBeUndefined()
    expect(mapBraveResult({ url: 'https://a.test', title: null, description: 'hi' })).toBeUndefined()
    expect(mapBraveResult({ url: 'https://a.test', title: '', description: 'hi' })).toBeUndefined()
  })

  it('drops a result with no URL', () => {
    expect(mapBraveResult({ title: 'A', description: 'hi' })).toBeUndefined()
    expect(mapBraveResult({ title: 'A', url: '', description: 'hi' })).toBeUndefined()
  })

  it('omits null/empty optional fields rather than emitting them', () => {
    expect(mapBraveResult({ url: 'https://a.test', title: 'A', description: null, published_time: null }))
      .toEqual({ url: 'https://a.test', title: 'A' })
    expect(mapBraveResult({ url: 'https://a.test', title: 'A', description: '', published_time: '' }))
      .toEqual({ url: 'https://a.test', title: 'A' })
  })

  it('ignores age even when present', () => {
    expect(mapBraveResult({ url: 'https://a.test', title: 'A', age: '1 hour ago' }))
      .toEqual({ url: 'https://a.test', title: 'A' })
  })

  it('maps a response to a result with no content and filtered sources', () => {
    const result = mapBraveResponse({
      web: { results: [
        { url: 'https://a.test', title: 'A', description: 'one' },
        { url: 'https://b.test', description: 'no title' },
        { url: 'https://c.test', title: 'C' },
      ] },
    })
    expect(result).toEqual({
      sources: [
        { url: 'https://a.test', title: 'A', snippet: 'one' },
        { url: 'https://c.test', title: 'C' },
      ],
      truncated: false,
    })
    expect(result.content).toBeUndefined()
  })

  it('tolerates a missing web/results array', () => {
    expect(mapBraveResponse({}).sources).toEqual([])
    expect(mapBraveResponse({ web: {} }).sources).toEqual([])
  })
})

describe('BraveSearchProvider availability', () => {
  it('is unavailable without a key', () => {
    expect(new BraveSearchProvider({ ...options, apiKey: '' }).available()).toBe(false)
  })

  it('is available with a key', () => {
    expect(new BraveSearchProvider(options).available()).toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(new BraveSearchProvider({ ...options, baseURL: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when count is not a positive integer', () => {
    expect(new BraveSearchProvider({ ...options, count: 0 }).available()).toBe(false)
    expect(new BraveSearchProvider({ ...options, count: 1.5 }).available()).toBe(false)
  })
})

describe('BraveSearchProvider request mapping', () => {
  it('sends the encoded query, count and subscription-token header', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [{ url: 'https://a.test', title: 'A' }] } }))
    vi.stubGlobal('fetch', fetchMock)

    await new BraveSearchProvider(options).search({ query: 'hello world', maxResults: 5 })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.search.brave.test/res/v1/web/search?q=hello%20world&count=5')
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
    expect((init.headers as Record<string, string>)['x-subscription-token']).toBe('brave-key')
    expect((init.headers as Record<string, string>)['accept']).toBe('application/json')
    expect((init.headers as Record<string, string>)['user-agent']).toBe('deepseek-harness/0.0.1')
  })

  it('falls back to the configured count when a request omits maxResults', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    await new BraveSearchProvider({ ...options, count: 7 }).search({ query: 'q' })
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toContain('count=7')
  })

  it('lets a request maxResults win over the configured count', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    await new BraveSearchProvider({ ...options, count: 7 }).search({ query: 'q', maxResults: 2 })
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toContain('count=2')
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await new BraveSearchProvider(options).search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })
})

describe('BraveSearchProvider error handling', () => {
  it('maps an HTTP error to WEB_PROVIDER_ERROR with the server message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ detail: 'bad key' }, { status: 401 })))
    await expect(new BraveSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'bad key' }))
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway down', { status: 502 })))
    await expect(new BraveSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Brave API error (HTTP 502)' }))
  })

  it('keeps the status-line message when the JSON error body carries no detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })))
    await expect(new BraveSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Brave API error (HTTP 500)' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(new BraveSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(new BraveSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(new BraveSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps a well-formed body of the wrong shape to WEB_PROVIDER_ERROR, not a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ web: { results: {} } }, { status: 200 })))
    await expect(new BraveSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED, not provider error', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(new BraveSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces an abort during error-body parse as WEB_ABORTED', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: false, status: 500 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(new BraveSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

describe('BraveSearchProvider redirect policy', () => {
  it('rejects a redirect before the Location target is contacted', async () => {
    const target = 'https://collector.invalid/leak'
    const fetchMock = vi.fn(async () => new Response(null, { status: 301, headers: { location: target } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(new BraveSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.redirect).toBe('error')
    expect(url).toBe(`${options.baseURL}/res/v1/web/search?q=q&count=10`)
    expect(fetchMock.mock.calls.every(call => (call as unknown as [string])[0] !== target)).toBe(true)
  })
})

describe('web-search-brave plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ web: { results: [] } })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: BRAVE_PROVIDER_ID })
    const fiber = await ctx.plugin(bravePlugin, { apiKey: 'brave-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in bravePlugin).toBe(false)
  })

  it('threads count config into the request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: BRAVE_PROVIDER_ID })
    const fiber = await ctx.plugin(bravePlugin, { apiKey: 'brave-key', count: 9 })
    await ctx.web.search({ query: 'q' })
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toContain('count=9')
    await fiber.dispose()
  })

  it('falls back to $BRAVE_API_KEY and the default base URL when config omits them', async () => {
    const prev = process.env.BRAVE_API_KEY
    process.env.BRAVE_API_KEY = 'env-key'
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ web: { results: [] } }))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: BRAVE_PROVIDER_ID })
      const fiber = await ctx.plugin(bravePlugin, {})
      await ctx.web.search({ query: 'q' })
      const [url] = fetchMock.mock.calls[0] as unknown as [string]
      expect(url).toBe('https://api.search.brave.com/res/v1/web/search?q=q&count=10')
      await fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.BRAVE_API_KEY
      else process.env.BRAVE_API_KEY = prev
    }
  })

  it('is unavailable when neither config nor env supplies a key', async () => {
    const prev = process.env.BRAVE_API_KEY
    delete process.env.BRAVE_API_KEY
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: BRAVE_PROVIDER_ID })
      await ctx.plugin(bravePlugin, {})
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
    } finally {
      if (prev !== undefined) process.env.BRAVE_API_KEY = prev
    }
  })
})
