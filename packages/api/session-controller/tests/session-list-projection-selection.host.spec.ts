/**
 * The list wire's projection selection: a Session-list row ships only the
 * projection keys the list plane reads — `sessionListMetadata`, `title`,
 * `subagentCatalog`, `schedule`, `subagentTiming`, `tokenUsage`, `subagent`,
 * `agentPreset`, `agentTeam`, `modelSelection` — while the Session-open
 * snapshot keeps the complete projection set. The heavy keys that only
 * opened-Session surfaces read (`turnOutline` above all, plus `inbox`,
 * `todos`, and the rest) never cross the wire for a listing call, whatever row
 * scope it uses. The last case derives that reader set from this repository's
 * sources, so a key a list consumer selects cannot leave the wire unnoticed.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { createSessionTestRemote, testSessionPersistence, type TestSessionRemote } from './test-remote.ts'
import type { SessionFollowFrame } from '../src/types.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'test/not-list-plane': string | null
  }
  interface SessionProjectionMap {
    'test/not-list-plane': string | null
  }
}

/** Non-list-plane wire unit proving the open path still ships dropped keys. */
const notListPlaneUnit = () => ({
  key: 'test/not-list-plane',
  stateSchema: z.string().nullable(),
  init: () => null,
  apply: (state: string | null, event: SessionEvent): string | null =>
    event.type === 'user/message' ? 'folded' : state,
  wire: {
    viewSchema: z.string().nullable(),
    view: (state: string | null) => state,
  },
  stateVersion: 1,
}) satisfies ProjectionDefinition<'test/not-list-plane', string | null>

const sid = (id: string): SessionIdType => id as SessionIdType

function header(id: string, createdAt: number, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: sid(id), createdAt, isSeeded: false, cwd: '/proj', ...extra }
}

/** A block carrying every kept list-plane key plus heavy dropped ones. */
function fullBlock(asOfSeq: number): { asOfSeq: number; values: Record<string, unknown> } {
  return {
    asOfSeq,
    values: {
      // Kept: list-plane consumers read these.
      sessionListMetadata: { blank: false, lastPromptAt: 1200 },
      title: 'Cold title',
      subagentCatalog: [{ id: 'child-a', createdAt: 1, mode: 'continuable', label: 'child A' }],
      schedule: [{ id: 'reminder-1' }],
      subagentTiming: { settledMs: 4000, lastTurnCompleted: true },
      tokenUsage: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
      subagent: { mode: 'continuable', label: 'child A', seq: 5 },
      agentPreset: 'preset-eng',
      agentTeam: { roster: [{ id: 'member-1' }], board: { tasks: [] } },
      modelSelection: { lastUsed: null, next: { provider: 'p', model: 'member-model' } },
      // Dropped: only opened-Session surfaces read these.
      turnOutline: Array.from({ length: 200 }, (_, turn) => ({
        turn,
        preview: 'x'.repeat(300),
      })),
      inbox: { nextTurn: [{ content: 'pending text' }], nextStep: [] },
      todos: [{ id: 'todo-1', text: 'task' }],
      imageLimits: {
        maxImageBytes: 1024, maxImagesPerMessage: 2, maxMessageImageBytes: 2048,
        maxImagePixels: 4096, maxImageDimension: 128, mediaTypes: ['image/png'],
      },
      goal: null,
      plan: { active: false },
      permissions: { preset: 'p' },
      sessionStats: { turns: 3, steps: 4 },
      contextPressure: { ratio: 0.5 },
      contextBreakdown: { systemTokens: 1 },
      llmRetry: {},
      costUsage: { cost: 0 },
    },
  }
}

/** The kept keys exactly as the full block carries them. */
function keptValues(): Record<string, unknown> {
  const block = fullBlock(0)
  return {
    sessionListMetadata: block.values.sessionListMetadata,
    title: block.values.title,
    subagentCatalog: block.values.subagentCatalog,
    schedule: block.values.schedule,
    subagentTiming: block.values.subagentTiming,
    tokenUsage: block.values.tokenUsage,
    subagent: block.values.subagent,
    agentPreset: block.values.agentPreset,
    agentTeam: block.values.agentTeam,
    modelSelection: block.values.modelSelection,
  }
}

/** One cold row served by the given per-id cache blocks. */
async function coldHarness(
  metas: readonly SessionHeader[],
  blocks: Readonly<Record<string, { asOfSeq: number; values: Record<string, unknown> }>>,
): Promise<{ ctx: Context; remote: TestSessionRemote }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve(metas),
  }) as never)
  ctx.provide('sessionProjectionCache', {
    cachedSnapshot: (meta: SessionHeader) => blocks[String(meta.id)],
    cachedPredecessorTitle: () => undefined,
  } as never)
  const remote = createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: '/tmp',
  })
  return { ctx, remote }
}

