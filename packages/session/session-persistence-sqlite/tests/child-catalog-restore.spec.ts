/**
 * Historical V3 restore binds the parent's complete direct-child evidence,
 * collected from this database's own session and event rows: a child the parent
 * already lists is retained, a missing one is backfilled from the descriptor the
 * installed subagent package wrote, and a child whose own evidence this store
 * cannot read degrades to unknown-mode membership instead of refusing the parent.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SESSION_FORMAT_VERSION, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { DEFAULT_BUSY_TIMEOUT_MS } from '@deepseek-ai/dsh-session-persistence-sqlite'
import { SqliteStore } from '../src/store.ts'
import { testSql } from './test-sql.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** One fresh database path inside a directory this suite removes afterwards. */
async function freshDbPath(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(directory)
  return join(directory, 'sessions.db')
}

/** Seed the frozen schema-19 shell with the corpus whose two children the parent already lists. */
async function writeListedChildrenFixture(): Promise<string> {
  const path = await freshDbPath('dsh-sqlite-child-listed-')
  const seed = new DatabaseSync(path)
  seed.exec(testSql('create-schema-19-db'))
  seed.exec(testSql('insert-v3-listed-children'))
  seed.close()
  await chmod(path, 0o600)
  return path
}

/** Seed the frozen schema-19 shell with the corpus whose parent lists none of its children. */
async function writeBackfillChildrenFixture(): Promise<string> {
  const path = await freshDbPath('dsh-sqlite-child-backfill-')
  const seed = new DatabaseSync(path)
  seed.exec(testSql('create-schema-19-db'))
  seed.exec(testSql('insert-v3-backfill-children'))
  seed.close()
  await chmod(path, 0o600)
  return path
}

function openStore(path: string): SqliteStore {
  return new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
}

/** The catalog entries one restored log carries, in restored order. */
function catalogEntries(events: readonly SessionEvent[]): unknown[] {
  return events.filter(event => event.type === 'subagent/catalog').map(event => event.data)
}

describe('historical V3 restore child evidence', () => {
  it('retains a listed child and collects only the parent own direct subagent children', async () => {
    const path = await writeListedChildrenFixture()
    const store = openStore(path)
    const restored = await store.loadStoredLog(SessionId('v3-listed-parent'))
    if (restored === undefined) throw new Error('the listed parent did not load')

    expect(restored.storedVersion).toBe(3)
    expect(restored.meta.version).toBe(SESSION_FORMAT_VERSION)
    // Every child the parent already lists stays exactly as recorded; the two
    // rows that carry descriptors but are not this parent's direct subagent
    // children — another parent's child and an unowned forked session — never
    // reach this catalog.
    expect(restored.events.map(event => event.type)).toEqual([
      'turn/start', 'step/start', 'step/end', 'turn/end', 'subagent/catalog', 'subagent/catalog',
    ])
    expect(catalogEntries(restored.events)).toEqual([
      { version: 0, childId: 'v3-listed-continuable', childCreatedAt: 1001, mode: 'continuable', label: 'listed child' },
      { version: 1, childId: 'v3-listed-silent', childCreatedAt: 1002, mode: 'unknown' },
    ])
    await store.close()
  })

  it('backfills missing child facts and keeps the installed descriptor generation', async () => {
    const path = await writeBackfillChildrenFixture()
    const store = openStore(path)
    const restored = await store.loadStoredLog(SessionId('v3-backfill-parent'))
    if (restored === undefined) throw new Error('the backfill parent did not load')

    expect(restored.meta.version).toBe(SESSION_FORMAT_VERSION)
    // Backfilled entries follow every source event, in creation-time then
    // child-id order, at the final source event's time.
    expect(restored.events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(restored.events.slice(4).every(event => event.time === 2014)).toBe(true)
    expect(catalogEntries(restored.events)).toEqual([
      // The installed version-4 descriptor keeps its mode and label.
      { version: 0, childId: 'v3-backfill-continuable', childCreatedAt: 2001, mode: 'continuable', label: 'backfilled child' },
      // No descriptor, an undecodable one, one whose fields the catalog refuses,
      // and one that is not a JSON object each keep identity-only membership.
      { version: 1, childId: 'v3-backfill-silent', childCreatedAt: 2002, mode: 'unknown' },
      { version: 1, childId: 'v3-backfill-undecodable', childCreatedAt: 2003, mode: 'unknown' },
      { version: 1, childId: 'v3-backfill-invalid-mode', childCreatedAt: 2004, mode: 'unknown' },
      // The child row at creation time 2005, whose stored identity this store
      // cannot validate, carries no identity a parent catalog may record: it is
      // skipped entirely instead of appearing here.
      { version: 1, childId: 'v3-backfill-nonobject', childCreatedAt: 2006, mode: 'unknown' },
    ])
    await store.close()
  })

  it('publishes the restored parent as the stored current generation', async () => {
    const path = await writeBackfillChildrenFixture()
    const store = openStore(path)
    const restored = await store.loadStoredLog(SessionId('v3-backfill-parent'))
    if (restored === undefined) throw new Error('the backfill parent did not load')
    const expected = catalogEntries(restored.events)

    await store.publishStoredLog(
      { meta: restored.meta, inheritedEventCount: restored.inheritedEventCount },
      restored.events,
    )
    const published = await store.loadStoredLog(SessionId('v3-backfill-parent'))
    // The published row restores natively, so it needs no child evidence and
    // still carries every backfilled entry the historical restore appended.
    expect(published?.storedVersion).toBe(SESSION_FORMAT_VERSION)
    expect(catalogEntries(published?.events ?? [])).toEqual(expected)
    await store.close()
  })
})
