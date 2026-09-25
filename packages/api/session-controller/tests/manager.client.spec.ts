/**
 * SessionManager orchestration: lazy resident instances, list lifecycle, host
 * frame routing, and control baselines for uninstantiated sessions.
 */

import { describe, expect, onTestFinished, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { ok, type RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import {
  createClientTest, type ClientTestFixtures, webApp,
} from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type {} from '@deepseek-ai/dsh-session-title/client'
import { SessionManager } from '../src/client/sessions/manager.ts'
import type { SessionRemotes } from '../src/client/sessions/remotes.ts'
import { entries, plainTurn } from './event-script.client.ts'
import { FOLLOW, err, followScript, history, sessionWorld } from './remote/session.client.ts'

const S1 = 'fk-m1' as SessionId
const S2 = 'fk-m2' as SessionId
/** Gateway Client cone used by the subagent-catalog and connected-generation cases. */
const API_ROSTER = webApp.closure(['@deepseek-ai/dsh-api-gateway'])
const it = createClientTest({ roster: API_ROSTER })

type SummaryOver = Partial<{
  updatedAt: number
  running: boolean
  agentAvailable: boolean
  blank: boolean
  cwd: string
  parentSessionId: SessionId
  origin: 'subagent'
}>

function summary(sessionId: SessionId, over: SummaryOver = {}) {
  return { agentAvailable: true, sessionId, updatedAt: 100, running: false, blank: false, ...over }
}

function makeManager(
  mock: RemoteMock,
  remote: ClientTestFixtures['remote'],
): SessionManager {
  mock.load(sessionWorld)
  // Cases using this helper never open a Session, so they do not need the broader Client Remote's $stream member.
  return new SessionManager(remote as unknown as SessionRemotes)
}

describe('SessionManager instances', () => {
  it.for(['event', 'list'] as const)(
    'forgets running when an unretained identity disappears through a %s',
    async (source, { mock, remote }) => {
      const manager = makeManager(mock, remote)
      onTestFinished(() => manager.dispose())
      remote.session.list.mockResolvedValueOnce(ok({ items: [summary(S1, { blank: true })] }))
      await manager.refreshList()
      manager.handleSessionStatus(S1, true)
      manager.handleSessionStatus(S1, false)
      expect(manager.getListSnapshot().items[0]?.blank).toBe(false)

      if (source === 'event') manager.handleSessionRemoved(S1)
      else {
        remote.session.list.mockResolvedValueOnce(ok({ items: [] }))
        await manager.refreshList()
      }
      expect(manager.getListSnapshot().items).toEqual([])
      manager.handleSessionAdded(summary(S1, { blank: true }))

      expect(manager.getListSnapshot().items[0]?.blank).toBe(true)
    },
  )

  it('retains acceptance while an unlisted Session remains resident, then forgets it on drop', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    manager.handleSessionAdded(summary(S1, { blank: true }))
    const session = manager.get(S1)
    await session.prompt([{ type: 'text', text: 'first' }], 'queue')
    remote.session.list.mockResolvedValue(ok({ items: [] }))

    await manager.refreshList()
    expect(manager.getListSnapshot().items).toEqual([])
    expect(session.getSnapshot().blank).toBe(false)
    manager.handleSessionAdded(summary(S1, { blank: true }))
    expect(manager.getListSnapshot().items[0]?.blank).toBe(false)

    await manager.refreshList()
    await manager.drop(S1, session)
    manager.handleSessionAdded(summary(S1, { blank: true }))
    expect(manager.getListSnapshot().items[0]?.blank).toBe(true)
  })

  it('retains running for an unlisted child with only a retained address', async ({ mock, remote }) => {
    const address: SubagentAddress = { parentSessionId: S1, childSessionId: S2, mode: 'continuable' }
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    manager.resolveTarget(address)
    manager.handleSessionAdded(summary(S2, { blank: true }))
    manager.handleSessionStatus(S2, true)
    manager.handleSessionStatus(S2, false)
    remote.session.list.mockResolvedValueOnce(ok({ items: [] }))

    await manager.refreshList()
    expect(manager.getListSnapshot().items).toEqual([])
    manager.handleSessionAdded(summary(S2, { blank: true }))

    expect(manager.getListSnapshot().items[0]?.blank).toBe(false)
  })

  it('retains running for a row added during a pull whose baseline omits it', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    manager.handleSessionAdded(summary(S1, { blank: true }))
    manager.handleSessionStatus(S1, true)
    manager.handleSessionStatus(S1, false)
    const response = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.list>>>()
    remote.session.list.mockReturnValueOnce(response.promise)
    const refreshing = manager.refreshList()
    manager.handleSessionAdded(summary(S1, { blank: true }))
    response.resolve(ok({ items: [] }))

    await refreshing

    expect(manager.getListSnapshot().items[0]?.blank).toBe(false)
  })

  it.for(['result', 'transport'] as const)(
    'retains running observed before listing when the pull fails through %s',
    async (source, { mock, remote }) => {
      const manager = makeManager(mock, remote)
      onTestFinished(() => manager.dispose())
      manager.handleSessionStatus(S1, true)
      manager.handleSessionStatus(S1, false)
      const error = new RemoteError('gateway/internal', 'list unavailable', {})
      if (source === 'result') remote.session.list.mockResolvedValueOnce(err(error))
      else remote.session.list.mockRejectedValueOnce(error)

      await manager.refreshList()
      expect(manager.getListSnapshot().state).toBe('error')
      manager.handleSessionAdded(summary(S1, { blank: true }))

      expect(manager.getListSnapshot().items[0]?.blank).toBe(false)
    },
  )

  it('accepts a later blank baseline without an acceptance or running observation', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    manager.handleSessionAdded(summary(S1, { blank: false }))
    const session = manager.get(S1)
    expect(session.getSnapshot().blank).toBe(false)
    remote.session.list.mockResolvedValueOnce(ok({ items: [summary(S1, { blank: true })] }))

    await manager.refreshList()

    expect(manager.getListSnapshot().items[0]?.blank).toBe(true)
    expect(session.getSnapshot().blank).toBe(true)
  })

  it('retains acceptance received before the first list response', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    const response = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.list>>>()
    remote.session.list.mockReturnValueOnce(response.promise)
    const refreshing = manager.refreshList()
    const session = manager.get(S1)
    await session.prompt([{ type: 'text', text: 'first' }], 'queue')
    expect(manager.getListSnapshot().items).toEqual([])
    response.resolve(ok({ items: [summary(S1, { blank: true })] }))

    await refreshing

    expect(manager.getListSnapshot().items[0]?.blank).toBe(false)
    expect(session.getSnapshot().blank).toBe(false)
  })

  it('keeps a rejected first prompt blank across refresh and object replacement', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    manager.handleSessionAdded(summary(S1, { blank: true }))
    remote.session.prompt.mockResolvedValueOnce(err(new RemoteError('session/agent-busy', 'busy', { reason: 'x' })))
    const session = manager.get(S1)
    expect((await session.prompt([{ type: 'text', text: 'first' }], 'queue')).ok).toBe(false)
    remote.session.list.mockResolvedValueOnce(ok({ items: [summary(S1, { blank: true })] }))
    await manager.refreshList()
    await manager.drop(S1, session)

    expect(manager.getListSnapshot().items[0]?.blank).toBe(true)
    expect(manager.get(S1).getSnapshot().blank).toBe(true)
  })

  it('ignores running from a list response that predates removal, including after re-addition', async ({ mock, remote }) => {
    for (const readdBeforeResponse of [false, true]) {
      const manager = makeManager(mock, remote)
      onTestFinished(() => manager.dispose())
      manager.handleSessionAdded(summary(S1, { blank: true }))
      const response = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.list>>>()
      remote.session.list.mockReturnValueOnce(response.promise)
      const refreshing = manager.refreshList()
      manager.handleSessionRemoved(S1)
      if (readdBeforeResponse) manager.handleSessionAdded(summary(S1, { blank: true }))

      response.resolve(ok({ items: [summary(S1, { blank: true, running: true })] }))
      await refreshing
      if (!readdBeforeResponse) {
        expect(manager.getListSnapshot().items).toEqual([])
        manager.handleSessionAdded(summary(S1, { blank: true }))
      }

      expect(manager.getListSnapshot().items[0]).toMatchObject({ blank: true, running: false })
    }
  })

  it('retains running observations after re-addition while an older list response is pending', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    manager.handleSessionAdded(summary(S1, { blank: true }))
    const response = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.list>>>()
    remote.session.list.mockReturnValue(response.promise)
    const refreshing = manager.refreshList()
    manager.handleSessionRemoved(S1)
    manager.handleSessionAdded(summary(S1, { blank: true }))
    manager.handleSessionStatus(S1, true)
    manager.handleSessionStatus(S1, false)

    response.resolve(ok({ items: [summary(S1, { blank: true })] }))
    await refreshing

    expect(manager.getListSnapshot().items[0]).toMatchObject({ blank: false, running: false })
  })

  it('applies late acceptance to a re-added list row without materializing its Session', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    manager.handleSessionAdded(summary(S1, { blank: true }))
    const acceptance = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.prompt>>>()
    remote.session.prompt.mockReturnValue(acceptance.promise)
    const session = manager.get(S1)
    const sending = session.prompt([{ type: 'text', text: 'first' }], 'queue')
    manager.handleSessionRemoved(S1)
    await manager.drop(S1, session)
    manager.handleSessionAdded(summary(S1, { blank: true }))
    const getSession = vi.spyOn(manager, 'get')
    onTestFinished(() => { getSession.mockRestore() })
    acceptance.resolve(ok({ accepted: true }))
    await sending
    expect(manager.getListSnapshot().items[0]?.blank).toBe(false)
    expect(getSession).not.toHaveBeenCalled()
  })

  it('publishes a late acceptance to the replacement Session with the same id', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    manager.handleSessionAdded(summary(S1, { blank: true }))
    const acceptance = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.prompt>>>()
    remote.session.prompt.mockReturnValue(acceptance.promise)
    const session = manager.get(S1)
    const sending = session.prompt([{ type: 'text', text: 'first' }], 'queue')
    await manager.drop(S1, session)
    const replacement = manager.get(S1)
    expect(manager.getListSnapshot().items[0]?.blank).toBe(true)
    expect(replacement.getSnapshot().blank).toBe(true)
    acceptance.resolve(ok({ accepted: true }))
    await sending

    expect(manager.getListSnapshot().items[0]?.blank).toBe(false)
    expect(replacement.getSnapshot().blank).toBe(false)
    await manager.drop(S1, session)
    expect(manager.get(S1)).toBe(replacement)
  })

  it('keeps accepted presentation when its Session is rebuilt', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    manager.handleSessionAdded(summary(S1, { blank: true }))
    const session = manager.get(S1)
    await session.prompt([{ type: 'text', text: 'first' }], 'queue')
    await manager.drop(S1, session)

    expect(manager.getListSnapshot().items[0]?.blank).toBe(false)
    expect(manager.get(S1).getSnapshot().blank).toBe(false)
  })

  it('publishes acceptance from a nonblank sender after its list row is replaced', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    manager.handleSessionAdded(summary(S1, { blank: true }))
    const sender = manager.get(S1)
    await sender.prompt([{ type: 'text', text: 'first' }], 'queue')
    const acceptance = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.prompt>>>()
    remote.session.prompt.mockReturnValueOnce(acceptance.promise)
    const sending = sender.prompt([{ type: 'text', text: 'next' }], 'queue')
    manager.handleSessionRemoved(S1)
    await manager.drop(S1, sender)
    manager.handleSessionAdded(summary(S1, { blank: true }))
    const replacement = manager.get(S1)
    expect(manager.getListSnapshot().items[0]?.blank).toBe(true)
    expect(replacement.getSnapshot().blank).toBe(true)

    acceptance.resolve(ok({ accepted: true }))
    await sending

    expect(manager.getListSnapshot().items[0]?.blank).toBe(false)
    expect(replacement.getSnapshot().blank).toBe(false)
  })

  it('keeps observed running presentation across idle empty-history summaries', async ({ mock, remote }) => {
    for (const source of ['addition', 'refresh'] as const) {
      const manager = makeManager(mock, remote)
      onTestFinished(() => manager.dispose())
      manager.handleSessionAdded(summary(S1, { blank: true }))
      const session = manager.get(S1)
      manager.handleSessionStatus(S1, true)
      manager.handleSessionStatus(S1, false)
      expect(session.getSnapshot().blank).toBe(false)

      if (source === 'addition') manager.handleSessionAdded(summary(S1, { blank: true }))
      else {
        remote.session.list.mockResolvedValueOnce(ok({ items: [summary(S1, { blank: true })] }))
        await manager.refreshList()
      }

      expect(manager.getListSnapshot().items[0]?.blank).toBe(false)
      expect(session.getSnapshot().blank).toBe(false)
    }
  })

  it('does not restore a removed row or publish after disposal when acceptance arrives late', async ({ mock, remote }) => {
    for (const dispose of [false, true]) {
      const manager = makeManager(mock, remote)
      onTestFinished(() => manager.dispose())
      manager.handleSessionAdded(summary(S1, { blank: true }))
      const acceptance = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.prompt>>>()
      remote.session.prompt.mockReturnValue(acceptance.promise)
      const session = manager.get(S1)
      const sending = session.prompt([{ type: 'text', text: 'first' }], 'queue')
      manager.handleSessionRemoved(S1)
      if (dispose) await manager.dispose()
      else await manager.drop(S1, session)
      const notify = vi.fn()
      const unsubscribe = manager.subscribe(notify)
      onTestFinished(unsubscribe)
      acceptance.resolve(ok({ accepted: true }))
      await sending
      expect(manager.getListSnapshot().items).toEqual([])
      expect(notify).not.toHaveBeenCalled()
    }
  })

  it('keeps accepted presentation across a later list refresh without a turn', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    remote.session.list.mockResolvedValue(ok({ items: [summary(S1, { blank: true })] as never[] }))
    await manager.refreshList()
    await manager.get(S1).prompt([{ type: 'text', text: 'first' }], 'queue')
    expect(manager.getListSnapshot().items[0]?.blank).toBe(false)

    await manager.refreshList()
    expect(manager.getListSnapshot().items[0]?.blank).toBe(false)
  })

  it('lazily builds one resident instance per id and syncs the running bit from the list', async ({ mock, remote }) => {
    remote.session.list.mockResolvedValue(ok({ items: [summary(S1, { running: true })] as never[] }))
    const manager = makeManager(mock, remote)
    await manager.refreshList()
    const session = manager.get(S1)
    expect(manager.get(S1)).toBe(session) // resident: same instance forever
    expect(session.getSnapshot().running).toBe(true) // list preceded instantiation
  })

  it('initializes blankness from metadata published before the Session and list exist', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    const published = Promise.withResolvers<undefined>()
    const stopObserving = manager.subscribe(() => { published.resolve(undefined) })
    try {
      manager.handleControlFrame({ type: 'projection', sessionId: S1,
        key: 'sessionListMetadata', value: { blank: false, lastPromptAt: 1200 }, seq: 8 })
      manager.handleControlFrame({ type: 'projection', sessionId: S2,
        key: 'sessionListMetadata', value: { blank: true, lastPromptAt: null }, seq: 2 })
      // The initial notification must finish while neither Session is resident.
      await published.promise

      expect(manager.getListSnapshot().items).toEqual([])
      expect(manager.get(S1).getSnapshot()).toMatchObject({ blank: false, running: false })
      expect(manager.get(S2).getSnapshot()).toMatchObject({ blank: true, running: false })
      expect(manager.get('fk-unobserved' as SessionId).getSnapshot().blank).toBe(true)
    } finally {
      stopObserving()
      await manager.dispose()
    }
  })

})

