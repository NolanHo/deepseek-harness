import { describe, expect, it } from 'vitest'
import {
  SessionFormatError,
  SessionFormatUnsupportedMigrationError,
} from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent } from '@deepseek-ai/dsh-session-format'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  SUBAGENT_DESCRIPTOR_VERSION,
  foldSubagentDescriptor,
} from '../../../subagent/subagent/src/descriptor.ts'
import {
  CURRENT_SUBAGENT_DESCRIPTOR_VERSION,
  RELEASED_SUBAGENT_DESCRIPTOR_OPTIONAL_MEMBERS,
  upgradeReleasedSubagentDescriptor,
} from '../src/fork/subagent-descriptor-compat.ts'
import { restoreV0ToV1 } from '../src/testing/restore.ts'
import { assertReleasedEventPayload } from '../src/validation.ts'

const header = {
  type: 'session', version: 0, id: 'descriptor', createdAt: 1, delegationDepth: 0,
} as const

/** One closed v0 turn whose only payload of interest is the descriptor at seq 2. */
function sessionWith(data: Record<string, unknown>): readonly unknown[] {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    { type: 'subagent/descriptor', seq: 2, time: 3, data },
    { type: 'step/end', seq: 3, time: 4, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 4, time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/** The migrated descriptor event of {@link sessionWith}. */
function migratedDescriptor(data: Record<string, unknown>): SessionFormatEvent {
  const migrated = restoreV0ToV1(header, sessionWith(data))
  const descriptor = migrated.events[2]
  if (descriptor === undefined) throw new Error('migrated log lost its descriptor')
  return descriptor
}

/** The installed fold's reading of one migrated log. */
function foldedDescriptor(data: Record<string, unknown>) {
  return foldSubagentDescriptor(restoreV0ToV1(header, sessionWith(data)).events as unknown as SessionEvent[])
}

const event = (data: Record<string, unknown>): SessionFormatEvent => ({
  type: 'subagent/descriptor',
  seq: 2,
  time: 3,
  data: data as SessionFormatEvent['data'],
})

const CURRENT_CONTINUABLE = {
  version: CURRENT_SUBAGENT_DESCRIPTOR_VERSION,
  mode: 'continuable',
  provider: 'in-process',
  label: 'child',
  agentProvider: 'p',
  agentModel: 'm',
  agentReasoningEffort: 'high',
  persona: 'persona',
  toolFilter: { deny: ['write'] },
  cwd: '/work/child',
  skillFilter: { allow: ['review'] },
} as const

const RELEASED_V2_CONTINUABLE = {
  version: 2,
  mode: 'continuable',
  provider: 'in-process',
  label: 'child',
  agentProvider: 'p',
  agentModel: 'm',
} as const

const RELEASED_V3_ONE_SHOT = {
  version: 3,
  mode: 'one-shot',
  provider: 'spawn',
  label: 'Return ALPHA only',
} as const

const CURRENT_VERSION = CURRENT_SUBAGENT_DESCRIPTOR_VERSION

describe('released v0 subagent descriptors', () => {
  it('migrates a descriptor carrying the installed version and its composition inputs', () => {
    expect(migratedDescriptor(CURRENT_CONTINUABLE)).toEqual({
      type: 'subagent/descriptor', seq: 2, time: 3, data: CURRENT_CONTINUABLE,
    })
  })

  it('keeps the released member inventory beside the installed members', () => {
    expect(RELEASED_SUBAGENT_DESCRIPTOR_OPTIONAL_MEMBERS).toEqual([
      'label', 'agentProvider', 'agentModel', 'agentReasoningEffort', 'persona',
      'toolFilter', 'cwd', 'skillFilter',
    ])
  })

  it('upgrades a released version 2 descriptor without inventing a member', () => {
    expect(migratedDescriptor(RELEASED_V2_CONTINUABLE)).toEqual({
      type: 'subagent/descriptor', seq: 2, time: 3,
      data: { ...RELEASED_V2_CONTINUABLE, version: CURRENT_VERSION },
    })
    expect(foldedDescriptor(RELEASED_V2_CONTINUABLE)).toEqual({
      ...RELEASED_V2_CONTINUABLE, version: CURRENT_VERSION,
    })
  })

  it('upgrades a released version 3 descriptor the installed fold accepts', () => {
    expect(migratedDescriptor(RELEASED_V3_ONE_SHOT)).toEqual({
      type: 'subagent/descriptor', seq: 2, time: 3,
      data: { ...RELEASED_V3_ONE_SHOT, version: CURRENT_VERSION },
    })
    expect(foldedDescriptor(RELEASED_V3_ONE_SHOT)).toEqual({
      ...RELEASED_V3_ONE_SHOT, version: CURRENT_VERSION,
    })
  })

  it('folds every migrated descriptor with the installed subagent code', () => {
    expect(foldedDescriptor(CURRENT_CONTINUABLE)).toEqual(CURRENT_CONTINUABLE)
    expect(foldedDescriptor({ version: 2, mode: 'one-shot', provider: 'spawn', label: 'child' }))
      .toEqual({ version: CURRENT_VERSION, mode: 'one-shot', provider: 'spawn', label: 'child' })
    expect(foldedDescriptor({ version: 3, mode: 'continuable', provider: 'spawn', label: 'child' }))
      .toEqual({ version: CURRENT_VERSION, mode: 'continuable', provider: 'spawn', label: 'child' })
  })

  it('refuses a descriptor carrying a member the installed schema does not declare', () => {
    expect(() => { migratedDescriptor({ ...CURRENT_CONTINUABLE, future: true }) }).toThrow(
      new SessionFormatUnsupportedMigrationError(
        'subagent/descriptor 2 descriptor carries member "future", which the installed schema does not declare',
      ),
    )
    expect(() => { migratedDescriptor({ ...RELEASED_V2_CONTINUABLE, future: true }) }).toThrow(
      /descriptor 2 descriptor carries member "future"/,
    )
  })

  it('refuses a one-shot descriptor carrying a continuable-only member', () => {
    expect(() => { migratedDescriptor({ ...RELEASED_V3_ONE_SHOT, cwd: '/work/child' }) }).toThrow(
      /descriptor 2 descriptor carries member "cwd"/,
    )
  })

  it('refuses a descriptor version above or below the released generations', () => {
    expect(() => { migratedDescriptor({ ...CURRENT_CONTINUABLE, version: CURRENT_VERSION + 1 }) }).toThrow(
      new SessionFormatUnsupportedMigrationError(
        `subagent/descriptor 2 uses descriptor version ${CURRENT_VERSION + 1}, newer than the installed ${CURRENT_VERSION}`,
      ),
    )
    expect(() => { migratedDescriptor({ ...RELEASED_V2_CONTINUABLE, version: 1 }) }).toThrow(
      new SessionFormatUnsupportedMigrationError('subagent/descriptor 2 uses unreleased descriptor version 1'),
    )
  })

  it('refuses a descriptor version a normalized v0 payload carries beyond the admitted set', () => {
    expect(() => {
      assertReleasedEventPayload(event({ ...CURRENT_CONTINUABLE, version: CURRENT_VERSION + 1 }), 0)
    }).toThrow(new SessionFormatUnsupportedMigrationError(
      `subagent/descriptor 2 uses unsupported descriptor version ${CURRENT_VERSION + 1}`,
    ))
  })

  it('keeps the installed descriptor version in step with the subagent package', () => {
    expect(CURRENT_SUBAGENT_DESCRIPTOR_VERSION).toBe(SUBAGENT_DESCRIPTOR_VERSION)
  })
})

describe('released descriptor upgrade', () => {
  it('passes through every other event and a missing payload', () => {
    const other = { type: 'feedback/record', seq: 0, time: 1, data: { text: 'kept' } }
    expect(upgradeReleasedSubagentDescriptor(other)).toBe(other)
    expect(() => upgradeReleasedSubagentDescriptor({ ...event({}), data: undefined as never }))
      .toThrow(new SessionFormatError('subagent/descriptor 2 data must be a JSON object'))
    expect(() => upgradeReleasedSubagentDescriptor(event({ mode: 'continuable' })))
      .toThrow(new SessionFormatError('subagent/descriptor 2 version must be a non-negative safe integer'))
  })

  it('leaves the installed version and stamps the released older generations', () => {
    const current = event(CURRENT_CONTINUABLE)
    expect(upgradeReleasedSubagentDescriptor(current)).toBe(current)
    expect(upgradeReleasedSubagentDescriptor(event(RELEASED_V2_CONTINUABLE)).data)
      .toEqual({ ...RELEASED_V2_CONTINUABLE, version: CURRENT_VERSION })
    expect(upgradeReleasedSubagentDescriptor(event(RELEASED_V3_ONE_SHOT)).data)
      .toEqual({ ...RELEASED_V3_ONE_SHOT, version: CURRENT_VERSION })
  })

  it('leaves the mode check to the frozen payload rules', () => {
    expect(upgradeReleasedSubagentDescriptor(event({ version: 3, mode: 'bogus', undeclared: true })).data)
      .toEqual({ version: CURRENT_VERSION, mode: 'bogus', undeclared: true })
  })
})
