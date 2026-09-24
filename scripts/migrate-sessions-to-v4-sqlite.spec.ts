/** The SQLite migration command drives the real provider over private temporary corpora. */
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { chmod } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { execa } from 'execa'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence, { DEFAULT_BUSY_TIMEOUT_MS } from '@deepseek-ai/dsh-session-persistence-sqlite'
import { SqliteStore } from '../packages/session/session-persistence-sqlite/src/store.ts'
import { testSql } from '../packages/session/session-persistence-sqlite/tests/test-sql.ts'
import { removeFixtureSafely } from './test-fixture-cleanup.ts'

const repository = resolve(import.meta.dirname, '..')
const script = join(repository, 'scripts/migrate-sessions-to-v4-sqlite.ts')
const directories = new Set<string>()
const stopProcesses: Array<() => Promise<void>> = []

/** The V3 parent and child the listed-children fixture stores. */
const LISTED_PARENT = 'v3-listed-parent'
const LISTED_CONTINUABLE = 'v3-listed-continuable'
const LISTED_SILENT = 'v3-listed-silent'
/** The two Sessions the isolation suite proves are refused while the rest convert. */
const CORRUPT = 'v3-corrupt'
const CONFLICT_PARENT = 'v3-conflict-parent'
const CONFLICT_CHILD = 'v3-conflict-child'
const UNKNOWN_EVENT = 'v3-unknown-event'
/** The current-format row every corpus carries, so `alreadyV4` has a subject. */
const NATIVE_V4 = 'v4-native'

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  directories.add(directory)
  return directory
}

async function runAt(entrypoint: string, ...args: string[]) {
  const child = execa(process.execPath, ['--import', 'tsx', entrypoint, ...args], {
    cwd: repository, reject: false,
  })
  stopProcesses.push(async () => { child.kill('SIGKILL'); await child })
  const result = await child
  const logPath = [...result.stdout.matchAll(/^Full log: (.+)$/gmu)].at(-1)?.[1]
  const summaryPath = [...result.stdout.matchAll(/^JSON summary: (.+)$/gmu)].at(-1)?.[1]
  if (logPath !== undefined) directories.add(dirname(logPath))
  expect(result.timedOut, result.stderr).toBe(false)
  expect(result.signal, result.stderr).toBeUndefined()
  const summary: unknown = summaryPath === undefined ? undefined : JSON.parse(readFileSync(summaryPath, 'utf8'))
  return { stdout: result.stdout, stderr: result.stderr, status: result.exitCode, logPath, summaryPath, summary }
}

function run(...args: string[]) {
  return runAt(script, ...args)
}

afterEach(async () => {
  await Promise.all(stopProcesses.splice(0).map(stop => stop()))
  for (const directory of directories) removeFixtureSafely(directory)
  directories.clear()
})