describe('SessionManager query lifetime', () => {
  it.for(['list', 'projection'] as const)('forwards an unexpected %s failure and still completes teardown', async (target, { mock, remote }) => {
    const manager = makeManager(mock, remote)
    const failure = new Error('query implementation failed')
    if (target === 'list') remote.session.list.mockRejectedValueOnce(failure)
    else remote.session.projections.mockRejectedValueOnce(failure)
    try {
      await expect(target === 'list' ? manager.refreshList() : manager.refreshProjections(S1)).rejects.toBe(failure)
    } finally {
      await manager.dispose()
    }
  })

  it('keeps a rejected Remote list failure in the observable state', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    const failure = new RemoteError('gateway/internal', 'list unavailable', {})
    remote.session.list.mockRejectedValueOnce(failure)
    try {
      await manager.refreshList()
      expect(manager.getListSnapshot()).toMatchObject({ state: 'error', error: failure })
    } finally {
      await manager.dispose()
    }
  })

  it.for([false, true])('preserves a rejected Remote projection failure with prior values %s', async (warm, { mock, remote }) => {
    const manager = makeManager(mock, remote)
    const failure = new RemoteError('gateway/internal', 'projection unavailable', {})
    const entries = [{ id: S2, createdAt: 1, mode: 'one-shot' as const }]
    try {
      if (warm) {
        manager.handleControlFrame({ type: 'projection', sessionId: S1, key: 'subagentCatalog', seq: 0, value: entries })
      }
      remote.session.projections.mockRejectedValueOnce(failure)
      await manager.refreshProjections(S1)
      expect(manager.getListSnapshot().projectionsBySession[S1]).toMatchObject({
        state: 'error', error: failure, values: warm ? { subagentCatalog: entries } : {},
      })
    } finally {
      await manager.dispose()
    }
  })

})

