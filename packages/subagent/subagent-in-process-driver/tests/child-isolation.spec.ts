/**
 * Per-child workspace and skill scoping on the one-shot spawn path: request
 * `cwd` overrides the inherited parent workspace in the child session header,
 * and request `skillFilter` reaches the skill registry's scoped restriction
 * in the child's creation window.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import SkillRegistry from '../../../skill/skill/src/index.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { startInProcessRun } from '../src/index.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

/** A host composition with the loop but no preset roster, plus a parent in a fixed workspace. */
async function setup(script: Script): Promise<{ ctx: Context; parent: Agent }> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const parent = ctx.agentLoop.create(
    SessionId('parent'),
    { provider: 'mock', model: 'mock' },
    { cwd: '/parent-workspace' },
  )
  return { ctx, parent }
}

function spawnRequest(
  parent: Agent,
  extra: { cwd?: string; skillFilter?: { allow?: string[]; deny?: string[] } } = {},
) {
  return {
    label: 'child task',
    prompt: [{ type: 'text' as const, text: 'child task' }],
    parent,
    signal: new AbortController().signal,
    descriptor: snapshotSubagentDescriptor({
      mode: 'one-shot' as const,
      provider: 'spawn',
      label: 'child task',
    }),
    ...extra.cwd !== undefined ? { cwd: extra.cwd } : {},
    ...extra.skillFilter !== undefined ? { skillFilter: extra.skillFilter } : {},
  }
}

/** The names the given agent's scope currently sees in the skill catalog. */
async function visibleSkills(ctx: Context, agent: Agent): Promise<string[]> {
  return (await ctx.skills.snapshot({ scope: agent })).skills.map(skill => skill.name)
}

function registerSkill(ctx: Context, name: string): void {
  ctx.skills.register({
    name,
    description: `${name} skill`,
    source: 'runtime',
    content: `${name} body.`,
  })
}

describe('in-process child workspace and skill scoping', () => {
  it('stamps a requested absolute cwd over the inherited parent workspace', async () => {
    const { parent } = await setup([textResponse('child done')])

    const run = await startInProcessRun(spawnRequest(parent, { cwd: '/child-workspace' }), {})
    try {
      expect(run.localAgent?.session.header.cwd).toBe('/child-workspace')
      await run.result
    } finally {
      await run.dispose()
    }
  })

  it('keeps the parent workspace when the request carries no cwd', async () => {
    const { parent } = await setup([textResponse('child done')])

    const run = await startInProcessRun(spawnRequest(parent), {})
    try {
      expect(run.localAgent?.session.header.cwd).toBe('/parent-workspace')
      await run.result
    } finally {
      await run.dispose()
    }
  })

  it('rejects a request cwd that is not absolute', async () => {
    const { ctx, parent } = await setup([])

    await expect(startInProcessRun(spawnRequest(parent, { cwd: 'relative/path' }), {}))
      .rejects.toThrow('child session cwd must be an absolute path')
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
  })

  it('restricts the child catalog to an allow list while the parent keeps the full view', async () => {
    const { ctx, parent } = await setup([textResponse('child done')])
    await ctx.plugin(SkillRegistry)
    registerSkill(ctx, 'alpha')
    registerSkill(ctx, 'beta')
    registerSkill(ctx, 'gamma')

    const run = await startInProcessRun(
      spawnRequest(parent, { skillFilter: { allow: ['alpha', 'gamma'] } }),
      {},
    )
    try {
      const child = run.localAgent as Agent
      expect(await visibleSkills(ctx, child)).toEqual(['alpha', 'gamma'])
      expect(await ctx.skills.get('beta', { scope: child })).toBeUndefined()
      expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['alpha', 'beta', 'gamma'])
      await run.result
    } finally {
      await run.dispose()
    }
  })

  it('restricts denied skills from the child catalog', async () => {
    const { ctx, parent } = await setup([textResponse('child done')])
    await ctx.plugin(SkillRegistry)
    registerSkill(ctx, 'alpha')
    registerSkill(ctx, 'beta')

    const run = await startInProcessRun(spawnRequest(parent, { skillFilter: { deny: ['beta'] } }), {})
    try {
      const child = run.localAgent as Agent
      expect(await visibleSkills(ctx, child)).toEqual(['alpha'])
      await run.result
    } finally {
      await run.dispose()
    }
  })

  it('rejects a skill filter without a composed skill registry', async () => {
    const { ctx, parent } = await setup([])

    await expect(startInProcessRun(spawnRequest(parent, { skillFilter: { deny: ['beta'] } }), {}))
      .rejects.toThrow('skillFilter requires the skill registry')
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
  })

  it('rejects a skill filter naming both directions through the registry', async () => {
    const { ctx, parent } = await setup([])
    await ctx.plugin(SkillRegistry)
    registerSkill(ctx, 'alpha')

    await expect(startInProcessRun(
      spawnRequest(parent, { skillFilter: { allow: ['alpha'], deny: ['beta'] } }),
      {},
    )).rejects.toThrow('both allow and deny')
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
  })
})