/** Insert one current-format Session row beside the V3 fixture rows. */
function insertNativeV4(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO sessions (id, session_key, version, created_at, cwd, parent_session, seed_length, origin, incarnation, revision)
    VALUES (90, '${NATIVE_V4}', 4, 5000, NULL, NULL, NULL, NULL, '00000000-0000-4000-8000-000000000090', 0);
    INSERT INTO events (session_id, seq, type, time, data, source_event_seqs, surface_op, is_packed)
    VALUES (90, 0, 'turn/start', 5001, '{"turn":1}', NULL, NULL, 0),
           (90, 1, 'turn/end', 5002, '{"turn":1,"reason":{"kind":"completed"}}', NULL, NULL, 0);`)
}

/**
 * Insert the refusals the isolation suite uses: a committed corrupt physical
 * row before a valid turn end, a V3 parent whose own catalog records a child
 * creation time its child's stored identity contradicts, and a V3 event type
 * the released format does not know.
 */
function insertRefusals(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO sessions (id, session_key, version, created_at, cwd, parent_session, seed_length, origin, incarnation, revision)
    VALUES
      (91, '${CORRUPT}', 3, 6000, NULL, NULL, NULL, NULL, '00000000-0000-4000-8000-000000000091', 0),
      (92, '${CONFLICT_PARENT}', 3, 6001, NULL, NULL, NULL, NULL, '00000000-0000-4000-8000-000000000092', 0),
      (93, '${CONFLICT_CHILD}', 3, 7000, NULL, '${CONFLICT_PARENT}', NULL, 'subagent', '00000000-0000-4000-8000-000000000093', 0),
      (94, '${UNKNOWN_EVENT}', 3, 6002, NULL, NULL, NULL, NULL, '00000000-0000-4000-8000-000000000094', 0);
    INSERT INTO events (session_id, seq, type, time, data, source_event_seqs, surface_op, is_packed)
    VALUES
      (91, 0, 'turn/start', 6001, '{"turn":1}', NULL, NULL, 0),
      (91, 1, 'assistant/chunk', 6002, '{not json', NULL, NULL, 0),
      (91, 2, 'turn/end', 6003, '{"turn":1,"reason":{"kind":"completed"}}', NULL, NULL, 0),
      (92, 0, 'turn/start', 6011, '{"turn":1}', NULL, NULL, 0),
      (92, 1, 'turn/end', 6012, '{"turn":1,"reason":{"kind":"completed"}}', NULL, NULL, 0),
      (92, 2, 'subagent/catalog', 6013, '{"version":1,"childId":"${CONFLICT_CHILD}","childCreatedAt":6000,"mode":"unknown"}', NULL, NULL, 0),
      (93, 0, 'turn/start', 6021, '{"turn":1}', NULL, NULL, 0),
      (93, 1, 'turn/end', 6022, '{"turn":1,"reason":{"kind":"completed"}}', NULL, NULL, 0),
      (94, 0, 'turn/start', 6031, '{"turn":1}', NULL, NULL, 0),
      (94, 1, 'fixture/unknown-event', 6032, '{}', NULL, NULL, 0),
      (94, 2, 'turn/end', 6033, '{"turn":1,"reason":{"kind":"completed"}}', NULL, NULL, 0);`)
}

/**
 * Build one private corpus from the package's own schema-19 shell and V3
 * fixtures, then perform the provider's one-time 19-to-20 upgrade here, so a
 * measured run starts from the schema version the deployment already stores.
 * @param insert - row inserters applied to the schema-19 shell.
 * @returns the corpus database path.
 */