describe('list lifecycle', () => {
  it('uses metadata received before the list without reblanking started rows', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    try {
      manager.handleControlFrame({ type: 'projection', sessionId: S1,
        key: 'sessionListMetadata', value: { blank: false, lastPromptAt: 1200 }, seq: 8 })
      manager.handleControlFrame({ type: 'projection', sessionId: S2,
        key: 'sessionListMetadata', value: { blank: true, lastPromptAt: null }, seq: 2 })
      remote.session.list.mockResolvedValue(ok({ items: [
        summary(S1, { blank: true }), summary(S2),
      ] as never[] }))
      await manager.refreshList()
      expect(manager.getListSnapshot().items.map(item => item.blank)).toEqual([false, false])
      expect(manager.get(S1).getSnapshot().blank).toBe(false)
      expect(manager.get(S2).getSnapshot().blank).toBe(false)
      manager.handleControlFrame({ type: 'projection', sessionId: S1,
        key: 'sessionListMetadata', value: { blank: true, lastPromptAt: null }, seq: 7 })
      expect(manager.getListSnapshot().items[0]).toMatchObject({ blank: false, updatedAt: 1200 })
    } finally {
      await manager.dispose()
    }
  })

  it('fills missing durable links without overwriting established rows and projects first-send engagement', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    remote.session.list.mockResolvedValueOnce(ok({ items: [
      summary(S1, { blank: true }), summary(S2, { cwd: '/existing', blank: true }),
    ] }))
    try {
      await manager.refreshList()
      manager.handleSessionAdded(summary(S1, { cwd: '/filled', parentSessionId: S2, origin: 'subagent', blank: false }))
      manager.handleSessionAdded(summary(S2, { cwd: '/ignored', blank: true }))
      manager.handleSessionActivity(S1, 50)
      manager.handleSessionActivity(S2, 200)
      await manager.get(S2).prompt([{ type: 'text', text: 'first message' }], 'queue')
      expect(manager.getListSnapshot().items).toEqual(expect.arrayContaining([
        expect.objectContaining({ sessionId: S1, cwd: '/filled', parentSessionId: S2, origin: 'subagent', blank: false }),
        expect.objectContaining({ sessionId: S2, cwd: '/existing', updatedAt: 200, blank: false }),
      ]))
    } finally {
      await manager.dispose()
    }
  })

  it('keeps an opened conversation out of blank-session reuse after a stale list refresh', async ({ mock, remote }) => {
    const stale = {
      ...summary(S1, { blank: true, cwd: '/workspace' }),
      projections: { kind: 'cached' as const, asOfSeq: 2, values: {
        sessionListMetadata: { blank: true, lastPromptAt: null },
      } },
    }
    remote.session.list.mockResolvedValue(ok({ items: [stale] as never[] }))
    const manager = makeManager(mock, remote)
    try {
      await manager.refreshList()
      const session = manager.get(S1)
      expect(session.getSnapshot().blank).toBe(true)

      // History opening can be newer than the metadata-only list cache.
      session.projections.seed({ asOfSeq: SessionSeq(61), values: {
        sessionListMetadata: { blank: false, lastPromptAt: 1200 },
      } })
      await vi.waitFor(() => {
        expect(manager.getListSnapshot().items[0]).toMatchObject({ blank: false, updatedAt: 1200 })
        expect(session.getSnapshot().blank).toBe(false)
      })

      await manager.refreshList()
      expect(manager.getListSnapshot().items[0]).toMatchObject({ blank: false, updatedAt: 1200 })
      expect(session.getSnapshot().blank).toBe(false)
      manager.handleSessionAdded(stale)
      expect(session.getSnapshot().blank).toBe(false)
    } finally {
      await manager.dispose()
    }
  })

  it('projects a cold Session addition as cached until an empty-cut control baseline replaces it', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    try {
      manager.handleSessionAdded({
        ...summary(S1), projections: { kind: 'cached', asOfSeq: -1, values: { title: 'before history' } },
      })
      expect(manager.getListSnapshot().items[0]?.title).toBe('before history')
      // The control baseline is the connected Session's own value: it replaces
      // the list-surface title even at the same cursor.
      manager.handleControlFrame({
        type: 'baseline', value: { projections: { [S1]: { asOfSeq: -1, values: { title: 'cold baseline' } } } },
      })
      expect(manager.getListSnapshot().items[0]?.title).toBe('cold baseline')
    } finally {
      await manager.dispose()
    }
  })

  it('single-flights refreshList and preserves the Host baseline order', async ({ mock, remote }) => {
    const gate = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.list>>>()
    remote.session.list.mockReturnValue(gate.promise)
    const manager = makeManager(mock, remote)
    const first = manager.refreshList()
    const second = manager.refreshList()
    expect(manager.getListSnapshot().state).toBe('loading')
    gate.resolve(ok({ items: [summary(S2, { updatedAt: 200 }), summary(S1)] as never[] }))
    await Promise.all([first, second])
    expect(remote.session.list).toHaveBeenCalledOnce()
    const snapshot = manager.getListSnapshot()
    expect(snapshot.state).toBe('idle')
    expect(snapshot.items.map(i => i.sessionId)).toEqual([S2, S1])
  })

  it('replays incremental frames over hydration and never batch-reorders established ids', async ({ mock, remote }) => {
    const first = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.list>>>()
    remote.session.list.mockReturnValue(first.promise)
    const manager = makeManager(mock, remote)
    const hydration = manager.refreshList()
    manager.handleSessionAdded(summary(S2, { blank: true }))
    first.resolve(ok({ items: [summary(S1)] as never[] }))
    await hydration
    expect(manager.getListSnapshot().items.map(item => item.sessionId)).toEqual([S2, S1])

    remote.session.list.mockResolvedValue(ok({
      items: [summary(S1, { updatedAt: 900 }), summary(S2, { updatedAt: 800 })] as never[],
    }))
    await manager.refreshList()
    expect(manager.getListSnapshot().items.map(item => item.sessionId)).toEqual([S2, S1])
  })

  it('advances list activity from the filtered Host notification', async ({ mock, remote }) => {
    remote.session.list.mockResolvedValue(ok({ items: [summary(S1)] as never[] }))
    const manager = makeManager(mock, remote)
    await manager.refreshList()

    manager.handleSessionActivity(S1, 500)
    expect(manager.getListSnapshot().items[0]?.updatedAt).toBe(500)
  })

  it('skips the list rebuild when a status frame carries no change', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    manager.handleSessionAdded(summary(S1))
    await Promise.resolve()
    manager.subscribe(() => {})
    const rebuild = vi.spyOn(manager as unknown as { buildListSnapshot: () => unknown }, 'buildListSnapshot')
    // The no-op status frame flips nothing: the summaries array keeps its
    // identity, so the dirty flush has no rebuild to run.
    manager.handleSessionStatus(S1, false)
    await Promise.resolve()
    expect(rebuild).not.toHaveBeenCalled()
    // A real change still rebuilds and notifies.
    manager.handleSessionStatus(S1, true)
    await Promise.resolve()
    expect(rebuild).toHaveBeenCalled()
  })

  it('skips the list rebuild when an activity frame carries no newer timestamp', async ({ mock, remote }) => {
    vi.useFakeTimers()
    try {
      const manager = makeManager(mock, remote)
      onTestFinished(() => manager.dispose())
      manager.handleSessionAdded(summary(S1))
      await Promise.resolve()
      manager.subscribe(() => {})
      manager.handleSessionActivity(S1, 500)
      await Promise.resolve()
      const rebuild = vi.spyOn(manager as unknown as { buildListSnapshot: () => unknown }, 'buildListSnapshot')
      // Same timestamp again: the buffered flush must not rebuild the list.
      manager.handleSessionActivity(S1, 500)
      await vi.advanceTimersByTimeAsync(1_000)
      await Promise.resolve()
      expect(rebuild).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips the list rebuild and the notification when a control frame republishes the value', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    manager.handleSessionAdded(summary(S1))
    await Promise.resolve()
    manager.handleControlFrame({ type: 'projection', sessionId: S1, key: 'title', value: 'Stable', seq: 1 })
    await Promise.resolve()
    manager.subscribe(() => {})
    const rebuild = vi.spyOn(manager as unknown as { buildListSnapshot: () => unknown }, 'buildListSnapshot')
    const notified = vi.fn()
    onTestFinished(manager.subscribe(notified))
    // The same value at a higher watermark changes nothing the list publishes.
    manager.handleControlFrame({ type: 'projection', sessionId: S1, key: 'title', value: 'Stable', seq: 2 })
    await Promise.resolve()
    expect(rebuild).not.toHaveBeenCalled()
    expect(notified).not.toHaveBeenCalled()
    expect(manager.getListSnapshot().items[0]?.title).toBe('Stable')
    // A genuinely changed value still rebuilds and notifies.
    manager.handleControlFrame({ type: 'projection', sessionId: S1, key: 'title', value: 'Moved', seq: 3 })
    await Promise.resolve()
    expect(rebuild).toHaveBeenCalled()
    expect(notified).toHaveBeenCalled()
    expect(manager.getListSnapshot().items[0]?.title).toBe('Moved')
  })

  it('coalesces repeated equal control frames inside one window into at most one rebuild', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    manager.handleSessionAdded(summary(S1))
    await Promise.resolve()
    manager.subscribe(() => {})
    manager.handleControlFrame({ type: 'projection', sessionId: S1, key: 'title', value: 'Stable', seq: 1 })
    await Promise.resolve()
    const rebuild = vi.spyOn(manager as unknown as { buildListSnapshot: () => unknown }, 'buildListSnapshot')
    // One window's worth of stream: every frame carries a higher watermark over
    // the same value, each flushed on its own microtask.
    for (let seq = 2; seq <= 12; seq++) {
      manager.handleControlFrame({ type: 'projection', sessionId: S1, key: 'title', value: 'Stable', seq })
      await Promise.resolve()
    }
    expect(rebuild.mock.calls.length).toBeLessThanOrEqual(1)
    const rebuilds = rebuild.mock.calls.length
    // A changed value still rebuilds once, not once per frame of the window.
    manager.handleControlFrame({ type: 'projection', sessionId: S1, key: 'title', value: 'Moved', seq: 13 })
    await Promise.resolve()
    expect(rebuild.mock.calls.length).toBe(rebuilds + 1)
  })

  it('skips the list rebuild for a projection key no list consumer reads', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    manager.handleSessionAdded(summary(S1))
    await Promise.resolve()
    // Subscribe, consume the rebuild already pending, and only then measure: the
    // notifier leaves `dirty` set while it has no listener.
    manager.subscribe(() => {})
    manager.getListSnapshot()
    await Promise.resolve()
    const rebuild = vi.spyOn(manager as unknown as { buildListSnapshot: () => unknown }, 'buildListSnapshot')
    const notified = vi.fn()
    onTestFinished(manager.subscribe(notified))
    const published = manager.getListSnapshot()

    // Every frame carries a value the store does not hold yet: these are changes,
    // not republished frames. The three keys are the ones whose only readers bind
    // them per session (`useProjection`), never out of a list row
    // (fork/coalesced-refresh.ts holds the set and its evidence).
    manager.handleControlFrame({ type: 'projection', sessionId: S1, key: 'sessionStats', seq: 1, value: { turns: 3 } })
    await Promise.resolve()
    manager.handleControlFrame({ type: 'projection', sessionId: S1, key: 'contextPressure', seq: 2, value: { pressureTokens: 10 } })
    manager.handleControlFrame({ type: 'projection', sessionId: S1, key: 'contextBreakdown', seq: 3, value: { conversation: 5 } })
    await Promise.resolve()

    expect(rebuild).not.toHaveBeenCalled()
    expect(notified).not.toHaveBeenCalled()
    expect(manager.getListSnapshot()).toBe(published)

    // A changed value of an exempt key (a second `sessionStats` carrying a
    // different object) is still exempt: the gate is per key, not per frame.
    manager.handleControlFrame({ type: 'projection', sessionId: S1, key: 'sessionStats', seq: 4, value: { turns: 9 } })
    await Promise.resolve()
    expect(rebuild).not.toHaveBeenCalled()
    expect(manager.getListSnapshot()).toBe(published)
    // The value landed all the same: the session-scoped per-key face is what reads it.
    expect(manager.projectionValues(S1)).toMatchObject({ sessionStats: { turns: 9 } })
  })

  it('rebuilds the list for every projection key a list consumer reads', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    manager.handleSessionAdded(summary(S1))
    await Promise.resolve()
    manager.subscribe(() => {})
    manager.getListSnapshot()
    await Promise.resolve()
    const rebuild = vi.spyOn(manager as unknown as { buildListSnapshot: () => unknown }, 'buildListSnapshot')
    const published = manager.getListSnapshot()

    // A subagent catalog row shows the child's tokens and timing
    // (ui-subagent's catalogs read `byId[child].projectionValues`), so a
    // frequent `tokenUsage` frame still republishes the list.
    manager.handleControlFrame({ type: 'projection', sessionId: S1, key: 'tokenUsage', seq: 1, value: { outputTokens: 2 } })
    await Promise.resolve()
    expect(rebuild).toHaveBeenCalledTimes(1)
    expect(manager.getListSnapshot()).not.toBe(published)

    manager.handleControlFrame({ type: 'projection', sessionId: S1, key: 'title', seq: 2, value: 'Titled' })
    await Promise.resolve()
    expect(rebuild).toHaveBeenCalledTimes(2)
    expect(manager.getListSnapshot().items[0]?.title).toBe('Titled')

    // Catalog membership: the same read service.projectList consumes.
    manager.handleControlFrame({ type: 'projection', sessionId: S1, key: 'subagentCatalog', seq: 3, value: [] })
    await Promise.resolve()
    expect(rebuild).toHaveBeenCalledTimes(3)
  })

  it('coalesces ambient activity flushes within a one-second window', async ({ mock, remote }) => {
    vi.useFakeTimers()
    try {
      const manager = makeManager(mock, remote)
      onTestFinished(() => manager.dispose())
      manager.handleSessionAdded(summary(S1, { updatedAt: 0 }))
      await Promise.resolve()
      manager.subscribe(() => {})
      const rebuild = vi.spyOn(manager as unknown as { buildListSnapshot: () => unknown }, 'buildListSnapshot')
      // First activity of a window applies immediately.
      manager.handleSessionActivity(S1, 100)
      await Promise.resolve()
      expect(rebuild).toHaveBeenCalledTimes(1)
      // A second stamp 600ms later is still inside the window: it stays buffered.
      await vi.advanceTimersByTimeAsync(600)
      manager.handleSessionActivity(S1, 200)
      await Promise.resolve()
      expect(rebuild).toHaveBeenCalledTimes(1)
      // The window ends 1s after the FIRST stamp, not the last: one flush
      // carries the pair, pinning the trailing-window anchor.
      await vi.advanceTimersByTimeAsync(500)
      await Promise.resolve()
      expect(rebuild).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })


  it('keeps the error in the list snapshot on failure', async ({ mock, remote }) => {
    remote.session.list.mockResolvedValue(err(new RemoteError('gateway/internal', 'boom', {})))
    const manager = makeManager(mock, remote)
    await manager.refreshList()
    expect(manager.getListSnapshot()).toMatchObject({ state: 'error', error: { code: 'gateway/internal' } })
    // A failed pull does not step the arrival phase: still pending.
    expect(manager.getListSnapshot().phase).toBe('pending')
  })

  it('phase steps pending → ready on the first successful pull and never returns', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    expect(manager.getListSnapshot().phase).toBe('pending')
    await manager.refreshList()
    expect(manager.getListSnapshot().phase).toBe('ready')
    // Sticky across later failures: the pull-activity axis reports the error,
    // the arrival phase holds.
    remote.session.list.mockResolvedValue(err(new RemoteError('gateway/internal', 'down', {})))
    await manager.refreshList()
    expect(manager.getListSnapshot()).toMatchObject({ state: 'error', phase: 'ready' })
    // And across an empty re-pull (empty-with-ready = truly no sessions).
    remote.session.list.mockResolvedValue(ok({ items: [] as never[] }))
    await manager.refreshList()
    expect(manager.getListSnapshot()).toMatchObject({ state: 'idle', phase: 'ready' })
    expect(manager.getListSnapshot().items).toEqual([])
  })

  it('merges create into the list immediately without waiting for a refresh', async ({ mock, remote }) => {
    remote.session.create.mockResolvedValue(ok({ sessionId: S2 }))
    const manager = makeManager(mock, remote)
    const result = await manager.create()
    expect(result).toMatchObject({ ok: true, value: { sessionId: S2 } })
    expect(manager.getListSnapshot().items.map(i => i.sessionId)).toEqual([S2])
  })

  it('retains title projections before list arrival, keeps last-wins by seq, and clears them on removal', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    const titleFrame = (title: string, seq: number) => {
      manager.handleControlFrame({ type: 'projection', sessionId: S1, key: 'title', value: title, seq })
    }
    titleFrame('Newest', 4)
    titleFrame('Stale', 3)
    titleFrame('Equal', 4)
    remote.session.list.mockResolvedValue(ok({
      items: [summary(S1), summary(S2, { updatedAt: 200 })] as never[],
    }))
    await manager.refreshList()

    const titled = manager.getListSnapshot()
    expect(titled.items.map(item => item.sessionId)).toEqual([S1, S2])
    expect(titled.items[0]?.title).toBe('Newest')
    expect(titled.items[1]?.title).toBeUndefined()

    manager.handleSessionRemoved(S1)
    manager.handleSessionAdded(summary(S1, { blank: true }))
    expect(manager.getListSnapshot().items.find(item => item.sessionId === S1)?.title).toBeUndefined()
  })

  it('fills cold titles from the list rows\' projections block as cached values', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    // A push frame landed before the list: S2's title is a sequenced value.
    manager.handleControlFrame({
      type: 'projection', sessionId: S2, key: 'title', value: 'Pushed', seq: 9,
    })
    remote.session.list.mockResolvedValue(ok({
      items: [
        { ...summary(S1), projections: { kind: 'cached', asOfSeq: 4, values: { title: 'Cold cached' } } },
        { ...summary(S2, { updatedAt: 200 }), projections: { kind: 'cached', asOfSeq: 50, values: { title: 'List stale' } } },
      ] as never[],
    }))
    await manager.refreshList()
    const items = manager.getListSnapshot().items
    // Cold row: title surfaces straight from the list block — no open, no history.
    expect(items.find(item => item.sessionId === S1)?.title).toBe('Cold cached')
    // A cached list block never displaces a sequenced value, whatever watermark its record holds.
    expect(items.find(item => item.sessionId === S2)?.title).toBe('Pushed')
  })

  it('discards the previous generation title before accepting its lower-seq replay', async ({ mock, remote }) => {
    remote.session.list.mockResolvedValue(ok({ items: [summary(S1)] as never[] }))
    const manager = makeManager(mock, remote)
    try {
      await manager.refreshList()
      manager.handleControlFrame({ type: 'projection', sessionId: S1, key: 'title', value: 'Unflushed', seq: 4 })

      manager.handleConnected()
      await manager.refreshList()
      expect(manager.getListSnapshot().items[0]?.title).toBeUndefined()
      manager.handleControlFrame({
        type: 'baseline',
        value: {
          projections: { [S1]: { asOfSeq: 2, values: { title: 'Durable' } } },
        },
      })
      expect(manager.getListSnapshot().items[0]?.title).toBe('Durable')
    } finally {
      await manager.dispose()
    }
  })
})

