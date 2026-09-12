/**
 * Fork-module unit coverage for the rewrite cut rules: which admission
 * splices the backward walk may cross, and which retained pending entry the
 * inbox repair has to neutralize. The host integration spec owns the durable
 * post-state; this spec pins the pure decisions for layouts that are hard to
 * produce through a live agent.
 */

import { describe, expect, it } from 'vitest'
import { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { planInboxRepair, resolveRewriteCut } from '../src/fork/rewrite-history.ts'

/** One admitted message with a controlled id (the fold matches on the id). */
const message = (id: string): { id: string } => ({ id })

const splice = (
  seq: number,
  start: number,
  inserted: readonly { id: string }[],
  removedCount?: number,
  target: 'next-turn' | 'next-step' = 'next-turn',
): SessionEvent => ({
  type: 'agent/inbox/spliced',
  seq: SessionSeq(seq),
  time: seq,
  data: { target, start, ...(removedCount === undefined ? {} : { removedCount }), inserted },
} as SessionEvent)

const turnStart = (seq: number, turn: number): SessionEvent =>
  ({ type: 'turn/start', seq: SessionSeq(seq), time: seq, data: { turn } })

const turnEnd = (seq: number, turn: number): SessionEvent => ({
  type: 'turn/end',
  seq: SessionSeq(seq),
  time: seq,
  data: { turn, reason: { kind: 'completed' } },
})

const userMessage = (seq: number, id: string): SessionEvent => ({
  type: 'user/message',
  seq: SessionSeq(seq),
  time: seq,
  surfaceOp: 'append',
  data: { id, role: 'user', content: [{ type: 'text', text: id }], source: { kind: 'user' } },
} as unknown as SessionEvent)

const header: Pick<SessionHeader, 'origin'> = {}

describe('resolveRewriteCut', () => {
  it("crosses only the armed message's own admission splice", () => {
    // insert(armed) -> turn/start -> user/message: the walk discards both.
    const events = [
      splice(0, 0, [message('armed')]),
      turnStart(1, 1),
      userMessage(2, 'armed'),
    ]
    expect(resolveRewriteCut(header, events, 2, SessionLogOffset(0)))
      .toEqual({ ok: true, cut: SessionLogOffset(0) })
  })

  it("stops at another message's admission splice instead of discarding it", () => {
    // Two admissions before one turn: only the armed one may be crossed, so
    // the other message keeps its place in the retained prefix.
    const events = [
      splice(0, 0, [message('other')]),
      splice(1, 1, [message('armed')]),
      turnStart(2, 1),
      userMessage(3, 'armed'),
    ]
    expect(resolveRewriteCut(header, events, 3, SessionLogOffset(0)))
      .toEqual({ ok: true, cut: SessionLogOffset(1) })
    // The retained prefix still lists the other message first, then the armed
    // one: the repair removes the armed entry at its folded index.
    expect(planInboxRepair(events, SessionLogOffset(1), 'armed')).toBeUndefined()
    expect(planInboxRepair(events, SessionLogOffset(2), 'other')).toEqual({ target: 'next-turn', start: 0 })
  })

  it('stops at a committed turn/end, leaving the armed insert for the repair', () => {
    // The queue-while-running layout: the armed insert sits inside the
    // previous turn, so the cut lands at the armed turn's start.
    const events = [
      turnStart(0, 1),
      splice(1, 0, [message('armed')]),
      turnEnd(2, 1),
      turnStart(3, 2),
      userMessage(4, 'armed'),
    ]
    expect(resolveRewriteCut(header, events, 4, SessionLogOffset(0)))
      .toEqual({ ok: true, cut: SessionLogOffset(3) })
    expect(planInboxRepair(events, SessionLogOffset(3), 'armed')).toEqual({ target: 'next-turn', start: 0 })
  })

  it('refuses an anchor below the fork-inherited prefix', () => {
    const events = [
      splice(0, 0, [message('armed')]),
      turnStart(1, 1),
      userMessage(2, 'armed'),
    ]
    expect(resolveRewriteCut(header, events, 2, SessionLogOffset(2)))
      .toEqual({ ok: false, reason: 'REWRITE_INHERITED_PREFIX' })
  })
})

describe('planInboxRepair', () => {
  it('follows the folded index across claims of other messages', () => {
    const events = [
      splice(0, 0, [message('other')]),
      splice(1, 0, [], 1, 'next-turn'),
      splice(2, 0, [message('armed')]),
      turnStart(3, 1),
      userMessage(4, 'armed'),
    ]
    expect(planInboxRepair(events, SessionLogOffset(3), 'armed')).toEqual({ target: 'next-turn', start: 0 })
  })

  it('finds a pending message under the steering target too', () => {
    const events = [
      turnStart(0, 1),
      splice(1, 0, [message('armed')], undefined, 'next-step'),
      turnEnd(2, 1),
      turnStart(3, 2),
      userMessage(4, 'armed'),
    ]
    expect(planInboxRepair(events, SessionLogOffset(3), 'armed')).toEqual({ target: 'next-step', start: 0 })
  })
})
