/**
 * Fork patch (FORK_SURFACE.md) coverage for `@deepseek-ai/dsh-tool-subagent`:
 * the per-instance model-alias face (`models` / `defaultModel`), the per-child
 * `cwd`, and the per-child `skillFilter` absorbed from the external
 * `dsh-subagent-dispatch` plugin — plus the invariant that an instance without
 * `models` keeps upstream's face, wording, and request shape.
 *
 * The upstream suites stay the regression control for that invariant
 * (`tool-subagent.spec.ts`, `model-selection.spec.ts`); the cases at the bottom
 * of this file pin the same surface from the fork patch's own side.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { MessageId, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { ContinuableStartSpec, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as ToolTasks from '@deepseek-ai/dsh-tool-jobs'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as tool from '../src/index.ts'
import { allowedConfigKeys } from '../src/fork/config-surface.ts'
import { callSubagent, fakeAgent, modelSelectionSetupAgent, setup, testToolSignal, text } from './harness.ts'

/** One alias table entry as this suite writes it. */
type AliasEntry = NonNullable<tool.Config['models']>[number]

const FAST: AliasEntry = { alias: 'fast', provider: 'alpha', model: 'alpha-fast' }
const DEEP: AliasEntry = { alias: 'deep', provider: 'alpha', model: 'alpha-deep', reasoningEffort: 'high' }

/** The adapter capability the alias routes resolve against; `high` is declared. */
const REASONING = { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] } as const

/** The tool's required projection seam, as the upstream suites set it up. */
async function projectedContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  return ctx
}

/** Register one request-capturing provider with the capabilities the fork rows need. */
function registerCaptureProvider(ctx: Context, requests: SubagentStartRequest[], continuable = false): void {
  ctx.subagents.registerProvider({
    name: 'capture',
    capabilities: { agentOptions: true, outputSchema: false, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: false,
    ...continuable ? { prepareContinuable: async () => ({}) } : {},
    start: async (request) => {
      requests.push(request)
      return {
        id: SessionId(`capture-child-${requests.length}`),
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' as const }),
        dispose: async () => {},
      }
    },
  })
}

/** Mount the real tool over a capture provider through the Loader (schema + apply). */
async function captureSetup(
  config: Omit<tool.Config, 'provider'>,
  options: { continuable?: boolean; background?: boolean } = {},
) {
  const requests: SubagentStartRequest[] = []
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SubagentRuntime)
  if (options.background === true) {
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(ToolTasks, {})
  }
  registerCaptureProvider(ctx, requests, options.continuable === true)
  await ctx.plugin(tool, { provider: 'capture', ...config })
  return { ctx, requests }
}

/** Mount the tool on a service-only context through a direct `apply()` (no Schemastery). */
async function applyContext(): Promise<Context> {
  const ctx = await projectedContext()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SubagentRuntime)
  registerCaptureProvider(ctx, [])
  return ctx
}

/** A live parent with a dedicated scope fiber, as the background suite builds one. */
function ownerAgent(ctx: Context, sessionId: string): Agent {
  const scopeFiber = ctx.plugin(() => {})
  const id = SessionId(sessionId)
  const agent = {
    id,
    ctx: scopeFiber.ctx,
    inject: () => {},
    options: {},
    session: Session.create(id),
  } as unknown as Agent
  ctx.agents.register(agent)
  return agent
}

let callCounter = 0

/** Execute one named delegation tool through the real ToolRuntime pipeline. */
function callTool(ctx: Context, name: string, args: unknown, agent: Agent = fakeAgent()) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`fork-call-${++callCounter}`),
    name,
    arguments: args,
    agent,
  })
}

/** The registered tool's parameter properties, optionally in one Agent's scope. */
function parametersOf(ctx: Context, agent?: Agent, name = 'subagent'): Record<string, unknown> {
  const schema = ctx.tools.schemas(agent).find(entry => entry.name === name)
  if (schema === undefined) throw new Error(`no registered tool named "${name}"`)
  return (schema.parameters as { properties?: Record<string, unknown> }).properties ?? {}
}

/** The registered tool's model-facing description. */
function descriptionOf(ctx: Context, name = 'subagent'): string {
  const schema = ctx.tools.schemas().find(entry => entry.name === name)
  if (schema === undefined) throw new Error(`no registered tool named "${name}"`)
  return schema.description
}