describe('search', () => {
  it('returns bounded Host results and forwards the caller signal', async ({ mock, remote }) => {
    remote.session.search.mockResolvedValue(ok({
      items: [{ sessionId: S1, snippet: 'matching excerpt' }],
      hasMore: true,
    }))
    const manager = makeManager(mock, remote)
    const signal = new AbortController().signal

    await expect(manager.search('exact phrase', signal)).resolves.toEqual({
      ok: true,
      value: {
        items: [{ sessionId: S1, snippet: 'matching excerpt' }],
        hasMore: true,
      },
    })
    expect(remote.session.search).toHaveBeenCalledExactlyOnceWith({ query: 'exact phrase' }, signal)
  })

  it('preserves business errors and propagates a non-Remote throw', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    remote.session.search.mockResolvedValue(err(new RemoteError('gateway/internal', 'index unavailable', {})))
    const signal = new AbortController().signal
    await expect(manager.search('first', signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'gateway/internal', message: 'index unavailable' },
    })

    remote.session.search.mockRejectedValue(new Error('wire down'))
    await expect(manager.search('second', signal)).rejects.toThrow('wire down')
  })
})

describe('Host Remote event routing', () => {
  it('adds/removes/flips sessions and keeps removed instances resident', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    manager.handleSessionAdded(summary(S1, { blank: true }))
    manager.handleSessionAdded(summary(S1, { blank: true })) // dup: ignored
    expect(manager.getListSnapshot().items).toHaveLength(1)

    const session = manager.get(S1)
    manager.handleSessionStatus(S1, true)
    expect(session.getSnapshot().running).toBe(true)
    expect(manager.getListSnapshot().items[0]?.running).toBe(true)

    manager.handleSessionError(S1, '炸了')
    expect(session.getSnapshot().lastAgentError).toBe('炸了')

    manager.handleSessionRemoved(S1)
    expect(manager.getListSnapshot().items).toHaveLength(0)
    expect(session.getSnapshot().removed).toBe(true)
    expect(manager.get(S1)).toBe(session) // resident-instance rule survives removal
  })
})