async function corpus(...insert: ReadonlyArray<(database: DatabaseSync) => void>): Promise<string> {
  const database = join(temporaryDirectory('dsh-migrate-v4-sqlite-test-'), 'sessions.db')
  const shell = new DatabaseSync(database)
  shell.exec(testSql('create-schema-19-db'))
  shell.exec(testSql('insert-v3-listed-children'))
  for (const apply of insert) apply(shell)
  shell.close()
  await chmod(database, 0o600)
  const store = new SqliteStore({ path: database, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
  await store.open()
  await store.close()
  return database
}

/** Rows of one read-only query against a corpus, for direct stored-state assertions. */
function query(databasePath: string, statement: string): unknown[] {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return database.prepare(statement).all()
  } finally {
    database.close()
  }
}

function sessionVersions(databasePath: string): unknown[] {
  return query(databasePath, 'SELECT session_key, version FROM sessions ORDER BY session_key')
}

function sqliteUserVersion(databasePath: string): unknown {
  return query(databasePath, 'PRAGMA user_version')[0]
}

/** The catalog entries one stored Session's log carries, read back through the provider. */
async function catalogEntries(databasePath: string, id: string): Promise<unknown[]> {
  const ctx = new Context()
  try {
    await ctx.plugin(SqliteSessionPersistence, { path: databasePath })
    const handle = await ctx.sessionPersistence.open(SessionId(id), 'read')
    try {
      const { events } = await handle.read()
      // Read the common event envelope so this spec does not need the package
      // that merges the catalog member into SessionEventMap to be in its program.
      return events.flatMap((event) => {
        const envelope: { type: string; data: unknown } = event
        return envelope.type === 'subagent/catalog' ? [envelope.data] : []
      })
    } finally {
      await handle.close()
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

describe('SQLite V4 migration command', () => {
  it('shows usage, requires --database, and rejects an invalid --jobs before opening a database', async () => {
    const help = await run('--help')
    expect(help.status, help.stderr).toBe(0)
    expect(help.stdout).toContain('Usage: pnpm run migrate:sessions-to-v4-sqlite -- --database PATH')
    expect(help.stdout).toContain('stop every dsh-web instance')
    expect(help.stdout).toContain('file-level backup')
    expect(help.stdout).toContain('--apply')
    expect(help.stdout).toContain('--report-dir')
    // pnpm forwards its own `--` separator into the script's argv.
    const separated = await run('--', '--help')
    expect(separated.status, separated.stderr).toBe(0)
    expect(separated.stdout).toContain('Usage: pnpm run migrate:sessions-to-v4-sqlite -- --database PATH')
    const missing = await run()
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('--database PATH is required')
    expect(missing.stdout).not.toContain('SQLite Session migration')
    const jobs = await run('--database', join(temporaryDirectory('dsh-migrate-v4-sqlite-missing-'), 'missing.db'), '--jobs', '0')
    expect(jobs.status).toBe(1)
    expect(jobs.stderr).toContain('--jobs must be a positive safe integer')
    const timeout = await run('--database', join(temporaryDirectory('dsh-migrate-v4-sqlite-missing-'), 'missing.db'), '--busy-timeout-ms=-1')
    expect(timeout.status).toBe(1)
    expect(timeout.stderr).toContain('--busy-timeout-ms must be a non-negative safe integer')
  }, 30_000)

  it('reports the stored-version histogram and converts nothing without --apply', async () => {
    const database = await corpus(insertNativeV4)
    const before = sessionVersions(database)
    const result = await run('--database', database)
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('Mode: dry run (nothing is written)')
    expect(result.stdout).toContain('Reminder: stop every dsh-web instance that owns this database and take a file-level backup before --apply.')
    expect(result.stdout).toContain(`Session jobs: ${Math.min(availableParallelism(), 16)}`)
    expect(result.stdout).toContain('Discovered 6 stored Sessions; sqlite user_version=20.')
    expect(result.stdout).toContain('Stored version histogram before: {"3":5,"4":1}')
    expect(result.stdout).toContain('Stored version histogram after: {"3":5,"4":1}')
    expect(result.stdout).toContain('converted=5, already-V4=1, failed=0')
    expect(result.stdout).toContain(`"${LISTED_PARENT}" (stored V3) WOULD CONVERT V3 -> V4 (dry run)`)
    expect(result.stdout).toContain(`"${NATIVE_V4}" (stored V4) SKIPPED: already V4`)
    expect(result.summary).toMatchObject({
      schemaVersion: 1,
      mode: 'dry-run',
      published: false,
      targetVersion: 4,
      databasePath: database,
      inputCount: 6,
      jobs: Math.min(availableParallelism(), 16),
      sqliteUserVersion: { before: 20, after: 20 },
      totals: { converted: 5, alreadyV4: 1, failed: 0 },
      byStoredVersion: {
        '3': { converted: 5, alreadyV4: 0, failed: 0 },
        '4': { converted: 0, alreadyV4: 1, failed: 0 },
      },
      storedVersionHistogram: { before: { '3': 5, '4': 1 }, after: { '3': 5, '4': 1 } },
      failureGroups: [],
    })
    expect(sessionVersions(database)).toEqual(before)
    expect(sqliteUserVersion(database)).toEqual({ user_version: 20 })
  })

  it('publishes every V3 row on --apply and leaves the store schema at 20', async () => {
    const database = await corpus(insertNativeV4)
    const reportDirectory = join(temporaryDirectory('dsh-migrate-v4-sqlite-reports-'), 'run')
    const result = await run('--database', database, '--apply', '--report-dir', reportDirectory)
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('Mode: apply (publishes each converted Session)')
    expect(result.stdout).toContain(`"${LISTED_PARENT}" (stored V3) CONVERTED V3 -> V4 (published)`)
    expect(result.stdout).toContain('converted=5, already-V4=1, failed=0')
    expect(result.stdout).toContain('Stored version histogram after: {"4":6}')
    expect(result.summary).toMatchObject({
      mode: 'apply',
      published: true,
      inputCount: 6,
      sqliteUserVersion: { before: 20, after: 20 },
      totals: { converted: 5, alreadyV4: 1, failed: 0 },
      byStoredVersion: {
        '3': { converted: 5, alreadyV4: 0, failed: 0 },
        '4': { converted: 0, alreadyV4: 1, failed: 0 },
      },
      storedVersionHistogram: { before: { '3': 5, '4': 1 }, after: { '4': 6 } },
      failureGroups: [],
    })
    expect(sessionVersions(database)).toEqual([
      { session_key: LISTED_CONTINUABLE, version: 4 },
      { session_key: 'v3-listed-elsewhere', version: 4 },
      { session_key: 'v3-listed-forked', version: 4 },
      { session_key: LISTED_PARENT, version: 4 },
      { session_key: LISTED_SILENT, version: 4 },
      { session_key: NATIVE_V4, version: 4 },
    ])
    expect(sqliteUserVersion(database)).toEqual({ user_version: 20 })
    expect(result.logPath).toBe(join(reportDirectory, 'migration.log'))
    expect(result.summaryPath).toBe(join(reportDirectory, 'summary.json'))
    const log = readFileSync(result.logPath!, 'utf8')
    const json = readFileSync(result.summaryPath!, 'utf8')
    expect(log).toContain('Git HEAD: ')
    expect(log).toContain(`Node: ${process.version}; platform: ${process.platform}/${process.arch}`)
    expect(log).toContain(result.stdout.trim())
    expect(result.stdout.endsWith(json.trimEnd())).toBe(true)
    expect(log.endsWith(json)).toBe(true)
    if (process.platform !== 'win32') {
      expect(statSync(result.logPath!).mode & 0o777).toBe(0o600)
      expect(statSync(result.summaryPath!).mode & 0o777).toBe(0o600)
    }
    const perSession = (result.summary as { elapsedMs: { total: number; perSession: Record<string, number> } }).elapsedMs
    expect(Object.keys(perSession.perSession)).toHaveLength(6)
    expect(Object.values(perSession.perSession).every(ms => ms >= 0)).toBe(true)
    expect(perSession.total).toBeGreaterThan(0)
    const reused = await run('--database', database, '--apply', '--report-dir', reportDirectory)
    expect(reused.status).toBe(1)
    expect(reused.stderr).toContain('already holds migration.log or summary.json')
  })

  it('converts nothing on a second --apply after every Session reached V4', async () => {
    const database = await corpus(insertNativeV4)
    const first = await run('--database', database, '--apply')
    expect(first.status, first.stdout + first.stderr).toBe(0)
    const afterFirst = sessionVersions(database)
    const second = await run('--database', database, '--apply')
    expect(second.status, second.stdout + second.stderr).toBe(0)
    expect(second.stdout).toContain('converted=0, already-V4=6, failed=0')
    expect(second.stdout).toContain('Stored version histogram before: {"4":6}')
    expect(second.summary).toMatchObject({
      mode: 'apply',
      sqliteUserVersion: { before: 20, after: 20 },
      totals: { converted: 0, alreadyV4: 6, failed: 0 },
      byStoredVersion: { '4': { converted: 0, alreadyV4: 6, failed: 0 } },
      storedVersionHistogram: { before: { '4': 6 }, after: { '4': 6 } },
      failureGroups: [],
    })
    expect(sessionVersions(database)).toEqual(afterFirst)
  })

  it('keeps a parent catalog entry across its child conversion', async () => {
    const database = await corpus(insertNativeV4)
    const result = await run('--database', database, '--apply')
    expect(result.status, result.stdout + result.stderr).toBe(0)
    // The listed children stay exactly as the V3 parent recorded them, including
    // the child whose own session row still migrates in the same run.
    expect(await catalogEntries(database, LISTED_PARENT)).toEqual([
      { version: 0, childId: LISTED_CONTINUABLE, childCreatedAt: 1001, mode: 'continuable', label: 'listed child' },
      { version: 1, childId: LISTED_SILENT, childCreatedAt: 1002, mode: 'unknown' },
    ])
    expect(sessionVersions(database)).toEqual(expect.arrayContaining([
      { session_key: LISTED_CONTINUABLE, version: 4 },
      { session_key: LISTED_SILENT, version: 4 },
    ]))
  })

  it('reports each refusing Session and still converts the others', async () => {
    const database = await corpus(insertNativeV4, insertRefusals)
    const result = await run('--database', database, '--apply')
    expect(result.status, result.stdout + result.stderr).toBe(1)
    expect(result.stdout).toContain('converted=6, already-V4=1, failed=3')
    expect(result.stdout).toContain('Stored version histogram after: {"3":3,"4":7}')
    expect(result.stdout).toContain(`ERROR "${CORRUPT}": corrupt session log: invalid committed physical row at seq 1`)
    expect(result.stdout).toContain(`ERROR "${CONFLICT_PARENT}":`)
    expect(result.stdout).toContain(`"${UNKNOWN_EVENT}" [unknown_event]`)
    const anyString: unknown = expect.any(String)
    expect(result.summary).toMatchObject({
      mode: 'apply',
      inputCount: 10,
      totals: { converted: 6, alreadyV4: 1, failed: 3 },
      storedVersionHistogram: { before: { '3': 9, '4': 1 }, after: { '3': 3, '4': 7 } },
      failureGroups: [
        { storedVersion: 3, reason: 'child_catalog_conflict', errorName: 'SessionFormatUnsupportedError', count: 1, items: [
          { input: CONFLICT_PARENT, reason: 'child_catalog_conflict', errorName: 'SessionFormatUnsupportedError',
            message: anyString },
        ] },
        { storedVersion: 3, reason: 'corrupt_log', errorName: 'Error', count: 1, items: [
          { input: CORRUPT, reason: 'corrupt_log', errorName: 'Error',
            message: 'corrupt session log: invalid committed physical row at seq 1' },
        ] },
        { storedVersion: 3, reason: 'unknown_event', errorName: 'SessionFormatUnsupportedError', count: 1, items: [
          { input: UNKNOWN_EVENT, reason: 'unknown_event', errorName: 'SessionFormatUnsupportedError',
            eventType: 'fixture/unknown-event', message: anyString },
        ] },
      ],
    })
    // The three refusing Sessions keep their stored generation; every other row reached V4.
    expect(sessionVersions(database)).toEqual([
      { session_key: CONFLICT_CHILD, version: 4 },
      { session_key: CONFLICT_PARENT, version: 3 },
      { session_key: CORRUPT, version: 3 },
      { session_key: LISTED_CONTINUABLE, version: 4 },
      { session_key: 'v3-listed-elsewhere', version: 4 },
      { session_key: 'v3-listed-forked', version: 4 },
      { session_key: LISTED_PARENT, version: 4 },
      { session_key: LISTED_SILENT, version: 4 },
      { session_key: UNKNOWN_EVENT, version: 3 },
      { session_key: NATIVE_V4, version: 4 },
    ])
    const log = readFileSync(result.logPath!, 'utf8')
    expect(log).toContain('invalid committed physical row at seq 1')
    expect(log).toContain('conflicts with its parent catalog')
    expect(log).toContain('unknown event type \\"fixture/unknown-event\\"')
  })

  it('fails every Session as write_locked while another connection holds the write transaction', async () => {
    const database = await corpus(insertNativeV4)
    const before = sessionVersions(database)
    const locker = new DatabaseSync(database)
    locker.exec('PRAGMA busy_timeout = 0')
    locker.exec('BEGIN IMMEDIATE')
    locker.exec(`UPDATE sessions SET revision = revision + 1 WHERE session_key = '${LISTED_SILENT}'`)
    try {
      const result = await run('--database', database, '--apply', '--busy-timeout-ms', '0')
      expect(result.status, result.stdout + result.stderr).toBe(1)
      expect(result.stdout).toContain('busy timeout: 0ms')
      expect(result.stdout).toContain('converted=0, already-V4=1, failed=5')
      expect(result.stdout).toContain(`ERROR "${LISTED_PARENT}": database is locked`)
      expect(result.stdout).toContain(`- "${LISTED_PARENT}" [write_locked]: database is locked`)
      expect(result.summary).toMatchObject({
        mode: 'apply',
        totals: { converted: 0, alreadyV4: 1, failed: 5 },
        storedVersionHistogram: { before: { '3': 5, '4': 1 }, after: { '3': 5, '4': 1 } },
        failureGroups: [
          { storedVersion: 3, reason: 'write_locked', errorName: 'Error', count: 5, items: [
            { input: LISTED_CONTINUABLE, reason: 'write_locked', errorName: 'Error', message: 'database is locked' },
            { input: 'v3-listed-elsewhere', reason: 'write_locked', errorName: 'Error', message: 'database is locked' },
            { input: 'v3-listed-forked', reason: 'write_locked', errorName: 'Error', message: 'database is locked' },
            { input: LISTED_PARENT, reason: 'write_locked', errorName: 'Error', message: 'database is locked' },
            { input: LISTED_SILENT, reason: 'write_locked', errorName: 'Error', message: 'database is locked' },
          ] },
        ],
      })
    } finally {
      locker.exec('ROLLBACK')
      locker.close()
    }
    expect(sessionVersions(database)).toEqual(before)
    expect(sqliteUserVersion(database)).toEqual({ user_version: 20 })
  })
})
