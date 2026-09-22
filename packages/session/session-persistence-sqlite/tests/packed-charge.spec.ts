/**
 * The decoded-log cache charges one physical row the UTF-8 byte length of the
 * JSON text its data column decoded to. A packed chunk row decodes to the
 * whole run's run-data document — `texts` carries every member's text — so a
 * run whose texts are multibyte separates that charge from the same text
 * measured in UTF-16 code units. Two ceilings over one unchanged stored
 * session, one at each measure, pin which unit the packed row is charged in:
 * a code-unit charge is admitted by the lower ceiling, and only a byte charge
 * exceeds it.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SessionId } from '@deepseek-ai/dsh-session'
import { DEFAULT_BUSY_TIMEOUT_MS } from '@deepseek-ai/dsh-session-persistence-sqlite'
import { decodeEventRow, type EventRow } from '../src/schema.ts'
import { sql } from '../src/sql.ts'
import { SqliteStore } from '../src/store.ts'
import { decodedColumnText } from './decoded-text.ts'
import { testSql } from './test-sql.ts'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** One store over `path`; the ceiling decides whether a read is retained. */
function openStore(path: string, decodedLogCacheBytes?: number): SqliteStore {
  return new SqliteStore({
    path,
    journalMode: 'wal',
    busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    ...decodedLogCacheBytes === undefined ? {} : { decodedLogCacheBytes },
  })
}

/**
 * One stored session's physical rows, read from the database rather than from
 * the cache under test.
 */
function storedRows(path: string, id: SessionId): EventRow[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const key = db.prepare(sql('select-session-key')).get(id) as { id: number }
    return db.prepare(sql('select-events')).all(key.id).map(decodeEventRow)
  } finally {
    db.close()
  }
}

/** The decoded JSON text of those rows in both units — the number the ceiling is charged. */
function decodedTextSizes(rows: readonly EventRow[]): { bytes: number; codeUnits: number } {
  let bytes = 0
  let codeUnits = 0
  for (const row of rows) {
    const text = decodedColumnText(row.data)
    bytes += Buffer.byteLength(text)
    codeUnits += text.length
  }
  return { bytes, codeUnits }
}

const PACKED_LEGACY_ID = SessionId('v0-chunks')

/**
 * Seed the schema-19 fixture whose packed text run carries multibyte payloads.
 * A legacy v0 header is the only stored form this build restores to the current
 * format, so the packed row reaches the scan as one physical row of three
 * retired delta events rather than being rewritten into scalars first.
 */
async function writeLegacyV0PackedFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-sqlite-packed-charge-'))
  directories.push(directory)
  const path = join(directory, 'sessions.db')
  const seed = new DatabaseSync(path)
  seed.exec(testSql('create-schema-19-db'))
  seed.exec(testSql('insert-schema-19-session'))
  seed.exec(testSql('insert-schema-19-multibyte-events'))
  seed.close()
  // The store refuses a database file any other user can read.
  await chmod(path, 0o600)
  return path
}

describe('packed row decode charge', () => {
  it('charges a packed row decoded text as UTF-8 bytes, not code units', async () => {
    const path = await writeLegacyV0PackedFixture()

    // Any store open migrates the schema-19 database in place to schema 20, so
    // the independent measurement below can select the migrated column.
    const migrator = openStore(path)
    const migrated = await migrator.loadStoredLog(PACKED_LEGACY_ID)
    expect(migrated?.tornFrom).toBeUndefined()
    // The restored log folds the packed run into one attempt: the read above
    // went through the packed row rather than around it.
    expect(migrated?.events.some(event => event.type === 'assistant/attempt')).toBe(true)
    await migrator.close()

    const rows = storedRows(path, PACKED_LEGACY_ID)
    // The scan must meet the run as one packed physical row: a read that
    // unpacked it into scalars first would measure the scalar branch instead.
    const packedRows = rows.filter(row => row.ignorable === 0)
    expect(packedRows).toHaveLength(1)
    expect(packedRows[0]?.type).toBe('text-chunks')

    // The four scalar rows contribute the same count in both units; the packed
    // row contributes 95 code units and 159 UTF-8 bytes, 64 bytes apart.
    const { bytes, codeUnits } = decodedTextSizes(rows)
    expect(codeUnits).toBeGreaterThan(0)
    expect(codeUnits).toBeLessThan(bytes)

    const atCodeUnits = openStore(path, codeUnits)
    const first = await atCodeUnits.loadStoredLog(PACKED_LEGACY_ID)
    // A charge of code units fits this ceiling, so the log would be retained
    // and this second read would answer with the first object.
    expect(await atCodeUnits.loadStoredLog(PACKED_LEGACY_ID)).not.toBe(first)
    await atCodeUnits.close()

    // The ceiling is inclusive, so the byte count the scan charges is retained
    // exactly; any larger charge — a repeated or inflated packed row — misses.
    const atBytes = openStore(path, bytes)
    const retained = await atBytes.loadStoredLog(PACKED_LEGACY_ID)
    expect(await atBytes.loadStoredLog(PACKED_LEGACY_ID)).toBe(retained)
    await atBytes.close()
  })
})