describe('subagent catalogs', () => {
  it('keeps a catalog-discovered child address across identity resolution and status frames', async ({ mock, remote, start }) => {
    remote.session.list.mockImplementation(() => Promise.resolve(ok({ items: [
      summary(S1),
      summary(S2, { parentSessionId: S1, origin: 'subagent' }),
    ] as never[] })))
    remote.session.projections.mockImplementation(() => Promise.resolve(ok({ asOfSeq: 0, values: { subagentCatalog: [{ createdAt: 1,
      id: S2, mode: 'continuable', label: 'worker',
    }] } })))
    mock.load(sessionWorld)
    const client = await start()
    const manager = new SessionManager(client.ctx.remote)
    await manager.refreshList()
    await manager.refreshProjections(S1)
    manager.resolveTarget({ parentSessionId: S1, childSessionId: S2, mode: 'continuable' })

    expect(manager.subagentAddress(S2)).toEqual({
      parentSessionId: S1, childSessionId: S2, mode: 'continuable',
    })
    expect(manager.get(S2).getSnapshot().subagent).toEqual({
      address: {
        parentSessionId: S1, childSessionId: S2, mode: 'continuable',
      },
      parentAvailable: true,
    })
    // Clicking the same child through an ordinary list-selection path must not
    // erase the catalog-derived address and fall back to session.* transport.
    manager.resolveTarget(S2)
    expect(manager.subagentAddress(S2)).toEqual({
      parentSessionId: S1, childSessionId: S2, mode: 'continuable',
    })
    expect(manager.get(S2).getSnapshot().subagent).toEqual({
      address: {
        parentSessionId: S1, childSessionId: S2, mode: 'continuable',
      },
      parentAvailable: true,
    })
    await manager.get(S2).open()
    await manager.get(S2).prompt([{ type: 'text', text: 'continue' }], 'queue')
    expect(mock.log.requests(FOLLOW)).toEqual([
      {
        address: {
          kind: 'subagent',
          parentSessionId: S1,
          childSessionId: S2,
          mode: 'continuable',
        },
        assistantStream: true,
        maxMessages: 500,
        turnWindow: { minMessages: 8, minTurns: 2 },
      },
    ])
    expect(mock.log.requests('session/page')).toEqual([])
    expect(remote.subagents.prompt.mock.calls.map(([request]) => request)).toEqual([
      {
        requestId: expect.any(String) as unknown as string,
        parentSessionId: S1, childSessionId: S2,
        mode: 'continuable',
        delivery: 'queue',
        content: [{ type: 'text', text: 'continue' }],
        clientTimeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    ])
    expect(mock.log.requests('session/page')).toEqual([])
    expect(remote.session.prompt.mock.calls.map(([request]) => request)).toEqual([])
    const listCalls = remote.session.projections.mock.calls.map(([request]) => request).length
    manager.handleSessionStatus(S2, false)
    expect(manager.getListSnapshot().projectionsBySession[S1]?.values.subagentCatalog?.[0]).toMatchObject({
      id: S2,
    })
    expect(remote.session.projections.mock.calls.map(([request]) => request)).toHaveLength(listCalls)

    manager.handleSessionRemoved(S2)
    expect(manager.getListSnapshot().items.find(item => item.sessionId === S2)).toMatchObject({
      origin: 'subagent', parentSessionId: S1, running: false,
    })
    expect(manager.get(S2).getSnapshot()).toMatchObject({
      removed: false,
      subagent: {
        address: {
          parentSessionId: S1, childSessionId: S2, mode: 'continuable',
        },
      },
    })
  })

  it('resolves an unknown browsing mode from the child projection without changing parent membership', async ({ mock, start }) => {
    mock.load(sessionWorld)
    const client = await start()
    const manager = new SessionManager(client.ctx.remote)
    const entries = [{ id: S2, createdAt: 1, mode: 'unknown' as const }]
    manager.handleControlFrame({ type: 'projection', sessionId: S1, key: 'subagentCatalog', seq: 0, value: entries })
    const address = manager.subagentAddress(S2)!
    expect(address).toEqual({ parentSessionId: S1, childSessionId: S2, mode: 'unknown' })
    manager.resolveTarget(address)
    const child = manager.get(S2)
    expect(child.getSnapshot().subagent?.address.mode).toBe('unknown')
    manager.handleControlFrame({ type: 'projection', sessionId: S2, key: 'subagent', seq: 0,
      value: { seq: SessionSeq(0), mode: 'continuable', label: 'repaired child' } })
    await child.open()
    expect(child.getSnapshot().subagent?.address).toEqual({ ...address, mode: 'continuable' })
    expect(manager.getListSnapshot().projectionsBySession[S1]?.values.subagentCatalog).toEqual(entries)
    await manager.dispose()
  })

  it('publishes pushed membership without a catalog request or an instantiated parent', ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    manager.handleSessionAdded(summary(S2, { origin: 'subagent', parentSessionId: S1, running: true }))
    manager.handleControlFrame({
      type: 'projection', sessionId: S1, key: 'subagentCatalog', seq: 4,
      value: [{ id: S2, createdAt: 1, mode: 'continuable', label: 'worker' }],
    })
    expect(manager.getListSnapshot().projectionsBySession[S1]?.values.subagentCatalog).toEqual([
      { id: S2, createdAt: 1, mode: 'continuable', label: 'worker' },
    ])
    expect(manager.subagentAddress(S2)).toEqual({ parentSessionId: S1, childSessionId: S2, mode: 'continuable' })
    expect(remote.session.projections.mock.calls.map(([request]) => request)).toEqual([])
  })

  it('keeps newer pushed membership when the initial read returns an older baseline', async ({ mock, remote }) => {
    const response = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.projections>>>()
    remote.session.projections.mockImplementation(() => response.promise)
    const manager = makeManager(mock, remote)
    const read = manager.refreshProjections(S1)
    manager.handleControlFrame({
      type: 'projection', sessionId: S1, key: 'subagentCatalog', seq: 5,
      value: [{ id: S2, createdAt: 1, mode: 'continuable', label: 'pushed' }],
    })
    response.resolve(ok({ asOfSeq: 3, values: { subagentCatalog: [] } }))
    await read
    expect(manager.getListSnapshot().projectionsBySession[S1]?.values.subagentCatalog?.[0]?.label).toBe('pushed')
    expect(remote.session.projections.mock.calls.map(([request]) => request)).toHaveLength(1)
  })

  it.for([false, true])('keeps live parent availability when an earlier initial read settles (failure: %s)', async (failure, { mock, remote }) => {
    const response = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.projections>>>()
    remote.session.projections.mockImplementation(() => response.promise)
    const manager = makeManager(mock, remote)
    manager.resolveTarget({ parentSessionId: S1, childSessionId: S2, mode: 'continuable' })
    const child = manager.get(S2)
    const read = manager.refreshProjections(S1)
    manager.handleSessionAdded(summary(S1))
    manager.handleSessionStatus(S1, false)
    response.resolve(failure
      ? err(new RemoteError('gateway/internal', 'offline', {}))
      : ok({ asOfSeq: 0, values: { subagentCatalog: [] } }))
    await read
    expect(child.getSnapshot().subagent?.parentAvailable).toBe(true)
    expect(remote.session.projections.mock.calls.map(([request]) => request)).toHaveLength(1)
  })

  it('keeps parent availability unknown after list failure and accepts a later Host summary', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    manager.resolveTarget({ parentSessionId: S1, childSessionId: S2, mode: 'continuable' })
    const child = manager.get(S2)
    remote.session.list.mockResolvedValue(err(new RemoteError('gateway/internal', 'offline', {})))
    await manager.refreshList()
    expect(manager.getListSnapshot().state).toBe('error')
    expect(child.getSnapshot().subagent?.parentAvailable).toBeUndefined()
    manager.handleSessionAdded(summary(S1))
    expect(child.getSnapshot().subagent?.parentAvailable).toBe(true)
    await manager.dispose()
  })

  it('keeps a pushed catalog when an earlier initial read reports the parent missing', async ({ mock, remote }) => {
    const response = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.projections>>>()
    remote.session.projections.mockImplementation(() => response.promise)
    const manager = makeManager(mock, remote)
    const read = manager.refreshProjections(S1)
    manager.handleControlFrame({ type: 'projection', sessionId: S1, key: 'subagentCatalog', seq: 1,
      value: [{ id: S2, createdAt: 1, mode: 'one-shot' }] })
    response.resolve(ok(null))
    await read
    expect(manager.getListSnapshot().projectionsBySession[S1]?.values.subagentCatalog).toEqual([
      { id: S2, createdAt: 1, mode: 'one-shot' },
    ])
  })

  it('keeps a pushed value when a frame republishes it during a missing projections read', async ({ mock, remote }) => {
    const response = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.projections>>>()
    remote.session.projections.mockImplementation(() => response.promise)
    const manager = makeManager(mock, remote)
    manager.handleControlFrame({ type: 'projection', sessionId: S1, key: 'title', value: 'Pushed', seq: 2 })
    const read = manager.refreshProjections(S1)
    // The same value at a higher watermark lands in flight: the published
    // values keep their identity, so only the advanced watermark records it.
    manager.handleControlFrame({ type: 'projection', sessionId: S1, key: 'title', value: 'Pushed', seq: 5 })
    response.resolve(ok(null))
    await read
    expect(manager.getListSnapshot().projectionsBySession[S1]?.values.title).toBe('Pushed')
  })

  it('shares cold initial loading and reuses the loaded catalog when reopened', async ({ mock, remote }) => {
    const response = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.projections>>>()
    remote.session.projections.mockImplementation(() => response.promise)
    const manager = makeManager(mock, remote)
    const read = manager.refreshProjections(S1)
    expect(manager.refreshProjections(S1)).toBe(read)
    expect(manager.getListSnapshot().projectionsBySession[S1]?.state).toBe('loading')
    response.resolve(ok({ asOfSeq: 0, values: {
      subagentCatalog: [{ id: S2, createdAt: 1, mode: 'one-shot' }],
      title: 'cold parent',
    } }))
    await read
    await manager.refreshProjections(S1)
    manager.handleSessionAdded(summary(S1))
    expect(manager.getListSnapshot().items[0]?.title).toBe('cold parent')
    expect(manager.getListSnapshot().projectionsBySession[S1]).toMatchObject({
      values: { subagentCatalog: [{ id: S2, createdAt: 1, mode: 'one-shot' }] }, state: 'ready',
    })
    expect(remote.session.projections.mock.calls.map(([request]) => request)).toHaveLength(1)
  })

  it('uses current Session status rather than the time an initial catalog read started', async ({ mock, remote }) => {
    const response = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.projections>>>()
    remote.session.projections.mockImplementation(() => response.promise)
    const manager = makeManager(mock, remote)
    const read = manager.refreshProjections(S1)
    manager.handleSessionAdded(summary(S2, { origin: 'subagent', parentSessionId: S1 }))
    manager.handleSessionStatus(S2, true)
    response.resolve(ok({ asOfSeq: 0, values: {
      subagentCatalog: [{ id: S2, createdAt: 1, mode: 'continuable', label: 'worker' }],
    } }))
    await read
    expect(manager.getListSnapshot().items.find(item => item.sessionId === S2)?.running).toBe(true)
    manager.handleSessionStatus(S2, false)
    expect(manager.getListSnapshot().items.find(item => item.sessionId === S2)?.running).toBe(false)
    expect(remote.session.projections.mock.calls.map(([request]) => request)).toHaveLength(1)
  })

  it('keeps completed unselected child metadata with its durable catalog row', ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    manager.handleSessionAdded(summary(S2, { origin: 'subagent', parentSessionId: S1, running: true }))
    manager.handleControlFrame({ type: 'projection', sessionId: S2, key: 'title', value: 'finished child', seq: 2 })
    manager.handleControlFrame({ type: 'projection', sessionId: S1, key: 'subagentCatalog', seq: 1,
      value: [{ id: S2, createdAt: 1, mode: 'one-shot' }] })
    manager.handleSessionRemoved(S2)
    expect(manager.getListSnapshot().items[0]).toMatchObject({ title: 'finished child', running: false })
    expect(manager.getListSnapshot().items.find(item => item.sessionId === S2)?.running).toBe(false)
  })

  it('does not invent membership from Session summaries', ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    manager.handleSessionAdded(summary(S2, { origin: 'subagent', parentSessionId: S1 }))
    expect(manager.getListSnapshot().projectionsBySession[S1]).toBeUndefined()
  })

  it('retries a failed initial read without discarding pushed entries', async ({ mock, remote }) => {
    remote.session.projections.mockImplementation(() => Promise.resolve(err(new RemoteError('gateway/internal', 'offline', {}))))
    const manager = makeManager(mock, remote)
    manager.handleControlFrame({ type: 'projection', sessionId: S1, key: 'subagentCatalog', seq: 2,
      value: [{ id: S2, createdAt: 1, mode: 'one-shot' }] })
    await manager.refreshProjections(S1)
    expect(manager.getListSnapshot().projectionsBySession[S1]).toMatchObject({ state: 'error', values: { subagentCatalog: [{ id: S2 }] } })
    remote.session.projections.mockImplementation(() => Promise.resolve(ok({ asOfSeq: 2, values: { subagentCatalog: [] } })))
    await manager.refreshProjections(S1)
    expect(manager.getListSnapshot().projectionsBySession[S1]).toMatchObject({ state: 'ready', values: { subagentCatalog: [{ id: S2 }] } })
  })

  it('ignores a late response after parent removal without a trailing request', async ({ mock, remote }) => {
    const response = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.projections>>>()
    remote.session.projections.mockImplementation(() => response.promise)
    const manager = makeManager(mock, remote)
    const read = manager.refreshProjections(S1)
    manager.handleSessionRemoved(S1)
    response.resolve(ok({ asOfSeq: 0, values: { subagentCatalog: [] } }))
    await read
    expect(manager.getListSnapshot().items.some(item => item.sessionId === S1)).toBe(false)
    expect(remote.session.projections.mock.calls.map(([request]) => request)).toHaveLength(1)
  })

  it('represents a missing parent as an empty unavailable catalog', async ({ mock, remote }) => {
    remote.session.projections.mockImplementation(() => Promise.resolve(ok(null)))
    const manager = makeManager(mock, remote)
    await manager.refreshProjections(S1)
    expect(manager.getListSnapshot().projectionsBySession[S1]).toEqual({
      values: {}, state: 'ready', error: null,
    })
  })
})

