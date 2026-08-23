import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as bochaPlugin from '../src/index.ts'
import { BochaSearchProvider, BOCHA_PROVIDER_ID, mapBochaResponse, mapBochaResult } from '../src/provider.ts'

const options = { apiKey: 'bocha-key', baseURL: 'https://api.bocha.test', freshness: 'noLimit', count: 10 }

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Bocha result mapping', () => {
  it('maps a full result entry, preferring snippet over summary', () => {
    expect(mapBochaResult({
      url: 'https://a.test',
      name: 'A',
      snippet: 'salient sentence',
      summary: 'longer summary',
      dateLastCrawled: '2026-01-01',
    })).toEqual({ url: 'https://a.test', title: 'A', snippet: 'salient sentence', publishedAt: '2026-01-01' })
  })

  it('falls back to summary when snippet is blank or missing', () => {
    expect(mapBochaResult({ url: 'https://a.test', summary: 'sum' }))
      .toEqual({ url: 'https://a.test', snippet: 'sum' })
    expect(mapBochaResult({ url: 'https://a.test', snippet: '  ', summary: 'sum' }))
      .toEqual({ url: 'https://a.test', snippet: 'sum' })
  })

  it('drops a result with no usable snippet or summary', () => {
    expect(mapBochaResult({ url: 'https://a.test' })).toBeUndefined()
    expect(mapBochaResult({ url: 'https://a.test', snippet: '', summary: '' })).toBeUndefined()
    expect(mapBochaResult({ url: 'https://a.test', snippet: '  ' })).toBeUndefined()
  })

  it('drops a result with no URL', () => {
    expect(mapBochaResult({ name: 'A', snippet: 'hi' })).toBeUndefined()
    expect(mapBochaResult({ url: '', name: 'A', snippet: 'hi' })).toBeUndefined()
  })

  it('omits null/empty optional fields rather than emitting them', () => {
    expect(mapBochaResult({ url: 'https://a.test', name: null, dateLastCrawled: null, snippet: 'hi' }))
      .toEqual({ url: 'https://a.test', snippet: 'hi' })
    expect(mapBochaResult({ url: 'https://a.test', name: '', dateLastCrawled: '', snippet: 'hi' }))
      .toEqual({ url: 'https://a.test', snippet: 'hi' })
  })

  it('maps a response to a result with no content and filtered sources', () => {
    const result = mapBochaResponse({
      code: 200,
      data: { webPages: { value: [
        { url: 'https://a.test', snippet: 'one' },
        { url: 'https://b.test' },
        { url: 'https://c.test', name: 'C', summary: 'three' },
      ] } },
    })
    expect(result).toEqual({
      sources: [
        { url: 'https://a.test', snippet: 'one' },
        { url: 'https://c.test', title: 'C', snippet: 'three' },
      ],
      truncated: false,
    })
    expect(result.content).toBeUndefined()
  })

  it('tolerates missing data/webPages/value', () => {
    expect(mapBochaResponse({ code: 200 }).sources).toEqual([])
    expect(mapBochaResponse({ code: 200, data: {} }).sources).toEqual([])
    expect(mapBochaResponse({ code: 200, data: { webPages: {} } }).sources).toEqual([])
  })
})

describe('BochaSearchProvider availability', () => {
  it('is unavailable without a key', () => {
    expect(new BochaSearchProvider({ ...options, apiKey: '' }).available()).toBe(false)
  })

  it('is available with a key', () => {
    expect(new BochaSearchProvider(options).available()).toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(new BochaSearchProvider({ ...options, baseURL: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when count is not a positive integer', () => {
    expect(new BochaSearchProvider({ ...options, count: 0 }).available()).toBe(false)
    expect(new BochaSearchProvider({ ...options, count: 1.5 }).available()).toBe(false)
  })
})

describe('BochaSearchProvider request mapping', () => {
  it('sends query, freshness, summary, count and bearer auth', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ code: 200, data: { webPages: { value: [{ url: 'https://a.test', snippet: 'hi' }] } } }))
    vi.stubGlobal('fetch', fetchMock)

    const provider = new BochaSearchProvider({ ...options, freshness: 'week' })
    await provider.search({ query: 'hello', maxResults: 5 })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.bocha.test/v1/web-search')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer bocha-key')
    expect((init.headers as Record<string, string>)['user-agent']).toBe('deepseek-harness/0.0.1')
    expect(JSON.parse(init.body as string)).toEqual({
      query: 'hello',
      freshness: 'week',
      summary: true,
      count: 5,
    })
  })

  it('falls back to the configured count when a request omits maxResults', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ code: 200, data: { webPages: { value: [] } } }))
    vi.stubGlobal('fetch', fetchMock)
    await new BochaSearchProvider({ ...options, count: 7 }).search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ count: 7 })
  })

  it('lets a request maxResults win over the configured count', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ code: 200, data: { webPages: { value: [] } } }))
    vi.stubGlobal('fetch', fetchMock)
    await new BochaSearchProvider({ ...options, count: 7 }).search({ query: 'q', maxResults: 2 })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ count: 2 })
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ code: 200, data: { webPages: { value: [] } } }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await new BochaSearchProvider(options).search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })
})