/** Read and close one snapshot-first follow generation. */
async function opening(
  remote: TestSessionRemote,
  sessionId: SessionIdType,
): Promise<Extract<SessionFollowFrame, { type: 'snapshot' }>> {
  const abort = new AbortController()
  const iterator = remote.follow({
    address: { kind: 'session', sessionId },
  }, abort.signal)[Symbol.asyncIterator]()
  const first = await iterator.next()
  abort.abort()
  await iterator.return?.()
  if (first.done || first.value.type !== 'snapshot') throw new Error('follow did not open with a snapshot')
  return first.value
}

describe('session/list projection selection', () => {
  it('default list rows carry exactly the list-plane keys', async () => {
    const metas = [header('cold-full', 100)]
    const { remote } = await coldHarness(metas, { 'cold-full': fullBlock(7) })

    const response = await remote.list({})
    if (!response.ok) throw new Error('list failed')
    const row = response.value.items.find(item => item.sessionId === sid('cold-full'))
    expect(row?.projections).toEqual({
      kind: 'cached',
      asOfSeq: 7,
      values: keptValues(),
    })
    expect(row?.blank).toBe(false)
    expect(row?.updatedAt).toBe(1200)
  })

  it('a heavy non-list-plane key cannot leak into the list response', async () => {
    const metas = [header('cold-full', 100)]
    const { remote } = await coldHarness(metas, { 'cold-full': fullBlock(7) })

    const response = await remote.list({})
    if (!response.ok) throw new Error('list failed')
    const values = response.value.items[0]?.projections?.values ?? {}
    // The measured 37,786-byte key of the largest production row: shipping it
    // on a listing is the regression this test exists to catch.
    expect(values).not.toHaveProperty('turnOutline')
    expect(values).not.toHaveProperty('inbox')
    expect(values).not.toHaveProperty('todos')
    expect(values).not.toHaveProperty('imageLimits')
    expect(values).toEqual(keptValues())
  })

  it('omits the projections block when the source carries no list-plane value', async () => {
    const metas = [header('cold-heavy-only', 100)]
    const { remote } = await coldHarness(metas, {
      'cold-heavy-only': {
        asOfSeq: 3,
        values: { turnOutline: [{ turn: 1, preview: 'x'.repeat(500) }] },
      },
    })

    const response = await remote.list({})
    if (!response.ok) throw new Error('list failed')
    const row = response.value.items.find(item => item.sessionId === sid('cold-heavy-only'))
    expect(row?.projections).toBeUndefined()
    expect(row?.blank).toBe(false)
  })

  it('children and all scopes apply the same selection to every row', async () => {
    const metas = [
      header('parent', 400),
      header('child', 200, { parentSession: sid('parent'), origin: 'subagent' }),
    ]
    const parentBlock = fullBlock(9)
    const childBlock = {
      asOfSeq: 5,
      values: {
        sessionListMetadata: { blank: false, lastPromptAt: 300 },
        subagentTiming: { settledMs: 1200, lastTurnCompleted: false },
        tokenUsage: { uncachedInputTokens: 0, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 },
        subagent: { mode: 'continuable', label: 'child B', seq: 2 },
        turnOutline: [{ turn: 0, preview: 'x'.repeat(400) }],
      },
    }
    const { remote } = await coldHarness(metas, { parent: parentBlock, child: childBlock })

    // Default listing: subagent rows stay hidden; the parent keeps its selection.
    const listed = await remote.list({})
    if (!listed.ok) throw new Error('list failed')
    const listedIds = listed.value.items.map(item => String(item.sessionId))
    expect(listedIds).toEqual(['parent'])
    expect(listed.value.items[0]?.projections).toEqual({ kind: 'cached', asOfSeq: 9, values: keptValues() })

    // Children read: exactly the parent's children, whatever their origin.
    const children = await remote.list({ parentSessionId: sid('parent') })
    if (!children.ok) throw new Error('children list failed')
    expect(children.value.items.map(item => String(item.sessionId))).toEqual(['child'])
    expect(children.value.items[0]).toMatchObject({
      parentSessionId: sid('parent'),
      origin: 'subagent',
    })
    expect(children.value.items[0]?.projections).toEqual({
      kind: 'cached',
      asOfSeq: 5,
      values: {
        sessionListMetadata: childBlock.values.sessionListMetadata,
        subagentTiming: childBlock.values.subagentTiming,
        tokenUsage: childBlock.values.tokenUsage,
        subagent: childBlock.values.subagent,
      },
    })

    // Explicit all scope: subagent rows included with the same selection.
    const all = await remote.list({ scope: 'all' })
    if (!all.ok) throw new Error('all-scope list failed')
    const allBy = Object.fromEntries(all.value.items.map(item => [String(item.sessionId), item]))
    expect(allBy['child']).toBeDefined()
    expect(allBy['child']?.projections).toEqual({
      kind: 'cached',
      asOfSeq: 5,
      values: {
        sessionListMetadata: childBlock.values.sessionListMetadata,
        subagentTiming: childBlock.values.subagentTiming,
        tokenUsage: childBlock.values.tokenUsage,
        subagent: childBlock.values.subagent,
      },
    })
    expect(allBy['parent']?.projections).toEqual({ kind: 'cached', asOfSeq: 9, values: keptValues() })
  })

  it('a Session-open snapshot keeps the complete projection set', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/tmp',
    })
    ctx.sessionProjections.register(notListPlaneUnit())
    const session = ctx.sessions.create(SessionId('live-list-plane'), { meta: { cwd: '/workspace' } })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    // The listing of the live Session carries only list-plane keys: the
    // sessionListMetadata fold arrives, while the open-plane units stay home.
    const response = await remote.list({})
    if (!response.ok) throw new Error('list failed')
    const row = response.value.items.find(item => item.sessionId === session.id)
    expect(row).toBeDefined()
    const values = row?.projections?.values ?? {}
    expect(values).toHaveProperty('sessionListMetadata')
    expect(values).not.toHaveProperty('imageLimits')
    expect(values).not.toHaveProperty('test/not-list-plane')
    for (const key of Object.keys(values)) {
      expect([
        'agentPreset', 'agentTeam', 'modelSelection', 'schedule', 'sessionListMetadata',
        'subagent', 'subagentCatalog', 'subagentTiming', 'title', 'tokenUsage',
      ]).toContain(key)
    }
    expect(row?.blank).toBe(false)

    // The Session-open window ships every registered projection.
    const snapshot = await opening(remote, session.id)
    expect(snapshot.projections.values['test/not-list-plane']).toBe('folded')
    expect(snapshot.projections.values.imageLimits).toBeDefined()
    expect(snapshot.projections.values.sessionListMetadata).toMatchObject({ blank: false })
  })

  it('ships every projection key a list-plane consumer selects from the built sources', async () => {
    const scan = listPlaneConsumerKeys(fileURLToPath(new URL('../../../..', import.meta.url)))
    // Guard the scan itself: a broken walk or accessor regex must fail here
    // rather than pass with an empty reader set. The Team member row is the
    // reader whose key left the wire once, so it anchors the snapshot map.
    expect(scan.scannedFiles).toBeGreaterThan(1_000)
    expect(scan.readingFiles).toContain('packages/experimental/client-ui-agent-team/src/client/TeamAction.tsx')
    expect(scan.keys).toContain('modelSelection')
    expect(scan.keys.size).toBeGreaterThanOrEqual(8)

    const block = fullBlock(4)
    const consumers = Object.fromEntries([...scan.keys].sort().map(key => [
      key,
      key in block.values ? block.values[key] : { sourceScan: key },
    ]))
    const { remote } = await coldHarness([header('consumer-keys', 100)], {
      'consumer-keys': { asOfSeq: 4, values: consumers },
    })

    const response = await remote.list({})
    if (!response.ok) throw new Error('list failed')
    const row = response.value.items.find(item => item.sessionId === sid('consumer-keys'))
    // Subset, not equality: the whitelist's exact set is pinned by the cases
    // above, while this case only proves no reader key left the wire.
    expect(Object.keys(row?.projections?.values ?? {}))
      .toEqual(expect.arrayContaining([...scan.keys].sort()))
  })
})