describe('scoped children', () => {
  /** Answer the listed pull and one parent's child read differently. */
  function listByScope(
    remote: ClientTestFixtures['remote'],
    listed: readonly ReturnType<typeof summary>[],
    children: Readonly<Record<string, readonly ReturnType<typeof summary>[]>>,
  ): void {
    remote.session.list.mockImplementation((payload) => {
      const { parentSessionId } = payload as { parentSessionId?: SessionId }
      return Promise.resolve(ok({
        items: [...(parentSessionId === undefined ? listed : children[parentSessionId] ?? [])] as never[],
      }))
    })
  }

  it('pulls the listed scope and keeps a read child across later pulls and a removal frame', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    const child = summary(S2, { parentSessionId: S1, origin: 'subagent', running: true })
    listByScope(remote, [summary(S1)], { [S1]: [child] })
    await manager.refreshList()
    expect(remote.session.list).toHaveBeenCalledExactlyOnceWith({ scope: 'listed' })

    await manager.loadChildren(S1)
    expect(manager.getListSnapshot().items.find(item => item.sessionId === S2)).toMatchObject({
      parentSessionId: S1, origin: 'subagent', running: true,
    })
    // The listed pull omits subagent rows: the read row must survive it with
    // the values later frames applied.
    manager.handleSessionStatus(S2, false)
    await manager.refreshList()
    expect(manager.getListSnapshot().items.find(item => item.sessionId === S2)).toMatchObject({
      parentSessionId: S1, origin: 'subagent', running: false,
    })

    manager.handleSessionRemoved(S2)
    expect(manager.getListSnapshot().items.find(item => item.sessionId === S2)).toMatchObject({
      parentSessionId: S1, origin: 'subagent', running: false,
    })
  })

  it('reads an addressed child parent\'s children so the opened row reaches the list', async ({ mock, remote }) => {
    const address: SubagentAddress = { parentSessionId: S1, childSessionId: S2, mode: 'continuable' }
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    listByScope(remote, [], { [S1]: [summary(S2, { parentSessionId: S1, origin: 'subagent' })] })
    manager.resolveTarget(address)

    await manager.loadChildren(S2)
    expect(manager.getListSnapshot().items.find(item => item.sessionId === S2)).toMatchObject({
      parentSessionId: S1, origin: 'subagent',
    })
    // Both reads are memoized: a second open repeats neither request.
    await manager.loadChildren(S2)
    expect(remote.session.list.mock.calls.map(([request]) => request)).toEqual([
      { parentSessionId: S2 },
      { parentSessionId: S1 },
    ])
  })

  it('keeps a failed child read from failing the catalog and retries it', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    remote.session.list.mockResolvedValue(err(new RemoteError('gateway/internal', 'children unavailable', {})))
    await expect(manager.loadChildren(S1)).resolves.toBeUndefined()
    expect(manager.getListSnapshot().items).toEqual([])
    listByScope(remote, [], { [S1]: [summary(S2, { parentSessionId: S1, origin: 'subagent' })] })
    await manager.loadChildren(S1)
    expect(manager.getListSnapshot().items.find(item => item.sessionId === S2)).toBeDefined()
  })

  it('keeps a mutation applied while the listed pull is in flight', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    const child = summary(S2, { parentSessionId: S1, origin: 'subagent', running: true, updatedAt: 100 })
    listByScope(remote, [summary(S1)], { [S1]: [child] })
    await manager.refreshList()
    await manager.loadChildren(S1)

    const response = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.list>>>()
    remote.session.list.mockImplementationOnce(() => response.promise)
    const refreshing = manager.refreshList()
    // Both land while the response is outstanding: the retained row must keep
    // them instead of reverting to the pre-pull snapshot.
    manager.handleSessionStatus(S2, false)
    manager.handleSessionActivity(S2, 200)
    response.resolve(ok({ items: [summary(S1)] }))
    await refreshing

    expect(manager.getListSnapshot().items.find(item => item.sessionId === S2)).toMatchObject({
      parentSessionId: S1, origin: 'subagent', running: false, updatedAt: 200,
    })
  })

  it('merges one children read in a single pass instead of one pass per child', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    // The largest catalog measured on the deployment: 2,244 direct children.
    const size = 2_244
    const children = Array.from({ length: size }, (_, index) => summary(
      `fk-child-${String(index)}` as SessionId,
      { parentSessionId: S1, origin: 'subagent' },
    ))
    listByScope(remote, [summary(S1)], { [S1]: children })
    const merge = vi.spyOn(manager as unknown as { mergeChildren: (rows: readonly unknown[]) => void }, 'mergeChildren')

    await manager.loadChildren(S1)

    // One merge for the whole response.
    expect(merge).toHaveBeenCalledTimes(1)
    expect(merge.mock.calls[0]?.[0]).toHaveLength(size)
    // All rows landed, each retained as a child of the parent. New rows lead in
    // reverse arrival order, which is where the per-child prepend put them.
    const items = manager.getListSnapshot().items
    expect(items).toHaveLength(size)
    expect(items.slice(0, 2).map(item => item.sessionId)).toEqual([
      `fk-child-${String(size - 1)}`, `fk-child-${String(size - 2)}`,
    ])
    expect(items[0]).toMatchObject({ parentSessionId: S1, origin: 'subagent' })
    // The retention bookkeeping ran for the batch too: a later pull that omits
    // subagent rows must not read as their removal.
    listByScope(remote, [summary(S1)], {})
    await manager.refreshList()
    expect(manager.getListSnapshot().items.filter(item => item.origin === 'subagent')).toHaveLength(size)
  })

  it('keeps an unchanged child row by identity and merges a changed one in place', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    const running = summary(S2, { parentSessionId: S1, origin: 'subagent', running: true })
    const unchanged = summary('fk-m3' as SessionId, { parentSessionId: S1, origin: 'subagent' })
    manager.handleSessionAdded(summary(S1))
    manager.handleSessionAdded(running)
    manager.handleSessionAdded(unchanged)
    await Promise.resolve()
    const unchangedRow = manager.getListSnapshot().items.find(item => item.sessionId === 'fk-m3' as SessionId)

    listByScope(remote, [], {
      [S1]: [
        summary(S2, { parentSessionId: S1, origin: 'subagent', running: false }),
        unchanged,
        summary('fk-m4' as SessionId, { parentSessionId: S1, origin: 'subagent' }),
      ],
    })
    await manager.loadChildren(S1)

    const after = manager.getListSnapshot().items
    // Upsert semantics survive the batch: the changed row's live state moves…
    expect(after.find(item => item.sessionId === S2)).toMatchObject({ running: false, origin: 'subagent' })
    // …an untouched row keeps the object the store already published…
    expect(after.find(item => item.sessionId === 'fk-m3' as SessionId)).toBe(unchangedRow)
    // …and the batch's new member arrives under the same parent.
    expect(after.find(item => item.sessionId === 'fk-m4' as SessionId)).toMatchObject({
      parentSessionId: S1, origin: 'subagent', depth: 1,
    })
  })

  it('replays a batched children read over a listed pull already in flight', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    const response = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.list>>>()
    const child = summary(S2, { parentSessionId: S1, origin: 'subagent', running: true })
    remote.session.list.mockImplementation((payload) => {
      const { parentSessionId } = payload as { parentSessionId?: SessionId }
      return parentSessionId === undefined
        ? response.promise
        : Promise.resolve(ok({ items: [child] as never[] }))
    })
    const refreshing = manager.refreshList()
    await manager.loadChildren(S1)
    // The pull's baseline omits subagent rows: the replayed batch must carry them.
    response.resolve(ok({ items: [summary(S1)] as never[] }))
    await refreshing

    expect(manager.getListSnapshot().items.find(item => item.sessionId === S2)).toMatchObject({
      parentSessionId: S1, origin: 'subagent', running: true,
    })
  })

  it('walks the addressed ancestor chain so a depth-3 breadcrumb keeps its rows', async ({ mock, remote }) => {
    const S3 = 'fk-m3' as SessionId
    const middle: SubagentAddress = { parentSessionId: S1, childSessionId: S2, mode: 'continuable' }
    const opened: SubagentAddress = { parentSessionId: S2, childSessionId: S3, mode: 'continuable' }
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    listByScope(remote, [summary(S1)], {
      [S1]: [summary(S2, { parentSessionId: S1, origin: 'subagent' })],
      [S2]: [summary(S3, { parentSessionId: S2, origin: 'subagent' })],
    })
    await manager.refreshList()
    manager.resolveTarget(middle)
    manager.resolveTarget(opened)

    await manager.loadChildren(S3)
    expect(manager.getListSnapshot().items.map(item => [item.sessionId, item.depth])).toEqual([
      [S1, 0], [S2, 1], [S3, 2],
    ])
    // One read per ancestor: the opened Session, its parent, its grandparent.
    expect(remote.session.list.mock.calls.map(([request]) => request)).toEqual([
      { scope: 'listed' },
      { parentSessionId: S3 },
      { parentSessionId: S2 },
      { parentSessionId: S1 },
    ])
    // Memoized: re-opening repeats none of the ancestor reads.
    await manager.loadChildren(S3)
    expect(remote.session.list.mock.calls).toHaveLength(4)
  })

  it('bounds the ancestry walk at the read limit and warns past it', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => { warn.mockRestore() })
    remote.session.list.mockResolvedValue(ok({ items: [] }))
    let parent = 'fk-m1' as SessionId
    let child = parent
    for (let index = 0; index < 11; index++) {
      child = `fk-m${String(index + 2)}` as SessionId
      manager.resolveTarget({ parentSessionId: parent, childSessionId: child, mode: 'continuable' })
      parent = child
    }

    await manager.loadChildren(child)
    // The opened Session's own children read plus the eight-ancestor limit.
    expect(remote.session.list.mock.calls).toHaveLength(9)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('forgets a retained child a fresh generation no longer lists', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    listByScope(remote, [summary(S1)], {
      [S1]: [summary(S2, { parentSessionId: S1, origin: 'subagent' })],
    })
    await manager.refreshList()
    await manager.loadChildren(S1)
    expect(manager.getListSnapshot().items.find(item => item.sessionId === S2)).toBeDefined()

    // The child is gone from the Host (deleted out of band). The next
    // generation's children read is the only witness, so retention must not
    // survive it.
    listByScope(remote, [summary(S1)], {})
    manager.handleConnected()
    await vi.waitFor(() => {
      expect(manager.getListSnapshot().items.some(item => item.sessionId === S2)).toBe(false)
    })

    // A later pull that omits the row cannot re-establish retention either.
    await manager.refreshList()
    expect(manager.getListSnapshot().items.some(item => item.sessionId === S2)).toBe(false)
  })

  it('re-reads known parents on reconnect so a child that finished offline stops running', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    listByScope(remote, [summary(S1)], {
      [S1]: [summary(S2, { parentSessionId: S1, origin: 'subagent', running: true })],
    })
    await manager.refreshList()
    await manager.loadChildren(S1)
    expect(manager.getListSnapshot().items.find(item => item.sessionId === S2)?.running).toBe(true)

    // The completion frame was lost with the connection; only the fresh read
    // carries the corrected running bit.
    listByScope(remote, [summary(S1)], {
      [S1]: [summary(S2, { parentSessionId: S1, origin: 'subagent', running: false })],
    })
    manager.handleConnected()
    await vi.waitFor(() => {
      expect(manager.getListSnapshot().items.find(item => item.sessionId === S2)?.running).toBe(false)
    })
  })
})