describe('fork model-alias face', () => {
  /** Register the adapter every alias route in this suite resolves against. */
  function registerAlpha(ctx: Context): void {
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))
  }

  it('replaces the route parameters with one alias parameter and resolves an explicit alias', async () => {
    const { ctx, requests } = await captureSetup({ models: [FAST, DEEP], defaultModel: 'fast' })
    registerAlpha(ctx)

    const props = parametersOf(ctx)
    expect(Object.keys(props).sort()).toEqual(['description', 'model', 'prompt', 'run_in_background'])
    expect((props.model as { description?: string }).description).toContain('Allowed: fast, deep.')
    const description = descriptionOf(ctx)
    expect(description).toContain('Child model routing uses a fixed alias whitelist: fast, deep.')
    expect(description).toContain('Omit `model` to use fast; any other value is rejected.')
    // Provider and exact model ids never reach the model surface.
    expect(description).not.toContain('alpha-fast')
    expect(description).not.toContain('alpha-deep')
    expect(description).not.toContain('list_subagent_models')
    expect(ctx.tools.get('list_subagent_models')).toBeUndefined()

    const result = await callSubagent(ctx, { description: 'd', prompt: 'p', model: 'deep' })
    expect(result.isError).toBe(false)
    expect(requests[0]?.agentOptions).toEqual({
      provider: 'alpha',
      model: 'alpha-deep',
      reasoningEffort: 'high',
    })
  })

  it('defaults to `defaultModel`, and to the first entry when that key is omitted', async () => {
    const explicit = await captureSetup({ models: [FAST, DEEP], defaultModel: 'deep' })
    registerAlpha(explicit.ctx)
    expect((await callSubagent(explicit.ctx, { description: 'd', prompt: 'p' })).isError).toBe(false)
    expect(explicit.requests[0]?.agentOptions).toEqual({
      provider: 'alpha',
      model: 'alpha-deep',
      reasoningEffort: 'high',
    })

    const implicit = await captureSetup({ models: [FAST, DEEP] })
    registerAlpha(implicit.ctx)
    expect((await callSubagent(implicit.ctx, { description: 'd', prompt: 'p' })).isError).toBe(false)
    // The default alias declares no effort, so none is materialized.
    expect(implicit.requests[0]?.agentOptions).toEqual({ provider: 'alpha', model: 'alpha-fast' })
  })

  it('rejects an alias outside the instance table and enumerates the allowed ones', async () => {
    const { ctx, requests } = await captureSetup({ models: [FAST], defaultModel: 'fast' })
    registerAlpha(ctx)

    const result = await callSubagent(ctx, { description: 'd', prompt: 'p', model: 'deep' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(
      'child model alias "deep" is not allowed for this tool instance (allowed: fast)',
    )
    expect(requests).toEqual([])
  })

  it('rejects an empty alias value instead of falling back to the default', async () => {
    const { ctx } = await captureSetup({ models: [FAST] })
    registerAlpha(ctx)

    const result = await callSubagent(ctx, { description: 'd', prompt: 'p', model: '' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('child `model` must be a non-empty alias when present')
  })

  it('authorizes only the aliases each loaded row declares (per-row subset)', async () => {
    const { ctx, requests } = await captureSetup({
      models: [FAST],
      defaultModel: 'fast',
      toolName: 'subagent_fast',
    })
    registerAlpha(ctx)
    await ctx.plugin(tool, {
      provider: 'capture',
      toolName: 'subagent_deep',
      models: [DEEP],
      defaultModel: 'deep',
    })

    // Row A rejects row B's alias, naming only its own.
    const wrongRow = await callTool(ctx, 'subagent_fast', { description: 'd', prompt: 'p', model: 'deep' })
    expect(wrongRow.isError).toBe(true)
    expect(text(wrongRow)).toContain('is not allowed for this tool instance (allowed: fast)')
    // Row B accepts it, and its own default differs.
    const rightRow = await callTool(ctx, 'subagent_deep', { description: 'd', prompt: 'p', model: 'deep' })
    expect(rightRow.isError).toBe(false)
    expect(requests[0]?.agentOptions).toEqual({
      provider: 'alpha',
      model: 'alpha-deep',
      reasoningEffort: 'high',
    })

    const defaultRow = await callTool(ctx, 'subagent_deep', { description: 'd', prompt: 'p' })
    expect(defaultRow.isError).toBe(false)
    expect(requests[1]?.agentOptions).toEqual({
      provider: 'alpha',
      model: 'alpha-deep',
      reasoningEffort: 'high',
    })
  })

  it('lets the alias route own provider/model/effort while configured non-route options survive', async () => {
    const { ctx, requests } = await captureSetup({
      models: [FAST],
      defaultModel: 'fast',
      agentOptions: { reasoningEffort: ReasoningEffortId('low'), maxTokens: 321 },
    })
    registerAlpha(ctx)

    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(result.isError).toBe(false)
    // The configured effort belongs to the configured route: the alias without
    // one uses the model default instead of inheriting it.
    expect(requests[0]?.agentOptions).toEqual({
      maxTokens: 321,
      provider: 'alpha',
      model: 'alpha-fast',
    })
  })

  it('preflights the resolved alias route against the live adapter before the child starts', async () => {
    // No adapter is registered for `alpha`, so the route cannot resolve.
    const { ctx, requests } = await captureSetup({ models: [FAST] })
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(result.isError).toBe(true)
    expect(requests).toEqual([])
  })

  it('fails loud at mount when the provider cannot apply child agentOptions (the route is always set)', async () => {
    const ctx = await projectedContext()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    ctx.subagents.registerProvider({
      name: 'no-options',
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: true, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async () => { throw new Error('unreachable') },
    })
    await expect(ctx.plugin(tool, { provider: 'no-options', models: [FAST] }))
      .rejects.toThrow('does not support child agentOptions')
  })
})

describe('fork alias-table load validation', () => {
  it('rejects an empty alias table', async () => {
    await expect(captureSetup({ models: [] }))
      .rejects.toThrow('`models` must list at least one alias entry')
  })

  it('rejects a duplicate alias', async () => {
    await expect(captureSetup({ models: [FAST, { ...FAST, model: 'alpha-other' }] }))
      .rejects.toThrow('`models` repeats alias "fast"')
  })

  it('rejects a `defaultModel` outside the table', async () => {
    await expect(captureSetup({ models: [FAST], defaultModel: 'deep' }))
      .rejects.toThrow('`defaultModel` "deep" is not in `models` (allowed: fast)')
  })

  it.each([
    { label: 'an empty alias', entry: { ...FAST, alias: '' }, message: 'each `models` alias must be a non-empty string' },
    { label: 'an empty provider', entry: { ...FAST, provider: '' }, message: 'model "fast" provider must be a non-empty string' },
    { label: 'an empty model', entry: { ...FAST, model: '' }, message: 'model "fast" model must be a non-empty string' },
    {
      label: 'an empty reasoningEffort',
      entry: { ...FAST, reasoningEffort: '' },
      message: 'model "fast" reasoningEffort must be a non-empty string when present',
    },
  ])('rejects $label', async ({ entry, message }) => {
    await expect(captureSetup({ models: [entry] })).rejects.toThrow(message)
  })

  it('rejects an unknown key inside a `models` entry (a typo must not widen the routing)', async () => {
    await expect(captureSetup({
      models: [{ ...FAST, reasoningEffortt: 'high' } as unknown as AliasEntry],
    })).rejects.toThrow('a `models` entry has unknown key(s) "reasoningEffortt" (allowed: alias, provider, model, reasoningEffort)')
  })

  it('rejects `models` combined with `modelSelectionSettings` (two conflicting authorization paths)', async () => {
    await expect(captureSetup({ models: [FAST], modelSelectionSettings: true }))
      .rejects.toThrow('`models` and `modelSelectionSettings: true` both authorize child model routes')
  })

  it('validates the same rules when apply() bypasses Schemastery', async () => {
    const ctx = await applyContext()
    // Direct apply carries unvalidated values: non-object entries, non-array
    // tables, and non-string aliases all have to be rejected here too.
    expect(() => { tool.apply(ctx, { provider: 'capture', models: [] }) })
      .toThrow('`models` must list at least one alias entry')
    expect(() => {
      tool.apply(ctx, { provider: 'capture', models: ['fast'] as unknown as AliasEntry[] })
    }).toThrow('each `models` entry must be an object')
    expect(() => {
      tool.apply(ctx, { provider: 'capture', models: [{ alias: 1, provider: 'alpha', model: 'm' } as unknown as AliasEntry] })
    }).toThrow('each `models` alias must be a non-empty string')
    expect(() => { tool.apply(ctx, { provider: 'capture', models: [FAST], modelSelectionSettings: true }) })
      .toThrow('both authorize child model routes')
  })
})

describe('fork per-child workspace and skill scope', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  /** A fresh directory that exists at load time; removed after the test. */
  function tempDir(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-tool-subagent-fork-'))
    roots.push(root)
    return root
  }

  it('carries cwd and skillFilter onto the foreground start request', async () => {
    const cwd = tempDir()
    const { ctx, requests } = await captureSetup({ cwd, skillFilter: { deny: ['beta'] } })

    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(result.isError).toBe(false)
    expect(requests[0]?.cwd).toBe(cwd)
    expect(requests[0]?.skillFilter).toEqual({ deny: ['beta'] })
  })

  it('carries cwd and skillFilter onto the one-shot background start request', async () => {
    const cwd = tempDir()
    const { ctx, requests } = await captureSetup(
      { cwd, skillFilter: { allow: ['alpha', 'gamma'] } },
      { background: true },
    )
    const parent = ownerAgent(ctx, 'fork-background-parent')

    const started = await callTool(
      ctx,
      'subagent',
      { description: 'd', prompt: 'p', run_in_background: true },
      parent,
    )
    expect(text(started)).toContain('started background subagent job')
    await vi.waitFor(() => { expect(requests.length).toBe(1) })
    expect(requests[0]?.cwd).toBe(cwd)
    expect(requests[0]?.skillFilter).toEqual({ allow: ['alpha', 'gamma'] })
  })

  it('carries cwd and skillFilter onto the continuable start spec', async () => {
    // All three start paths build one request object; the continuable path hands
    // it to `startContinuable`, so the spec is what proves the third path.
    const specs: ContinuableStartSpec[] = []
    const startContinuable = vi.spyOn(SubagentRuntime.prototype, 'startContinuable')
      .mockImplementation(async (spec) => {
        specs.push(spec)
        return { childId: SessionId('stub-continuable-child'), messageId: MessageId('stub-message') }
      })
    try {
      const cwd = tempDir()
      const { ctx } = await captureSetup(
        { cwd, skillFilter: { deny: ['beta'] }, backgroundMode: 'continuable' },
        { continuable: true },
      )

      const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })
      expect(result.isError).toBe(false)
      expect(specs[0]?.request.cwd).toBe(cwd)
      expect(specs[0]?.request.skillFilter).toEqual({ deny: ['beta'] })
    } finally {
      startContinuable.mockRestore()
    }
  })

  it('carries a full role row (alias + cwd + skillFilter) onto one request', async () => {
    // The deployment shape this patch exists for: one named row per role, with
    // its own alias subset, workspace, and skill scope.
    const cwd = tempDir()
    const { ctx, requests } = await captureSetup({
      toolName: 'subagent_role',
      models: [DEEP],
      defaultModel: 'deep',
      cwd,
      skillFilter: { allow: ['lark-doc'] },
    })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))

    const result = await callTool(ctx, 'subagent_role', { description: 'd', prompt: 'p' })
    expect(result.isError).toBe(false)
    expect(requests[0]?.agentOptions).toEqual({
      provider: 'alpha',
      model: 'alpha-deep',
      reasoningEffort: 'high',
    })
    expect(requests[0]?.cwd).toBe(cwd)
    expect(requests[0]?.skillFilter).toEqual({ allow: ['lark-doc'] })
  })

  it('rejects a relative cwd at load', async () => {
    await expect(captureSetup({ cwd: 'relative/path' }))
      .rejects.toThrow('`cwd` must be an absolute path (got "relative/path")')
  })

  it('rejects a cwd that does not exist', async () => {
    const missing = path.join(tempDir(), 'missing')
    await expect(captureSetup({ cwd: missing }))
      .rejects.toThrow(`\`cwd\` "${missing}" must be an existing directory`)
  })

  it('rejects a cwd that names a file rather than a directory', async () => {
    const file = path.join(tempDir(), 'not-a-directory.txt')
    writeFileSync(file, 'x')
    await expect(captureSetup({ cwd: file }))
      .rejects.toThrow(`\`cwd\` "${file}" must be an existing directory`)
  })

  it('rejects a non-string and an empty cwd when apply() bypasses Schemastery', async () => {
    // Schemastery rejects both shapes on the loader path; direct apply() carries
    // them verbatim, so the resolver has to reject them itself.
    const ctx = await applyContext()
    expect(() => {
      tool.apply(ctx, { provider: 'capture', cwd: 42 as unknown as string })
    }).toThrow('`cwd` must be a non-empty absolute path when present')
    expect(() => {
      tool.apply(ctx, { provider: 'capture', cwd: '' })
    }).toThrow('`cwd` must be a non-empty absolute path when present')
  })

  it.each([
    { label: 'both directions', filter: { allow: ['a'], deny: ['b'] }, message: 'cannot name both `allow` and `deny`' },
    { label: 'neither direction', filter: {}, message: 'names neither `allow` nor `deny`' },
    { label: 'an unknown key', filter: { allowlist: ['a'] }, message: 'has unknown key(s) "allowlist" (allowed: allow, deny)' },
  ])('rejects skillFilter naming $label', async ({ filter, message }) => {
    await expect(captureSetup({ skillFilter: filter }))
      .rejects.toThrow(message)
  })

  it.each([
    { label: 'null', value: null },
    { label: 'an array', value: ['a'] },
    { label: 'a scalar', value: 'a' },
  ])('rejects a skillFilter of $label when apply() bypasses Schemastery', async ({ value }) => {
    // Schemastery rejects the malformed shapes below on the loader path; direct
    // apply() carries them verbatim, so the resolver has to reject them itself.
    const ctx = await applyContext()
    expect(() => {
      tool.apply(ctx, { provider: 'capture', skillFilter: value as unknown as NonNullable<tool.Config['skillFilter']> })
    }).toThrow('`skillFilter` must be an object naming exactly one of `allow` or `deny`')
  })

  it('rejects a non-array and a non-string skillFilter member by name', async () => {
    const ctx = await applyContext()
    expect(() => {
      tool.apply(ctx, { provider: 'capture', skillFilter: { allow: 'a' } as unknown as NonNullable<tool.Config['skillFilter']> })
    }).toThrow('`skillFilter` `allow` must be an array of skill names when present')
    expect(() => {
      tool.apply(ctx, { provider: 'capture', skillFilter: { deny: ['b', 7] } as unknown as NonNullable<tool.Config['skillFilter']> })
    }).toThrow('`skillFilter` `deny` must be an array of skill names when present')
  })

  it('accepts an empty allow list (restrict every skill away) but keeps it an array', async () => {
    const { ctx, requests } = await captureSetup({ skillFilter: { allow: [] } })
    expect((await callSubagent(ctx, { description: 'd', prompt: 'p' })).isError).toBe(false)
    expect(requests[0]?.skillFilter).toEqual({ allow: [] })
  })
})

