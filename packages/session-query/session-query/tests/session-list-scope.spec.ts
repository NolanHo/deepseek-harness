/**
 * Session-list scope at the query enumeration: a `listed` request skips rows
 * whose origin is `subagent` before the caller ever sees them (roots and fork
 * children stay), `all` preserves every row, and the scope rides into the
 * persistence listing instead of filtering after every header was read.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionPersistence, {
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
} from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionHandle,
  SessionPersistenceListOptions,
  SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import { TestSessionQueryEngine } from './test-service.ts'

function header(id: string, createdAt: number, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt, isSeeded: false, ...extra }
}

/**
 * Listing double that records the options object of every `list` call, so the
 * spec can prove the scope reached the persistence enumeration rather than
 * being applied after the complete header set was read.
 */
class ScopedPersistence extends SessionPersistence {
  /** Stored headers this double lists, in no promised order. */
  headers: readonly SessionHeader[] = []
  /** Options object of every listing call, in call order. */
  readonly listOptions: Array<object | undefined> = []

  override create(header: SessionHeader): Promise<SessionHandle> {
    return Promise.reject(new Error(`scoped-persistence create is not exercised for "${header.id}"`))
  }

  override flush(): Promise<void> {
    return Promise.resolve()
  }

  override open(id: SessionIdType): Promise<SessionHandle> {
    return Promise.reject(new SessionPersistenceNotFoundError(id))
  }

  override stat(id: SessionIdType): Promise<SessionPersistenceSnapshot | undefined> {
    const found = this.headers.find(header => header.id === id)
    return Promise.resolve(found === undefined ? undefined : {
      header: structuredClone(found),
      revision: SessionPersistenceRevision(`scoped:${id}`),
    })
  }

  override list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    this.listOptions.push(options)
    return Promise.resolve(this.headers.map(header => ({
      header: structuredClone(header),
      revision: SessionPersistenceRevision(`scoped:${header.id}`),
    })))
  }
}

interface ScopeBench {
  readonly ctx: Context
  readonly persistence: ScopedPersistence
}

async function scopeBench(headers: readonly SessionHeader[]): Promise<ScopeBench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TestSessionQueryEngine)
  const persistence = new ScopedPersistence(ctx)
  persistence.headers = headers.map(entry => structuredClone(entry))
  return { ctx, persistence }
}

describe('session-query list scope', () => {
  it('skips subagent rows for a listed enumeration and keeps fork children', async () => {
    const { ctx } = await scopeBench([
      header('scope-root', 400),
      header('scope-fork-child', 300, { parentSession: SessionId('scope-root') }),
      header('scope-subagent-child', 200, { parentSession: SessionId('scope-root'), origin: 'subagent' }),
    ])

    const records = await ctx.sessionQuery.listSessions(
      new AbortController().signal,
      { scope: 'listed' },
    )

    expect(records.map(record => record.header.id)).toEqual(['scope-root', 'scope-fork-child'])
    expect(records.map(record => record.live)).toEqual([false, false])
    expect(records.map(record => record.persisted)).toEqual([true, true])
    expect(records.find(record => record.header.id === 'scope-fork-child')?.header.parentSession)
      .toBe('scope-root')
  })

  it('asks the persistence enumeration for the scope instead of filtering after the read', async () => {
    const { ctx, persistence } = await scopeBench([
      header('scope-root', 400),
      header('scope-subagent-child', 200, { parentSession: SessionId('scope-root'), origin: 'subagent' }),
    ])

    await ctx.sessionQuery.listSessions(new AbortController().signal, { scope: 'listed' })

    expect(persistence.listOptions).toHaveLength(1)
    expect(persistence.listOptions[0]).toMatchObject({ scope: 'listed' })
  })

  it('keeps every row, subagent children included, for an explicit all scope', async () => {
    const { ctx } = await scopeBench([
      header('scope-root', 400),
      header('scope-fork-child', 300, { parentSession: SessionId('scope-root') }),
      header('scope-subagent-child', 200, { parentSession: SessionId('scope-root'), origin: 'subagent' }),
    ])

    const records = await ctx.sessionQuery.listSessions(
      new AbortController().signal,
      { scope: 'all' },
    )

    expect(records.map(record => record.header.id)).toEqual([
      'scope-root',
      'scope-fork-child',
      'scope-subagent-child',
    ])
  })

  it('skips an attached subagent row in the listed enumeration', async () => {
    const { ctx } = await scopeBench([header('scope-root', 400)])
    ctx.sessions.create(SessionId('scope-live-subagent'), {
      meta: {
        createdAt: 250,
        parentSession: SessionId('scope-root'),
        origin: 'subagent',
      },
    })

    const listed = await ctx.sessionQuery.listSessions(
      new AbortController().signal,
      { scope: 'listed' },
    )
    const all = await ctx.sessionQuery.listSessions(
      new AbortController().signal,
      { scope: 'all' },
    )

    expect(listed.map(record => record.header.id)).toEqual(['scope-root'])
    expect(all.map(record => record.header.id)).toEqual(['scope-root', 'scope-live-subagent'])
    expect(all.find(record => record.header.id === 'scope-live-subagent')?.live).toBe(true)
  })

  it('still resolves a subagent child within the complete corpus lineage', async () => {
    const { ctx } = await scopeBench([
      header('scope-root', 400),
      header('scope-subagent-child', 200, {
        parentSession: SessionId('scope-root'),
        origin: 'subagent',
      }),
    ])

    const trace = await ctx.sessionQuery.traceSession(SessionId('scope-subagent-child'))

    expect(trace.ancestors.map(record => record.header.id)).toEqual(['scope-root'])
    expect(trace.complete).toBe(true)
  })
})