describe('remaining branches', () => {
  it('refreshList propagates a non-Remote throw', async ({ mock, remote }) => {
    remote.session.list.mockRejectedValue(new Error('list wire down'))
    const manager = makeManager(mock, remote)
    await expect(manager.refreshList()).rejects.toThrow('list wire down')
  })

  it('refreshList pushes running bits down to already-instantiated sessions', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    const session = manager.get(S1)
    remote.session.list.mockResolvedValue(ok({ items: [summary(S1, { running: true })] as never[] }))
    await manager.refreshList()
    expect(session.getSnapshot().running).toBe(true)
  })

  it('create passes cwd and a preallocated id, folds transport throws, and deduplicates the echo', async ({ mock, remote }) => {
    remote.session.create.mockResolvedValue(ok({ sessionId: S1 }))
    const manager = makeManager(mock, remote)
    await manager.create({ cwd: '/tmp/w', sessionId: S1 })
    expect(remote.session.create).toHaveBeenCalledExactlyOnceWith({ cwd: '/tmp/w', sessionId: S1 })
    expect(manager.getListSnapshot().items[0]).toMatchObject({ sessionId: S1, cwd: '/tmp/w' })
    await manager.create({ cwd: '/tmp/w' }) // same id returned: no duplicate row
    expect(manager.getListSnapshot().items).toHaveLength(1)
    remote.session.create.mockRejectedValue(new Error('create wire down'))
    await expect(manager.create()).rejects.toThrow('create wire down')
    // Business error passes through untouched.
    remote.session.create.mockResolvedValue(err(new RemoteError('gateway/internal', 'no', {})))
    expect(await manager.create()).toMatchObject({ ok: false })
  })

  it.for(['create', 'fork'] as const)('preserves pushed running state when a %s response arrives later', async (operation, { mock, remote }) => {
    const response = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.create>>>()
    remote.session[operation].mockImplementation(() => response.promise)
    const manager = makeManager(mock, remote)
    const request = operation === 'create' ? manager.create() : manager.fork({ sessionId: S1 })
    manager.handleSessionAdded(summary(S2, { running: true }))
    response.resolve(ok({ sessionId: S2 }))
    await request
    expect(manager.getListSnapshot().items.find(item => item.sessionId === S2))
      .toMatchObject({ running: true })
    manager.handleSessionAdded(summary(S2, { running: false, agentAvailable: false }))
    expect(manager.getListSnapshot().items.find(item => item.sessionId === S2))
      .toMatchObject({ running: false })
    await manager.dispose()
  })

  it('preserves Host availability when a local create echo follows Agent disposal', async ({ mock, remote }) => {
    const response = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.create>>>()
    remote.session.create.mockImplementation(() => response.promise)
    const manager = makeManager(mock, remote)
    manager.resolveTarget({
      parentSessionId: S1, childSessionId: S2, mode: 'continuable',
    })
    const child = manager.get(S2)
    const request = manager.create()
    manager.handleSessionAdded(summary(S1, { agentAvailable: false }))
    response.resolve(ok({ sessionId: S1 }))
    await request
    manager.resolveTarget(S2)
    expect(child.getSnapshot().subagent?.parentAvailable).toBe(false)
    await manager.dispose()
  })

  it('publishes a real Ungrouped summary from workspace-attach-failed', async ({ mock, remote }) => {
    remote.session.create.mockResolvedValue(err(new RemoteError('session/workspace-attach-failed', 'published but unattached', {
      sessionId: S1, workspaceId: 'w1',
    })))
    const manager = makeManager(mock, remote)
    const result = await manager.create({ workspaceId: 'w1' as never, sessionId: S1 })
    expect(result).toMatchObject({ ok: false, error: { code: 'session/workspace-attach-failed' } })
    expect(manager.getListSnapshot().items).toEqual([expect.objectContaining({ sessionId: S1 })])
    expect(manager.getListSnapshot().items[0]).not.toHaveProperty('cwd')
  })

  it('reconciles a fork child published before workspace attachment fails', async ({ mock, remote }) => {
    remote.session.fork.mockResolvedValue(err(new RemoteError('session/workspace-attach-failed', 'forked but unattached', {
      sessionId: S2, workspaceId: 'w1',
    })))
    const manager = makeManager(mock, remote)
    const result = await manager.fork({ sessionId: S1 })
    expect(result).toMatchObject({ ok: false, error: { code: 'session/workspace-attach-failed' } })
    expect(manager.getListSnapshot().items).toEqual([expect.objectContaining({
      sessionId: S2,
      parentSessionId: S1,
      blank: true,
    })])

    manager.handleSessionAdded(summary(S2, { blank: true, parentSessionId: S1 }))
    expect(manager.getListSnapshot().items[0]?.blank).toBe(true)
    manager.handleSessionAdded(summary(S2, { blank: false, parentSessionId: S1 }))
    expect(manager.getListSnapshot().items[0]?.blank).toBe(false)
  })

  it('reconciles a preallocated id after an ordinary transport failure', async ({ mock, remote }) => {
    remote.session.create.mockRejectedValue(new Error('response lost'))
    const manager = makeManager(mock, remote)
    await expect(manager.create({ workspaceId: 'w1' as never, sessionId: S1 }))
      .rejects.toThrow('response lost')
    expect(manager.getListSnapshot().items).toEqual([])

    manager.handleSessionAdded(summary(S1, { blank: true, cwd: '/w/one' }))
    expect(manager.getListSnapshot().items).toEqual([
      expect.objectContaining({ sessionId: S1, cwd: '/w/one' }),
    ])
    manager.handleSessionAdded(summary(S1, { blank: true, cwd: '/w/one' }))
    expect(manager.getListSnapshot().items).toHaveLength(1)
  })

  it('subscribe notifies on list changes and stops after unsubscribe', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    let notified = 0
    const unsubscribe = manager.subscribe(() => { notified++ })
    await manager.refreshList()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(notified).toBeGreaterThan(0)
    const seen = notified
    unsubscribe()
    manager.handleSessionAdded(summary(S1, { blank: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(notified).toBe(seen)
  })

  it('ignores Host status and error events for sessions without an instance', ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    manager.handleSessionStatus(S2, true)
    manager.handleSessionError(S2, '无实例')
  })

  it('keeps list-entry identity for unchanged rows across an unrelated list change', async ({ mock, remote }) => {
    remote.session.list.mockResolvedValue(ok({ items: [summary(S1), summary(S2, { updatedAt: 200 })] as never[] }))
    const manager = makeManager(mock, remote)
    await manager.refreshList()
    const before = manager.getListSnapshot()
    manager.handleSessionStatus(S2, true)
    const after = manager.getListSnapshot()
    expect(after.items).not.toBe(before.items)
    const beforeS1 = before.items.find(e => e.sessionId === S1)
    const afterS1 = after.items.find(e => e.sessionId === S1)
    expect(afterS1).toBe(beforeS1) // untouched entry keeps identity (entryCache)
    // Same-order same-entries snapshot reuses the items array.
    manager.handleSessionError(S1, 'x')
    expect(manager.getListSnapshot().items).toBe(after.items)
  })

  it('reuses refreshed rows and evicts missing rows independently of Client instances', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    remote.session.list.mockResolvedValue(ok({ items: [summary(S1), summary(S2)] as never[] }))
    await manager.refreshList()
    const first = manager.getListSnapshot()

    remote.session.list.mockResolvedValue(ok({ items: [summary(S1), summary(S2)] as never[] }))
    await manager.refreshList()
    expect(manager.getListSnapshot().items).toBe(first.items)

    remote.session.list.mockResolvedValue(ok({ items: [summary(S1)] as never[] }))
    await manager.refreshList()
    expect(manager.getListSnapshot().items).toEqual([first.items[0]])
    expect(manager.getListSnapshot().items[0]).toBe(first.items[0])

    remote.session.list.mockResolvedValue(ok({ items: [summary(S1), summary(S2)] as never[] }))
    await manager.refreshList()
    expect(manager.getListSnapshot().items[0]).toBe(first.items[0])
    expect(manager.getListSnapshot().items[1]).not.toBe(first.items[1])

    remote.session.list.mockResolvedValue(ok({ items: [] as never[] }))
    await manager.refreshList()
    expect(manager.getListSnapshot().items).toEqual([])

    remote.session.list.mockResolvedValue(ok({ items: [summary(S1)] as never[] }))
    await manager.refreshList()
    expect(manager.getListSnapshot().items[0]).not.toBe(first.items[0])
  })

  it('bounds cached-row ID reads linearly during repeated list refreshes', async ({ mock, remote }) => {
    const count = 1_000
    const summaries = Array.from({ length: count }, (_, i) => summary(`list-${i}` as SessionId))
    const manager = makeManager(mock, remote)
    remote.session.list.mockResolvedValue(ok({ items: summaries as never[] }))
    await manager.refreshList()
    const first = manager.getListSnapshot()
    let reads = 0
    // Instance-local accessors count membership work without a machine-dependent timing budget.
    for (const entry of first.items) {
      const id = entry.sessionId
      Object.defineProperty(entry, 'sessionId', { get: () => { reads++; return id }, configurable: true })
    }
    for (let refresh = 0; refresh < 2; refresh++) {
      reads = 0
      remote.session.list.mockResolvedValue(ok({ items: summaries.map(item => ({ ...item })) as never[] }))
      await manager.refreshList()
      const snapshot = manager.getListSnapshot()
      expect(snapshot.items).toBe(first.items)
      expect(reads).toBeLessThanOrEqual(count * 3)
    }
  })

  it('carries parentSessionId from the added event into the lineage row', ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    manager.handleSessionAdded(summary(S1, { blank: true }))
    manager.handleSessionAdded(summary(S2, {
      blank: true, parentSessionId: S1, origin: 'subagent',
    }))
    const items = manager.getListSnapshot().items
    expect(items.find(e => e.sessionId === S2)).toMatchObject({
      parentSessionId: S1, origin: 'subagent', depth: 1,
    })
  })
})