describe('fork invariant: an instance without `models` keeps upstream behavior', () => {
  it('keeps upstream\'s parameter face and none of the alias wording', async () => {
    // Control: `model-selection.spec.ts` asserts the same three keys for a
    // selection-disabled upstream instance.
    const { ctx } = await captureSetup({ enableRunInBackground: false })
    expect(Object.keys(parametersOf(ctx)).sort()).toEqual(['description', 'prompt'])
    const description = descriptionOf(ctx)
    expect(description).not.toContain('alias')
    expect(description).not.toContain('list_subagent_models')
  })

  it('exposes upstream\'s route fields when modelSelectionSettings is on', async () => {
    // The alias branch must not pre-empt the session-policy branch. Control:
    // `model-selection.spec.ts` asserts the same six keys through this harness.
    const ctx = await setup({ provider: 'mock', withModelSelection: true })
    expect(Object.keys(parametersOf(ctx, modelSelectionSetupAgent(ctx))).sort()).toEqual([
      'description',
      'model',
      'prompt',
      'provider',
      'reasoning_effort',
      'run_in_background',
    ])
  })

  it('materializes no fork fields on the start request', async () => {
    const { ctx, requests } = await captureSetup({})
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(result.isError).toBe(false)
    expect(requests[0]).not.toHaveProperty('cwd')
    expect(requests[0]).not.toHaveProperty('skillFilter')
    // Control: `tool-subagent.spec.ts` pins the same omission for agentOptions.
    expect(requests[0]).not.toHaveProperty('agentOptions')
  })

  it('still treats a bare `model` argument as a route field, not an alias', async () => {
    // Control: `model-selection.spec.ts` pins this refusal for upstream.
    const { ctx, requests } = await captureSetup({})
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p', model: 'fast' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('child model selection is disabled for this tool instance')
    expect(requests).toEqual([])
  })

  it('does not require the `llm` service for a plain delegation (no route preflight)', async () => {
    const requests: SubagentStartRequest[] = []
    const ctx = await projectedContext()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SubagentRuntime)
    registerCaptureProvider(ctx, requests)
    await ctx.plugin(tool, { provider: 'capture' })

    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(result.isError).toBe(false)
    expect(requests.length).toBe(1)
  })
})

