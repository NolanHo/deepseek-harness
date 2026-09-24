/**
 * A child's own descriptor establishes its durable identity through the
 * generation it was written with: a restored historical log carries a released
 * generation, and reading it there is what keeps the child openable.
 */

import { SessionSeq } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldSubagentDescriptor } from '../src/descriptor.ts'
import { foldReleasedDescriptorIdentity } from '../src/fork/released-descriptor-identity.ts'
import { subagentIdentityProjectionDefinition } from '../src/projection.ts'

/** One descriptor event at seq 4, carrying the payload a stored log serves. */
function descriptorEvent(data: unknown): SessionEvent<'subagent/descriptor'> {
  // A stored log keeps the generation its writer stamped, so a released payload
  // is asserted at this one durable-read boundary instead of in every case.
  return { type: 'subagent/descriptor', seq: SessionSeq(4), time: 10,
    data: data as SessionEvent<'subagent/descriptor'>['data'] }
}

/** The identity the registered `subagent` projection serves for one payload. */
function identityOf(data: unknown): unknown {
  const definition = subagentIdentityProjectionDefinition
  const state = definition.apply(definition.init(), descriptorEvent(data))
  return definition.wire.view(state)
}

describe('released descriptor identity', () => {
  it('serves the identity a released one-shot child declares', () => {
    expect(identityOf({ version: 3, mode: 'one-shot', provider: 'spawn', label: 'historical child' }))
      .toEqual({ mode: 'one-shot', label: 'historical child', seq: 4 })
  })

  it('serves the identity a released continuable child declares', () => {
    // The resume composition is absent from a released payload, so only the
    // identity members the generation carries reach the projection.
    expect(identityOf({ version: 2, mode: 'continuable', provider: 'spawn', label: 'child task', agentModel: 'm' }))
      .toEqual({ mode: 'continuable', label: 'child task', seq: 4 })
  })

  it('keeps serving the installed generation', () => {
    expect(identityOf({ version: 4, mode: 'one-shot', provider: 'spawn', label: 'native child' }))
      .toEqual({ mode: 'one-shot', label: 'native child', seq: 4 })
  })

  it('serves no identity for a generation without the mode field', () => {
    expect(identityOf({ version: 1, provider: 'spawn', label: 'child' })).toBeNull()
  })

  it('serves no identity for a generation newer than the installed one', () => {
    expect(identityOf({ version: 5, mode: 'one-shot', provider: 'spawn' })).toBeNull()
  })

  it('serves no identity for a released payload the installed schema refuses', () => {
    // An undeclared member is damage the installed fold reports for its own
    // generation; a released payload carrying one establishes nothing either.
    const damaged = { version: 3, mode: 'one-shot', provider: 'spawn', undeclared: true }
    expect(identityOf(damaged)).toBeNull()
    expect(identityOf({ version: 3, mode: 'invalid', provider: 'spawn' })).toBeNull()
  })

  it('reads no identity from a non-descriptor event or a non-numeric version', () => {
    expect(foldReleasedDescriptorIdentity({ type: 'turn/end', seq: SessionSeq(1), time: 1,
      data: { turn: 1, reason: { kind: 'completed' } } })).toBeUndefined()
    expect(foldReleasedDescriptorIdentity(descriptorEvent({
      version: Number.NaN, mode: 'one-shot', provider: 'spawn',
    }))).toBeUndefined()
  })

  it('leaves the strict fold refusing a released generation for resume', () => {
    const released = descriptorEvent({ version: 3, mode: 'continuable', provider: 'spawn', label: 'child task' })
    expect(foldSubagentDescriptor([released])).toBeUndefined()
  })
})
