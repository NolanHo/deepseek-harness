/**
 * SessionSnapshotIdentity: entry-object reuse, eviction of departed rows, and
 * the linear-time cleanup sweep (the list is one row per Session, so its size
 * grows with the whole store, not with the visible window).
 */

import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { SessionSnapshotIdentity } from '../src/client/sessions/fork/snapshot-identity.ts'
import type { SessionListEntry } from '../src/client/sessions/lineage.ts'

const entry = (id: string, updatedAt = 1): SessionListEntry => ({
  sessionId: id as SessionId, updatedAt, running: false, blank: false, completed: false, depth: 0,
})

describe('session-list snapshot identity', () => {
  it('reuses the previous entry object, and the items array, while content holds', () => {
    const identity = new SessionSnapshotIdentity()
    const first = identity.stableEntries([entry('a'), entry('b')])
    const second = identity.stableEntries([entry('a'), entry('b')])
    expect(second).toBe(first)
    expect(second[0]).toBe(first[0])
  })

  it('mints a new entry object after the row left the list and returned', () => {
    const identity = new SessionSnapshotIdentity()
    const first = identity.stableEntries([entry('a'), entry('b')])
    const shrunk = identity.stableEntries([entry('a')])
    expect(shrunk.map(e => e.sessionId)).toEqual(['a'])
    expect(shrunk[0]).toBe(first[0])
    const returned = entry('b')
    const regrown = identity.stableEntries([entry('a'), returned])
    expect(regrown[1]).toBe(returned)
    expect(regrown[1]).not.toBe(first[1])
  })

  it('drops every departed row, including the last one in the cache', () => {
    const identity = new SessionSnapshotIdentity()
    const first = identity.stableEntries([entry('a'), entry('b'), entry('c')])
    identity.stableEntries([])
    // A row still in the identity cache would come back as the old object;
    // minting a fresh one is the eviction probe.
    const recreated = entry('c')
    const regrown = identity.stableEntries([recreated])
    expect(regrown[0]).toBe(recreated)
    expect(regrown[0]).not.toBe(first[2])
  })

  it('stays linear in the session count: no row-list scan per cached id', () => {
    let reads = 0
    const counted = (id: string): SessionListEntry => {
      const row = entry(id)
      Object.defineProperty(row, 'sessionId', {
        configurable: true,
        enumerable: true,
        get() {
          reads += 1
          return id as SessionId
        },
      })
      return row
    }
    const identity = new SessionSnapshotIdentity()
    const rows = Array.from({ length: 3_000 }, (_, i) => counted(`session-${i}`))
    identity.stableEntries(rows)
    reads = 0
    identity.stableEntries(rows)
    // Two id reads per row — the reuse lookup and the live-id set. Deciding
    // "still listed" by scanning the row list once per cached id reads it
    // n + n(n+1)/2 times at this size, which is the cost this pins out.
    expect(reads).toBeLessThan(rows.length * 4)
  })
})
