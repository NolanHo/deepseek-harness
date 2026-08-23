import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import {
  AcademicSearchProvider,
  ACADEMIC_PROVIDER_ID,
  mapArxivEntry,
  mapS2Paper,
  parseArxivAtom,
} from '../src/provider.ts'
import * as academicPlugin from '../src/index.ts'

const options = {
  arxivBaseURL: 'https://export.arxiv.org/api/query',
  s2BaseURL: 'https://api.semanticscholar.org/graph/v1',
  count: 5,
  minS2IntervalMs: 1500,
}

// The arXiv Atom parsing path is exercised through a factory mock of
// `fast-xml-parser` so unit tests never depend on the parser's exact output
// shape; the real parser runs in the live e2e, and the mapping functions are
// also tested directly against hand-built entries.
const arxivAtom = vi.hoisted(() => ({
  parseResult: undefined as unknown,
  throwError: false,
}))

vi.mock('fast-xml-parser', () => ({
  XMLParser: class {
    parse() {
      if (arxivAtom.throwError) throw new Error('invalid Atom XML')
      return arxivAtom.parseResult
    }
  },
}))

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

beforeEach(() => {
  arxivAtom.parseResult = { feed: { entry: [] } }
  arxivAtom.throwError = false
})

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

describe('arXiv result mapping', () => {
  it('maps a full entry', () => {
    expect(mapArxivEntry({
      id: 'http://arxiv.org/abs/2101.00001v2',
      title: '  Paper Title  ',
      summary: 'Abstract text',
      published: '2026-01-01T00:00:00Z',
    })).toEqual({
      url: 'https://arxiv.org/abs/2101.00001v2',
      title: 'Paper Title',
      snippet: 'Abstract text',
      publishedAt: '2026-01-01T00:00:00Z',
    })
  })

  it('drops an entry with a blank title', () => {
    expect(mapArxivEntry({ title: '' })).toBeUndefined()
    expect(mapArxivEntry({ title: '   ' })).toBeUndefined()
    expect(mapArxivEntry({})).toBeUndefined()
  })

  it('omits publishedAt when published is empty or absent', () => {
    expect(mapArxivEntry({ id: 'x', title: 'T', published: '' })).not.toHaveProperty('publishedAt')
    expect(mapArxivEntry({ id: 'x', title: 'T' })).not.toHaveProperty('publishedAt')
  })

  it('truncates summary to 300 characters', () => {
    expect(mapArxivEntry({ id: 'x', title: 'T', summary: 'y'.repeat(301) })!.snippet).toBe('y'.repeat(300))
  })

  it('normalizes newlines in title and summary', () => {
    const source = mapArxivEntry({ id: 'x', title: 'a\nb', summary: 'c\nd' })!
    expect(source.title).toBe('a b')
    expect(source.snippet).toBe('c d')
  })

  it('derives the URL from the last path segment of id', () => {
    expect(mapArxivEntry({ id: 'http://arxiv.org/abs/2101.00001v2', title: 'T' })!.url).toBe('https://arxiv.org/abs/2101.00001v2')
  })

  it('falls back to an empty id when id is missing', () => {
    expect(mapArxivEntry({ title: 'T' })!.url).toBe('https://arxiv.org/abs/')
  })
})

describe('Semantic Scholar result mapping', () => {
  it('maps a full paper', () => {
    expect(mapS2Paper({
      title: '  S2 Paper  ',
      abstract: 'Abs',
      url: 'https://s2.test/1',
      publicationDate: '2026-05-01',
    })).toEqual({
      url: 'https://s2.test/1',
      title: 'S2 Paper',
      snippet: 'Abs',
      publishedAt: '2026-05-01',
    })
  })

  it('drops a paper with a blank title', () => {
    expect(mapS2Paper({ title: '' })).toBeUndefined()
    expect(mapS2Paper({ title: '  ' })).toBeUndefined()
    expect(mapS2Paper({})).toBeUndefined()
    expect(mapS2Paper({ title: null })).toBeUndefined()
  })

  it('omits publishedAt when publicationDate is empty or null', () => {
    expect(mapS2Paper({ title: 'T', publicationDate: '' })).not.toHaveProperty('publishedAt')
    expect(mapS2Paper({ title: 'T' })).not.toHaveProperty('publishedAt')
    expect(mapS2Paper({ title: 'T', publicationDate: null })).not.toHaveProperty('publishedAt')
  })

  it('truncates abstract to 300 characters and tolerates a missing URL', () => {
    const source = mapS2Paper({ title: 'T', abstract: 'z'.repeat(301) })!
    expect(source.snippet).toBe('z'.repeat(300))
    expect(source.url).toBe('')
  })
})