describe('BochaSearchProvider error handling', () => {
  it('maps an HTTP error to WEB_PROVIDER_ERROR with the server message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'bad key' }, { status: 401 })))
    await expect(new BochaSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'bad key' }))
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway down', { status: 502 })))
    await expect(new BochaSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Bocha API error (HTTP 502)' }))
  })

  it('keeps the status-line message when the JSON error body carries no message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })))
    await expect(new BochaSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Bocha API error (HTTP 500)' }))
  })

  it('maps an in-band non-200 code to WEB_PROVIDER_ERROR with its msg', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 429, msg: 'rate limited' })))
    await expect(new BochaSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'rate limited' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(new BochaSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(new BochaSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(new BochaSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps a well-formed body of the wrong shape to WEB_PROVIDER_ERROR, not a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 200, data: { webPages: { value: {} } } })))
    await expect(new BochaSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an in-band non-200 code to WEB_PROVIDER_ERROR with the server message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 42, message: 'quota exceeded' })))
    await expect(new BochaSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'quota exceeded' }))
  })

  it('keeps a generic message for an in-band non-200 code without a message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 42 })))
    await expect(new BochaSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Bocha API error (non-200 code)' }))
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED, not provider error', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(new BochaSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces an abort during error-body parse as WEB_ABORTED', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: false, status: 500 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(new BochaSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

describe('BochaSearchProvider redirect policy', () => {
  it('rejects a redirect before the Location target is contacted', async () => {
    const target = 'https://collector.invalid/leak'
    const fetchMock = vi.fn(async () => new Response(null, { status: 301, headers: { location: target } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(new BochaSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.redirect).toBe('error')
    expect(url).toBe(`${options.baseURL}/v1/web-search`)
    expect(fetchMock.mock.calls.every(call => (call as unknown as [string])[0] !== target)).toBe(true)
  })
})

describe('web-search-bocha plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 200, data: { webPages: { value: [] } } })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: BOCHA_PROVIDER_ID })
    const fiber = await ctx.plugin(bochaPlugin, { apiKey: 'bocha-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in bochaPlugin).toBe(false)
  })

  it('threads freshness and count config into the request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ code: 200, data: { webPages: { value: [] } } }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: BOCHA_PROVIDER_ID })
    const fiber = await ctx.plugin(bochaPlugin, { apiKey: 'bocha-key', freshness: 'week', count: 9 })
    await ctx.web.search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ freshness: 'week', count: 9 })
    await fiber.dispose()
  })

  it('falls back to $BOCHA_API_KEY and the default base URL when config omits them', async () => {
    const prev = process.env.BOCHA_API_KEY
    process.env.BOCHA_API_KEY = 'env-key'
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ code: 200, data: { webPages: { value: [] } } }))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: BOCHA_PROVIDER_ID })
      const fiber = await ctx.plugin(bochaPlugin, {})
      await ctx.web.search({ query: 'q' })
      const [url] = fetchMock.mock.calls[0] as unknown as [string]
      expect(url).toBe('https://api.bochaai.com/v1/web-search')
      await fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.BOCHA_API_KEY
      else process.env.BOCHA_API_KEY = prev
    }
  })

  it('is unavailable when neither config nor env supplies a key', async () => {
    const prev = process.env.BOCHA_API_KEY
    delete process.env.BOCHA_API_KEY
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: BOCHA_PROVIDER_ID })
      await ctx.plugin(bochaPlugin, {})
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
    } finally {
      if (prev !== undefined) process.env.BOCHA_API_KEY = prev
    }
  })
})