/**
 * Every projection key a list-plane consumer selects out of the client's list
 * state. Two accessors reach the plane: a row summary's `projectionValues`
 * block and the per-session snapshot map's `projectionsBySession[...]?.values`.
 * The reader set has no runtime registry, so it is read from the sources that
 * are the readers; a consumer written with an accessor the patterns below do
 * not match (a snapshot parked in a local variable and read far from
 * `projectionsBySession`) stays outside this scan.
 * @param root - repository root to walk.
 * @returns the selected keys, the matched reader files, and the walk's reach.
 */
function listPlaneConsumerKeys(root: string): {
  readonly keys: ReadonlySet<string>
  readonly readingFiles: ReadonlySet<string>
  readonly scannedFiles: number
} {
  const accessors = [
    /projectionValues\s*\??\.\s*([A-Za-z_$][\w$]*)/g,
    /projectionsBySession[\s\S]{0,200}?\?\.values\s*\??\.\s*([A-Za-z_$][\w$]*)/g,
  ]
  const skipped = new Set(['node_modules', 'lib', 'dist', 'tests', '.git', 'coverage'])
  const keys = new Set<string>()
  const readingFiles = new Set<string>()
  let scannedFiles = 0

  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!skipped.has(entry.name)) visit(path)
        continue
      }
      if (!/\.tsx?$/.test(entry.name) || /\.(?:spec|test)\./.test(entry.name)) continue
      scannedFiles++
      const source = readFileSync(path, 'utf8')
      for (const accessor of accessors) {
        for (const match of source.matchAll(new RegExp(accessor.source, 'g'))) {
          const key = match[1] as string
          keys.add(key)
          readingFiles.add(relative(root, path))
        }
      }
    }
  }

  for (const top of ['packages', 'apps']) {
    try {
      statSync(join(root, top))
    } catch {
      continue
    }
    visit(join(root, top))
  }
  return { keys, readingFiles, scannedFiles }
}