describe('arXiv Atom parsing', () => {
  it('returns the entries of the parsed feed', () => {
    arxivAtom.parseResult = { feed: { entry: [{ id: 'x', title: 'T' }] } }
    expect(parseArxivAtom('<feed/>')).toEqual([{ id: 'x', title: 'T' }])
  })

  it('normalizes a single entry to an array', () => {
    arxivAtom.parseResult = { feed: { entry: { id: 'x', title: 'T' } } }
    expect(parseArxivAtom('<feed/>')).toEqual([{ id: 'x', title: 'T' }])
  })

  it('returns an empty list when the feed carries no entry', () => {
    arxivAtom.parseResult = { feed: {} }
    expect(parseArxivAtom('<feed/>')).toEqual([])
  })

  it('returns an empty list when the feed is absent', () => {
    arxivAtom.parseResult = {}
    expect(parseArxivAtom('<feed/>')).toEqual([])
  })
})

describe('AcademicSearchProvider availability', () => {
  it('is available with default endpoints and no key', () => {
    expect(new AcademicSearchProvider(options).available()).toBe(true)
  })

  it('is misconfigured when arxivBaseURL is unparseable', () => {
    expect(new AcademicSearchProvider({ ...options, arxivBaseURL: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when s2BaseURL is unparseable', () => {
    expect(new AcademicSearchProvider({ ...options, s2BaseURL: 'nope' }).available()).toBe(false)
  })

  it('is misconfigured when count is not a positive integer', () => {
    expect(new AcademicSearchProvider({ ...options, count: 0 }).available()).toBe(false)
    expect(new AcademicSearchProvider({ ...options, count: 1.5 }).available()).toBe(false)
  })

  it('is misconfigured when minS2IntervalMs is not a positive integer', () => {
    expect(new AcademicSearchProvider({ ...options, minS2IntervalMs: 0 }).available()).toBe(false)
  })
})

describe('AcademicSearchProvider request mapping', () => {
  it('sends arXiv and Semantic Scholar queries without redirect rejection', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await new AcademicSearchProvider(options).search({ query: 'q', maxResults: 1 })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
    const arxivCall = calls.find(([url]) => url.includes('arxiv.org'))!
    const s2Call = calls.find(([url]) => url.includes('semanticscholar'))!

    const arxivUrl = new URL(arxivCall[0])
    expect(arxivUrl.pathname).toBe('/api/query')
    expect(arxivUrl.searchParams.get('search_query')).toBe('all:q')
    expect(arxivUrl.searchParams.get('start')).toBe('0')
    expect(arxivUrl.searchParams.get('max_results')).toBe('5')
    expect(arxivUrl.searchParams.get('sortBy')).toBe('relevance')
    expect(arxivUrl.searchParams.get('sortOrder')).toBe('descending')

    const s2Url = new URL(s2Call[0])
    expect(s2Url.pathname).toBe('/graph/v1/paper/search')
    expect(s2Url.searchParams.get('query')).toBe('q')
    expect(s2Url.searchParams.get('limit')).toBe('5')
    expect(s2Url.searchParams.get('fields')).toBe('title,abstract,url,publicationDate')

    expect(arxivCall[1].redirect).toBeUndefined()
    expect(s2Call[1].redirect).toBeUndefined()
    expect((s2Call[1].headers as Record<string, string>)['user-agent']).toBe('deepseek-harness/0.0.1')
  })

  it('merges Semantic Scholar first and arXiv second, leaving truncation to the seam', async () => {
    arxivAtom.parseResult = {
      feed: {
        entry: [
          { id: 'http://arxiv.org/abs/1', title: 'Arxiv', summary: 's', published: '2026-01-01T00:00:00Z' },
          { id: 'http://arxiv.org/abs/2', title: 'Arxiv2', summary: 's2' },
        ],
      },
    }
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('semanticscholar')) {
        return jsonResponse({ data: [{ title: 'S2', url: 'https://s2.test/1', abstract: 'a', publicationDate: '2026-01-01' }] })
      }
      return new Response('<feed/>', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await new AcademicSearchProvider(options).search({ query: 'q', maxResults: 2 })

    expect(result.sources.map(source => source.title)).toEqual(['S2', 'Arxiv', 'Arxiv2'])
    expect(result.truncated).toBe(false)
  })

  it('returns the full merge when maxResults is absent', async () => {
    arxivAtom.parseResult = { feed: { entry: [{ id: '1', title: 'A' }, { id: '2', title: 'B' }] } }
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('semanticscholar')) return jsonResponse({ data: [{ title: 'S1' }, { title: 'S2' }] })
      return new Response('<feed/>', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await new AcademicSearchProvider(options).search({ query: 'q' })
    expect(result.sources).toHaveLength(4)
  })

  it('forwards the abort signal to both backends', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await new AcademicSearchProvider(options).search({ query: 'q', maxResults: 1 }, controller.signal)
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
    expect(calls[0]![1].signal).toBe(controller.signal)
    expect(calls[1]![1].signal).toBe(controller.signal)
  })
})

describe('AcademicSearchProvider throttle', () => {
  it('sleeps the difference before a second Semantic Scholar request', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const s2Calls: string[] = []
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('semanticscholar')) {
        s2Calls.push(url)
        return jsonResponse({ data: [] })
      }
      return new Response('<feed/>', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = new AcademicSearchProvider(options)
    await provider.search({ query: 'q' })
    expect(s2Calls).toHaveLength(1)

    const second = provider.search({ query: 'q' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(s2Calls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(500)
    await second
    expect(s2Calls).toHaveLength(2)
  })
})

describe('AcademicSearchProvider error handling', () => {
  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(new AcademicSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(new AcademicSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('degrades to arXiv results when Semantic Scholar fails with a non-2xx status', async () => {
    arxivAtom.parseResult = { feed: { entry: [{ id: 'http://arxiv.org/abs/1', title: 'Arxiv', summary: 's' }] } }
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('semanticscholar')) return new Response('', { status: 500 })
      return new Response('<feed/>', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await new AcademicSearchProvider(options).search({ query: 'q' })
    expect(result.sources.map(source => source.title)).toEqual(['Arxiv'])
  })

  it('degrades to arXiv results when Semantic Scholar returns a non-JSON body', async () => {
    arxivAtom.parseResult = { feed: { entry: [{ id: 'http://arxiv.org/abs/1', title: 'Arxiv', summary: 's' }] } }
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('semanticscholar')) return new Response('not json', { status: 200 })
      return new Response('<feed/>', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await new AcademicSearchProvider(options).search({ query: 'q' })
    expect(result.sources.map(source => source.title)).toEqual(['Arxiv'])
  })

  it('degrades to Semantic Scholar results when the arXiv feed is unparseable', async () => {
    arxivAtom.throwError = true
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('semanticscholar')) return jsonResponse({ data: [{ title: 'S2', url: 'https://s2.test/1' }] })
      return new Response('<feed/>', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await new AcademicSearchProvider(options).search({ query: 'q' })
    expect(result.sources.map(source => source.title)).toEqual(['S2'])
  })

  it('throws WEB_PROVIDER_ERROR only when both backends fail', async () => {
    arxivAtom.throwError = true
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('semanticscholar')) return new Response('', { status: 500 })
      return new Response('<feed/>', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const bothFailed = await captureError(new AcademicSearchProvider(options).search({ query: 'q' }))
    expect(bothFailed).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('surfaces WEB_ABORTED even when the other backend succeeds', async () => {
    arxivAtom.parseResult = { feed: { entry: [{ id: 'http://arxiv.org/abs/1', title: 'Arxiv', summary: 's' }] } }
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('semanticscholar')) return Promise.reject(new DOMException('aborted', 'AbortError'))
      return new Response('<feed/>', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const aborted = await captureError(new AcademicSearchProvider(options).search({ query: 'q' }))
    expect(aborted).toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('treats a Semantic Scholar response without data as an empty list', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('semanticscholar')) return jsonResponse({})
      return new Response('<feed/>', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await new AcademicSearchProvider(options).search({ query: 'q' })
    expect(result.sources).toEqual([])
  })

  it('surfaces an abort during Semantic Scholar body parse as WEB_ABORTED', async () => {
    const s2Body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('semanticscholar')) return s2Body as unknown as Response
      return new Response('<feed/>', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(new AcademicSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces an abort during arXiv body read as WEB_ABORTED', async () => {
    const arxivBody = { text: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('semanticscholar')) return jsonResponse({ data: [] })
      return arxivBody as unknown as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(new AcademicSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('degrades to Semantic Scholar results when the arXiv body read fails', async () => {
    const arxivBody = { text: () => Promise.reject(new TypeError('read failed')), ok: true, status: 200 }
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('semanticscholar')) return jsonResponse({ data: [{ title: 'S2', url: 'https://s2.test/1' }] })
      return arxivBody as unknown as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await new AcademicSearchProvider(options).search({ query: 'q' })
    expect(result.sources.map(source => source.title)).toEqual(['S2'])
  })
})

describe('web-search-academic plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('semanticscholar')) return jsonResponse({ data: [] })
      return new Response('<feed/>', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: ACADEMIC_PROVIDER_ID })
    const fiber = await ctx.plugin(academicPlugin, {})
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in academicPlugin).toBe(false)
  })

  it('is available with no key through the default config', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('semanticscholar')) return jsonResponse({ data: [] })
      return new Response('<feed/>', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: ACADEMIC_PROVIDER_ID })
    const fiber = await ctx.plugin(academicPlugin, {})
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [] })
    await fiber.dispose()
  })

  it('threads count and baseURL config into the requests', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('s2.test')) return jsonResponse({ data: [] })
      return new Response('<feed/>', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: ACADEMIC_PROVIDER_ID })
    const fiber = await ctx.plugin(academicPlugin, {
      count: 9,
      arxivBaseURL: 'https://arxiv.test/api/query',
      s2BaseURL: 'https://s2.test/graph/v1',
    })
    await ctx.web.search({ query: 'q', maxResults: 9 })
    const calls = fetchMock.mock.calls as unknown as [string][]
    const arxivUrl = new URL(calls.find(([url]) => url.includes('arxiv.test'))![0])
    expect(arxivUrl.searchParams.get('max_results')).toBe('9')
    const s2Url = new URL(calls.find(([url]) => url.includes('s2.test'))![0])
    expect(s2Url.searchParams.get('limit')).toBe('9')
    await fiber.dispose()
  })
})
