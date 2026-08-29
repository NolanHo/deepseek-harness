import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { childSessionMeta, resolveChildAgentOptions } from '../src/child-agent.ts'

function parentAgent(): Agent {
  const id = SessionId('parent')
  return {
    id,
    options: {
      provider: 'parent-provider',
      model: 'parent-model',
      reasoningEffort: ReasoningEffortId('high'),
      maxTokens: 512,
    },
    session: Session.create(id),
  } as Agent
}

/** A parent carrying a live context, so `childSessionMeta` can consult services. */
function contextfulParent(): Agent {
  return { ...parentAgent(), ctx: new Context() } as Agent
}

describe('child Agent options', () => {
  it('inherits the parent effort while the exact route is unchanged', () => {
    expect(resolveChildAgentOptions(parentAgent(), undefined, 1)).toEqual({
      provider: 'parent-provider',
      model: 'parent-model',
      reasoningEffort: 'high',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('clears an inherited effort when the child route changes', () => {
    expect(resolveChildAgentOptions(parentAgent(), { model: 'child-model' }, 1)).toEqual({
      provider: 'parent-provider',
      model: 'child-model',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('keeps an explicit child effort when the child route changes', () => {
    expect(resolveChildAgentOptions(parentAgent(), {
      provider: 'child-provider',
      model: 'child-model',
      reasoningEffort: ReasoningEffortId('max'),
    }, 1)).toEqual({
      provider: 'child-provider',
      model: 'child-model',
      reasoningEffort: 'max',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('inherits the latest logged request selection over creation-time values', () => {
    const parent = parentAgent()
    parent.session.append('request/header', {
      header: {
        config: {
          provider: 'current-provider',
          model: 'current-model',
          reasoningEffort: ReasoningEffortId('low'),
        },
      },
      reason: 'initial',
    })

    expect(resolveChildAgentOptions(parent, undefined, 1)).toEqual({
      provider: 'current-provider',
      model: 'current-model',
      reasoningEffort: 'low',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })
})

describe('child session metadata cwd', () => {
  it('stamps a requested cwd into the child creation metadata', () => {
    expect(childSessionMeta(contextfulParent(), 1, 0, '/child-workspace')).toMatchObject({
      cwd: '/child-workspace',
      parentSession: SessionId('parent'),
      origin: 'subagent',
      delegationDepth: 1,
    })
  })

  it('omits cwd when neither the request nor the parent header carries one', () => {
    const meta = childSessionMeta(contextfulParent(), 1, 0)
    expect(meta.cwd).toBeUndefined()
    expect(meta.parentSession).toBe(SessionId('parent'))
  })

  it('rejects a requested cwd that is not absolute', () => {
    expect(() => childSessionMeta(contextfulParent(), 1, 0, 'relative/path'))
      .toThrow('child session cwd must be an absolute path')
    expect(() => childSessionMeta(contextfulParent(), 1, 0, 'relative/path'))
      .toThrow('got "relative/path"')
  })
})