describe('connected generation', () => {
  it('does not prune running observations from a superseded empty list response', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    onTestFinished(() => manager.dispose())
    const oldList = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.list>>>()
    const newList = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.list>>>()
    remote.session.list.mockReturnValueOnce(oldList.promise).mockReturnValueOnce(newList.promise)
    const oldPull = manager.refreshList()
    manager.handleSessionStatus(S1, true)
    manager.handleSessionStatus(S1, false)
    manager.handleConnected()
    const newPull = manager.refreshList()
    try {
      oldList.resolve(ok({ items: [] }))
      await oldPull
      expect(manager.getListSnapshot().state).toBe('loading')
      newList.resolve(ok({ items: [summary(S1, { blank: true })] }))
      await newPull

      expect(manager.getListSnapshot().items[0]?.blank).toBe(false)
    } finally {
      oldList.resolve(ok({ items: [] }))
      newList.resolve(ok({ items: [] }))
      await Promise.all([oldPull, newPull])
    }
  })

  it.for(['old-first', 'new-first'] as const)(
    'ignores a previous generation list response (%s)',
    async (order, { mock, remote }) => {
      const oldList = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.list>>>()
      const newList = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.list>>>()
      let calls = 0
      remote.session.list.mockImplementation(() => calls++ === 0 ? oldList.promise : newList.promise)
      const manager = makeManager(mock, remote)
      const oldResult = ok({ items: [{ ...summary(S1), projections: {
        kind: 'cached', asOfSeq: 20, values: { title: 'Unpersisted title' },
      } }] as never[] })
      const newResult = ok({ items: [{ ...summary(S1), projections: {
        kind: 'cached', asOfSeq: 1, values: { title: 'Durable title' },
      } }] as never[] })
      const oldPull = manager.refreshList()
      let newPull: Promise<void> | undefined
      try {
        manager.handleConnected()
        newPull = manager.refreshList()
        expect(remote.session.list.mock.calls).toHaveLength(2)
        if (order === 'old-first') {
          oldList.resolve(oldResult)
          await oldPull
          expect(manager.getListSnapshot().state).toBe('loading')
          expect(manager.refreshList()).toBe(newPull)
        }
        newList.resolve(newResult)
        await newPull
        oldList.resolve(oldResult)
        await oldPull

        expect(manager.getListSnapshot()).toMatchObject({ state: 'idle', error: null })
        expect(manager.getListSnapshot().items[0]?.title).toBe('Durable title')
      } finally {
        oldList.resolve(oldResult)
        newList.resolve(newResult)
        await Promise.all([oldPull, newPull])
        await manager.dispose()
      }
    },
  )

  it('ignores a previous generation request failure while the new list is loading', async ({ mock, remote }) => {
    const oldList = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.list>>>()
    const newList = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.list>>>()
    let calls = 0
    remote.session.list.mockImplementation(() => calls++ === 0 ? oldList.promise : newList.promise)
    const manager = makeManager(mock, remote)
    const oldPull = manager.refreshList()
    let newPull: Promise<void> | undefined
    try {
      manager.handleConnected()
      newPull = manager.refreshList()
      oldList.reject(new RemoteError('gateway/internal', 'old Host disconnected', {}))
      await oldPull
      expect(manager.getListSnapshot()).toMatchObject({ state: 'loading', error: null })
      expect(manager.refreshList()).toBe(newPull)
      newList.resolve(ok({ items: [summary(S1)] as never[] }))
      await newPull
      expect(manager.getListSnapshot()).toMatchObject({ state: 'idle', error: null })
    } finally {
      oldList.resolve(ok({ items: [] }))
      newList.resolve(ok({ items: [] }))
      await Promise.all([oldPull, newPull])
      await manager.dispose()
    }
  })

  it.for([false, true])('refreshes an unselected cached catalog after offline activity changes: %s', async (running, { mock, remote }) => {
    let hostRunning = !running
    remote.session.list.mockImplementation(() => Promise.resolve(ok({ items: [
      summary(S1),
      summary(S2, { parentSessionId: S1, origin: 'subagent', running: hostRunning }),
    ] as never[] })))
    remote.session.projections.mockImplementation(() => Promise.resolve(ok({ asOfSeq: 0, values: { subagentCatalog: [{ createdAt: 1, id: S2, mode: 'continuable', label: 'worker' }] } })))
    const manager = makeManager(mock, remote)
    try {
      await manager.refreshList()
      await manager.refreshProjections(S1)
      const reads = remote.session.projections.mock.calls.map(([request]) => request).length
      hostRunning = running
      manager.handleConnected()
      await manager.refreshList()
      await vi.waitFor(() => {
        expect(manager.getListSnapshot().items.find(item => item.sessionId === S2)?.running)
          .toBe(running)
      })
      expect(manager.getListSnapshot()).not.toHaveProperty('current')
      expect(remote.session.projections.mock.calls.map(([request]) => request)).toHaveLength(reads + 1)
    } finally {
      await manager.dispose()
    }
  })

  it('starts a fresh catalog read on reconnect and ignores the previous response', async ({ mock, remote }) => {
    const previous = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.projections>>>()
    remote.session.projections
      .mockReturnValueOnce(previous.promise)
      .mockResolvedValue(ok({ asOfSeq: 0, values: { subagentCatalog: [] } }))
    const manager = makeManager(mock, remote)
    try {
      const read = manager.refreshProjections(S1)
      manager.handleConnected()
      expect(remote.session.projections.mock.calls.map(([request]) => request)).toHaveLength(2)
      previous.resolve(ok({ asOfSeq: 0, values: { subagentCatalog: [{ createdAt: 1, id: S2, mode: 'continuable', label: 'worker' }] } }))
      await read
      await vi.waitFor(() => {
        expect(manager.getListSnapshot().projectionsBySession[S1]).toMatchObject({
          values: {}, state: 'ready',
        })
      })
      expect(remote.session.projections.mock.calls.map(([request]) => request)).toHaveLength(2)
    } finally {
      await manager.dispose()
    }
  })

  it('refreshes query baselines without rebuilding independently resumed Session sources', async ({ mock, remote, start }) => {
    mock.stream(FOLLOW, followScript(ok({
      records: entries(plainTurn(SessionSeq(0), 0, 'a', 'b')) as never[],
      hasMore: false,
      modelSelection: { provider: 'deepseek-official', model: 'deepseek-chat' },
    })))
    const client = await start()
    const manager = new SessionManager(client.ctx.remote)
    const openedSession = manager.get(S1)
    await openedSession.open()
    manager.get(S2) // instantiated but never opened
    const historyCallsBefore = remote.session.page.mock.calls.length
    manager.handleConnected()
    await vi.waitFor(() => {
      expect(remote.session.list).toHaveBeenCalledOnce()
    })
    expect(remote.session.follow).toHaveBeenCalledOnce()
    expect(remote.session.page).toHaveBeenCalledTimes(historyCallsBefore)
  })

  it('re-opens failed session windows on reset', async ({ mock, start }) => {
    // Opening a window goes through the Gateway stream factory, which the narrow
    // makeManager Remote does not carry; this case needs the booted client's Remote.
    mock.stream(FOLLOW, followScript(err(new RemoteError('gateway/internal', 'carrier reset', {}))))
    const client = await start()
    const manager = new SessionManager(client.ctx.remote)
    onTestFinished(() => manager.dispose())
    const openedSession = manager.get(S1)
    await openedSession.open().catch(() => {})
    expect(openedSession.getSnapshot().openState).toBe('error')
    mock.stream(FOLLOW, followScript(history(plainTurn(SessionSeq(0), 0, 'a', 'b'))))
    const callsBefore = mock.log.requests(FOLLOW).length
    manager.handleConnected()
    await vi.waitFor(() => {
      expect(openedSession.getSnapshot().openState).toBe('open')
    })
    expect(mock.log.requests(FOLLOW).length).toBe(callsBefore + 1)
  })

  it('retains the durable parent address and refreshes that parent across reconnect', async ({ mock, remote }) => {
    const address = {
      parentSessionId: S1,
      childSessionId: S2,
      mode: 'continuable' as const,
    }
    remote.session.list.mockImplementation(() => Promise.resolve(ok({ items: [summary(S1)] as never[] })))
    const parent = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.projections>>>()
    remote.session.projections.mockImplementation(() => parent.promise)
    const manager = makeManager(mock, remote)
    manager.resolveTarget(address)
    manager.get(S2)

    manager.handleConnected()
    expect(manager.get(S2).getSnapshot().subagent).toEqual({ address })
    parent.resolve(ok({ asOfSeq: 0, values: { subagentCatalog: [{ createdAt: 1,
      id: S2, mode: 'continuable', label: 'worker',
    }] } }))

    await vi.waitFor(() => {
      expect(remote.session.list.mock.calls.map(([request]) => request)).toHaveLength(1)
    })
    await vi.waitFor(() => {
      expect(remote.session.projections.mock.calls.map(([request]) => request)).toEqual([
        { sessionId: S1 },
      ])
    })
    expect(manager.get(S2).getSnapshot().subagent).toEqual({
      address,
      parentAvailable: true,
    })
    expect(manager.subagentAddress(S2)).toEqual(address)
  })
})

describe('running facts without UI reminders', () => {
  it('replays running status during hydration without publishing a completion marker', async ({ mock, remote }) => {
    const response = Promise.withResolvers<Awaited<ReturnType<typeof remote.session.list>>>()
    remote.session.list.mockReturnValueOnce(response.promise)
    const manager = makeManager(mock, remote)
    const refreshing = manager.refreshList()
    manager.handleSessionStatus(S1, true)
    manager.handleSessionStatus(S1, false)
    response.resolve(ok({ items: [summary(S1)] }))
    await refreshing
    const entry = manager.getListSnapshot().items.find(item => item.sessionId === S1)
    expect(entry).toMatchObject({ running: false })
    expect(entry).not.toHaveProperty('completed')
    expect(manager.getListSnapshot()).not.toHaveProperty('current')
  })
})
