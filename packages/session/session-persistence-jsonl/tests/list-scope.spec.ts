/**
 * Stored-session list selection for the JSONL backend. One directory per
 * project holds the artifacts and carries no index, so every generation header
 * is read before the selection can be answered; an excluded artifact is then
 * never stat'ed or returned, and a created-but-unmaterialized session obeys the
 * same selection in memory.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const ROOT = SessionId('scope-root')
const FORK_CHILD = SessionId('scope-fork-child')
const SUBAGENT_CHILD = SessionId('scope-subagent-child')
const PENDING_SUBAGENT_CHILD = SessionId('scope-pending-subagent-child')

const dirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  const mounted = contexts.splice(0)
  const directories = dirs.splice(0)
  const results = await Promise.allSettled(mounted.map(ctx => ctx.fiber.dispose()))
  for (const directory of directories) await rm(directory, { recursive: true, force: true })
  const failures: unknown[] = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length > 0) throw new AggregateError(failures, 'jsonl list-scope fixture cleanup failed')
})

/** One current-format header; a fork child is seeded with the parent's lineage. */
function header(id: SessionId, createdAt: number, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id, createdAt, isSeeded: false, ...extra }
}

function subagentChild(id: SessionId, createdAt: number): SessionHeader {
  return header(id, createdAt, { parentSession: ROOT, origin: 'subagent', delegationDepth: 1 })
}

/** Stored session ids as a set, because a listing promises no order. */
function ids(snapshots: readonly SessionPersistenceSnapshot[]): Set<SessionId> {
  return new Set(snapshots.map(snapshot => snapshot.header.id))
}

async function mounted(): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-list-scope-'))
  dirs.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return ctx
}

describe('JSONL stored-session list selection', () => {
  it('applies one selection to materialized artifacts and unmaterialized sessions', async () => {
    const ctx = await mounted()
    const persistence = ctx.sessionPersistence

    const root = await persistence.create(header(ROOT, 400))
    await root.flush()
    const forkChild = await persistence.create(
      header(FORK_CHILD, 300, { isSeeded: true, parentSession: ROOT }),
      { inheritedEventCount: SessionLogOffset(0) },
    )
    await forkChild.flush()
    const subagent = await persistence.create(subagentChild(SUBAGENT_CHILD, 200))
    await subagent.flush()
    // Created but never flushed: this child has no artifact to scan.
    const pending = await persistence.create(subagentChild(PENDING_SUBAGENT_CHILD, 100))

    expect(ids(await persistence.list({ scope: 'listed' }))).toEqual(new Set([ROOT, FORK_CHILD]))
    expect(ids(await persistence.list({ parentSessionId: ROOT }))).toEqual(new Set([
      FORK_CHILD,
      SUBAGENT_CHILD,
      PENDING_SUBAGENT_CHILD,
    ]))
    expect(ids(await persistence.list())).toEqual(new Set([
      ROOT,
      FORK_CHILD,
      SUBAGENT_CHILD,
      PENDING_SUBAGENT_CHILD,
    ]))

    await pending.close()
    await subagent.close()
    await forkChild.close()
    await root.close()
  })
})