/**
 * Every key `Config` declares: upstream's nine plus the fork patch's four.
 * Cordis resolves plugin config through Schemastery's NON-strict object schema
 * (`if (!strict) merge(result, data)`), so an undeclared top-level key reaches
 * `apply()` instead of being rejected: a preset row spelling `models` as
 * `modelz` mounted the upstream face — no `model` parameter, `defaultModel`
 * inert, children inheriting the parent route — with no trace at all.
 */
const DECLARED_CONFIG_KEYS = [
  'provider',
  'toolName',
  'modelSelectionSettings',
  'enableRunInBackground',
  'backgroundMode',
  'agentOptions',
  'persona',
  'toolFilter',
  'maxDepth',
  'models',
  'defaultModel',
  'cwd',
  'skillFilter',
]

/** The guard's `(allowed: ...)` list, in message order. */
function allowedFrom(message: string): string[] {
  const match = /\(allowed: (.*)\)$/.exec(message)
  if (match === null) throw new Error(`no allowed list in: ${message}`)
  return match[1]!.split(', ')
}

describe('fork config-surface guard', () => {
  it('rejects an unknown top-level key at mount, naming it with the allowed set', async () => {
    const rejection = await captureSetup({ modelz: [FAST] } as unknown as Omit<tool.Config, 'provider'>)
      .then(() => { throw new Error('expected the mount to fail') }, (error: unknown) => error)
    if (!(rejection instanceof Error)) throw new Error(`expected an Error rejection, got ${String(rejection)}`)
    expect(rejection.message).toContain('tool-subagent: unknown config key(s) "modelz"')
    const allowed = allowedFrom(rejection.message)
    // Every declared key stays allowed, so a legal upstream config still mounts.
    expect(allowed).toEqual(expect.arrayContaining(DECLARED_CONFIG_KEYS))
    // The set is the schema's own declared-key map, so an upstream key added to
    // `Config` widens it with no edit to the guard.
    expect([...allowed].sort()).toEqual(Object.keys(tool.Config.dict ?? {}).sort())
  })

  it('rejects the same typo when apply() bypasses Schemastery', async () => {
    const ctx = await applyContext()
    expect(() => {
      tool.apply(ctx, { provider: 'capture', modelz: [] } as unknown as tool.Config)
    }).toThrow('tool-subagent: unknown config key(s) "modelz"')
  })

  it('derives the allowed set from the schema and keeps a complete literal fallback', () => {
    // Derived path: the schema's own declared-key map is used verbatim, so a
    // future upstream key is accepted with no edit to the guard.
    const dict = Object.fromEntries(DECLARED_CONFIG_KEYS.map(key => [key, {}]))
    expect([...allowedConfigKeys({ ...dict, futureUpstreamKey: {} })])
      .toEqual([...DECLARED_CONFIG_KEYS, 'futureUpstreamKey'])
    // Defensive path: a Schemastery that stops exposing `dict` still accepts
    // every key `Config` declares today (the list must be kept in sync).
    expect([...allowedConfigKeys(undefined)].sort()).toEqual([...DECLARED_CONFIG_KEYS].sort())
  })

  it('mounts an upstream-only config (no fork key present)', async () => {
    const { ctx, requests } = await captureSetup({
      toolName: 'subagent_plain',
      modelSelectionSettings: false,
      enableRunInBackground: false,
      backgroundMode: 'one-shot',
      agentOptions: { maxTokens: 128 },
      persona: 'plain persona',
      toolFilter: { deny: ['bash'] },
      maxDepth: 2,
    })
    const result = await callTool(ctx, 'subagent_plain', { description: 'd', prompt: 'p' })
    expect(result.isError).toBe(false)
    expect(requests.length).toBe(1)
    // No fork field is materialized: the upstream request shape is untouched.
    expect(requests[0]).not.toHaveProperty('cwd')
    expect(requests[0]).not.toHaveProperty('skillFilter')
  })

  it('rejects `defaultModel` without `models` (the same typo, one key over)', async () => {
    await expect(captureSetup({ defaultModel: 'fast' })).rejects.toThrow(
      'tool-subagent: `defaultModel` is configured without `models`',
    )
    const ctx = await applyContext()
    expect(() => {
      tool.apply(ctx, { provider: 'capture', defaultModel: 'fast' })
    }).toThrow('tool-subagent: `defaultModel` is configured without `models`')
  })
})
