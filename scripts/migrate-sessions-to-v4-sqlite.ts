/** One-time operator command publishing V4 successors for stored V3 SQLite Session rows. */

import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { inspect, parseArgs } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import SqliteSessionPersistence, {
  DEFAULT_BUSY_TIMEOUT_MS,
  MAX_BUSY_TIMEOUT_MS,
} from '@deepseek-ai/dsh-session-persistence-sqlite'
import { runMigrationJobs } from './migrate-sessions-to-v4.ts'
import { classifyMigrationFailure, type MigrationFailureDiagnostic } from './migration-failure-summary.ts'

const usage = `Usage: pnpm run migrate:sessions-to-v4-sqlite -- --database PATH [--apply] [--jobs N]

Publish a V4 successor for every stored V3 Session row in one SQLite database.
Dry run by default: without --apply the command reads every non-V4 Session to
prove it migrates, and writes nothing. Sessions already stored at V4 are skipped.
No model or API key is used. One failing Session does not stop the others.
Every conversion runs through the provider's write path, so a database another
process holds a write transaction on fails those Sessions as write_locked.

Before --apply: stop every dsh-web instance that owns this database and take a
file-level backup of it. A write open publishes the migrated log in one
delete-and-rewrite transaction.

Options:
  --database PATH       SQLite Session database to migrate (required; no default)
  --apply              Publish the migrated logs; without it nothing is written
  --jobs N             Concurrent Sessions, positive integer (default: CPU count capped at 16)
  --busy-timeout-ms N  Milliseconds to wait for another writer before failing a Session
                       as write_locked (default: ${DEFAULT_BUSY_TIMEOUT_MS})
  --report-dir PATH    Directory for migration.log and summary.json (default: a private
                       OS temporary directory)
  --help               Show this help
`

/** A failure reason this command reports: the shared vocabulary plus the SQLite child-catalog refusal. */
type MigrationFailureReason = MigrationFailureDiagnostic['reason'] | 'child_catalog_conflict'

/** One stored Session row: its public key and the format version physically stored for it. */
interface StoredSession {
  readonly id: string
  readonly version: number
}

/** Counts by migration outcome; in a dry run `converted` counts Sessions a later `--apply` converts. */
interface OutcomeCounts {
  converted: number
  alreadyV4: number
  failed: number
}

/** The diagnostic facts this command reports for one failure. */
type FailureDiagnostic = Omit<MigrationFailureDiagnostic, 'reason'> & { readonly reason: MigrationFailureReason }

/** One failed input: the input it names, its stored generation, and the provider's own diagnostic. */
type MigrationFailure = FailureDiagnostic & {
  /** Session key, or the database path for a run-level failure. */
  readonly input: string
  readonly storedVersion: number | 'unknown'
}

/** One failure as its group carries it. */
type FailureItem = Omit<MigrationFailure, 'storedVersion'>

/** Matching failures collapsed into one report entry. */
interface FailureGroup {
  readonly storedVersion: number | 'unknown'
  readonly reason: MigrationFailureReason
  readonly errorName: string
  count: number
  readonly items: FailureItem[]
}

/** Resolved command options. */
interface MigrationOptions {
  /** SQLite database to migrate. */
  readonly databasePath: string
  /** Publish the migrated logs; false reads every Session and writes nothing. */
  readonly apply: boolean
  /** Concurrent Session jobs. */
  readonly jobs: number
  /** Milliseconds to wait for a competing SQLite writer before failing a Session. */
  readonly busyTimeoutMs: number
  /** Report directory; an omitted value creates a private OS temporary directory. */
  readonly reportDirectory?: string
}

function emptyCounts(): OutcomeCounts {
  return { converted: 0, alreadyV4: 0, failed: 0 }
}

/** Count stored Sessions per physical format version, in ascending version order. */
function histogram(sessions: readonly StoredSession[]): Record<string, number> {
  const counts = new Map<number, number>()
  for (const session of sessions) counts.set(session.version, (counts.get(session.version) ?? 0) + 1)
  return Object.fromEntries([...counts]
    .sort(([left], [right]) => left - right)
    .map(([version, count]) => [String(version), count]))
}

function storedRow(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('stored Session row must be an object')
  return value as Record<string, unknown>
}

function storedString(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`stored ${key} must be a nonempty string`)
  return value
}

function storedInteger(row: Record<string, unknown>, key: string): number {
  const value = row[key]
  if (!Number.isSafeInteger(value)) throw new Error(`stored ${key} must be a safe integer`)
  return value as number
}

/**
 * Read every stored Session's key and physical format version.
 *
 * `list()` answers already-migrated headers, so the stored versions come from
 * the `sessions` table itself, over a separate read-only connection that never
 * opens the provider.
 * @param databasePath - existing SQLite session database.
 * @returns one entry per stored Session, ordered by key.
 */
function readStoredSessions(databasePath: string): StoredSession[] {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return database.prepare('SELECT session_key AS id, version FROM sessions ORDER BY session_key').all().map((value) => {
      const row = storedRow(value)
      return { id: storedString(row, 'id'), version: storedInteger(row, 'version') }
    })
  } finally {
    database.close()
  }
}

/**
 * Read the store's own schema version without changing it.
 * @param databasePath - existing SQLite session database.
 * @returns the `user_version` pragma value.
 */
function readUserVersion(databasePath: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return storedInteger(storedRow(database.prepare('PRAGMA user_version').get()), 'user_version')
  } finally {
    database.close()
  }
}

/** Whether SQLite refused a statement because another connection holds the lock. */
function isSqliteBusy(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  // 5 is SQLITE_BUSY and 6 is SQLITE_LOCKED; both mean another writer holds the database.
  const errcode: unknown = Reflect.get(error, 'errcode')
  return errcode === 5 || errcode === 6
}

/**
 * Classify one failure, naming the SQLite diagnostics the shared vocabulary
 * cannot: a busy database, a stored log its physical row scan refuses, and a
 * child catalog the V3-to-V4 edge refuses.
 * @param error - Failure returned by the provider or by the store's own read.
 * @returns the reported reason, the error name, and the underlying message.
 */
function classifySqliteMigrationFailure(error: unknown): FailureDiagnostic {
  const diagnostic = classifyMigrationFailure(error)
  if (isSqliteBusy(error)) return { ...diagnostic, reason: 'write_locked' }
  if (/conflicts with its parent catalog/u.test(diagnostic.message)) {
    return { ...diagnostic, reason: 'child_catalog_conflict' }
  }
  // The physical scan reports committed damage as a plain Error, before the
  // restore path would wrap it in SessionPersistenceCorruptionError.
  if (/^corrupt session log:/u.test(diagnostic.message)) return { ...diagnostic, reason: 'corrupt_log' }
  return diagnostic
}

function groupFailures(failures: readonly MigrationFailure[]): FailureGroup[] {
  const groups = new Map<string, FailureGroup>()
  for (const failure of failures) {
    const { storedVersion, ...item } = failure
    const key = JSON.stringify([String(storedVersion), item.reason, item.errorName])
    let group = groups.get(key)
    if (group === undefined) {
      group = { storedVersion, reason: item.reason, errorName: item.errorName, count: 0, items: [] }
      groups.set(key, group)
    }
    group.count += 1
    group.items.push(item)
  }
  return [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([, group]) => ({
    ...group,
    items: group.items.sort((left, right) => left.input.localeCompare(right.input)),
  }))
}

/** Elapsed milliseconds at a stable report precision. */
function elapsedMs(started: number): number {
  return Number((performance.now() - started).toFixed(3))
}

async function migrate(options: MigrationOptions): Promise<number> {
  const { databasePath, apply, jobs, busyTimeoutMs } = options
  if (!existsSync(databasePath)) throw new Error(`session database "${databasePath}" does not exist`)
  const reportDirectory = options.reportDirectory ?? mkdtempSync(join(tmpdir(), 'dsh-migrate-v4-sqlite-'))
  mkdirSync(reportDirectory, { recursive: true, mode: 0o700 })
  const logPath = join(reportDirectory, 'migration.log')
  const summaryPath = join(reportDirectory, 'summary.json')
  if (existsSync(logPath) || existsSync(summaryPath)) {
    throw new Error(`report directory "${reportDirectory}" already holds migration.log or summary.json`)
  }
  const log = openSync(logPath, 'wx', 0o600)
  const write = (line: string): void => {
    appendFileSync(log, `${line}\n`)
    console.log(line)
  }
  const totals = emptyCounts()
  const byStoredVersion: Record<string, OutcomeCounts> = {}
  const perSessionMs: Record<string, number> = {}
  const recordOutcome = (version: number | 'unknown', outcome: keyof OutcomeCounts): void => {
    totals[outcome] += 1
    const counts = byStoredVersion[String(version)] ??= emptyCounts()
    counts[outcome] += 1
  }
  const failures: MigrationFailure[] = []
  const fail = (input: string, error: unknown, storedVersion: number | 'unknown' = 'unknown'): void => {
    const diagnostic = classifySqliteMigrationFailure(error)
    failures.push({ input, storedVersion, ...diagnostic })
    recordOutcome(storedVersion, 'failed')
    write(`ERROR ${JSON.stringify(input)}: ${diagnostic.message}`)
    appendFileSync(log, `${inspect(error, { depth: null, colors: false })}\n`)
  }
  const startedAt = new Date().toISOString()
  const runStarted = performance.now()
  let inputCount = 0
  let checkoutCommit: string | null = null
  let userVersionBefore: number | null = null
  let before: readonly StoredSession[] | null = null
  let after: readonly StoredSession[] | null = null
  try {
    write(`SQLite Session migration to V4 started ${startedAt}`)
    write(`Database: ${databasePath}`)
    write(`Mode: ${apply ? 'apply (publishes each converted Session)' : 'dry run (nothing is written)'}`)
    write(`Session jobs: ${jobs}; busy timeout: ${busyTimeoutMs}ms`)
    write('Reminder: stop every dsh-web instance that owns this database and take a file-level backup before --apply.')
    write(`Node: ${process.version}; platform: ${process.platform}/${process.arch}`)
    checkoutCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' }).trim()
    write(`Git HEAD: ${checkoutCommit}`)
    write(`Full log: ${logPath}`)
    assert.equal(SESSION_FORMAT_VERSION, 4, 'this one-time command requires a V4 Session writer')
    assert.equal(sessionFormatCatalog.currentVersion, 4, 'this one-time command requires a V4 format catalog')
    userVersionBefore = readUserVersion(databasePath)
    const sessions = readStoredSessions(databasePath)
    before = sessions
    inputCount = sessions.length
    write(`Discovered ${sessions.length} stored Sessions; sqlite user_version=${userVersionBefore}.`)
    write(`Stored version histogram before: ${JSON.stringify(histogram(sessions))}`)
    const ctx = new Context()
    try {
      await ctx.plugin(SqliteSessionPersistence, { path: databasePath, busyTimeoutMs })
      let completed = 0
      await runMigrationJobs(sessions.length, jobs, async (index) => {
        const session = sessions[index]
        assert(session !== undefined, 'migration job index must name a discovered Session')
        const label = `[${index + 1}/${sessions.length}] ${JSON.stringify(session.id)} (stored V${session.version})`
        write(`${label} START ${apply ? 'convert' : 'validate'}`)
        const started = performance.now()
        const finish = (status: string): void => {
          completed += 1
          write(`${label} ${status}; completed=${completed}/${sessions.length}`)
        }
        try {
          if (session.version === SESSION_FORMAT_VERSION) {
            recordOutcome(session.version, 'alreadyV4')
            finish('SKIPPED: already V4')
            return false
          }
          // A write open publishes the migrated log before it grants the handle;
          // a read open migrates in memory only, which is the whole dry run.
          const handle = await ctx.sessionPersistence.open(SessionId(session.id), apply ? 'write' : 'read')
          await handle.close()
          recordOutcome(session.version, 'converted')
          finish(apply
            ? `CONVERTED V${session.version} -> V4 (published)`
            : `WOULD CONVERT V${session.version} -> V4 (dry run)`)
        } catch (error: unknown) {
          finish('FAILED')
          fail(session.id, error, session.version)
        } finally {
          perSessionMs[session.id] = elapsedMs(started)
        }
        return false
      })
    } finally {
      await ctx.fiber.dispose()
    }
  } catch (error: unknown) {
    fail(databasePath, error)
  } finally {
    try {
      try {
        after = readStoredSessions(databasePath)
      } catch {
        // A run-level failure already named why the database cannot be read back.
      }
      write(`Summary: ${apply ? '' : '(dry run, nothing written) '}converted=${totals.converted}, already-V4=${totals.alreadyV4}, failed=${totals.failed}`)
      if (after !== null) write(`Stored version histogram after: ${JSON.stringify(histogram(after))}`)
      if (failures.length > 0) {
        write('Failures (full stacks and causes are in the log):')
        for (const failure of failures) write(`- ${JSON.stringify(failure.input)} [${failure.reason}]: ${failure.message}`)
      }
      write(`Full log: ${logPath}`)
      const summary = JSON.stringify({
        schemaVersion: 1,
        mode: apply ? 'apply' : 'dry-run',
        // A dry run proves every conversion with a read open and publishes nothing.
        published: apply,
        targetVersion: 4,
        databasePath,
        busyTimeoutMs,
        inputCount,
        jobs,
        startedAt,
        finishedAt: new Date().toISOString(),
        checkoutCommit,
        runtime: { node: process.version, platform: process.platform, arch: process.arch },
        textLogPath: logPath,
        summaryPath,
        sqliteUserVersion: { before: userVersionBefore, after: readUserVersionSafely(databasePath) },
        totals,
        byStoredVersion,
        storedVersionHistogram: {
          before: before === null ? null : histogram(before),
          after: after === null ? null : histogram(after),
        },
        elapsedMs: {
          total: elapsedMs(runStarted),
          perSession: Object.fromEntries(Object.entries(perSessionMs).sort(([left], [right]) => left.localeCompare(right))),
        },
        failureGroups: groupFailures(failures),
      }, null, 2)
      writeFileSync(summaryPath, `${summary}\n`, { flag: 'wx', mode: 0o600 })
      write(`JSON summary: ${summaryPath}`)
      write(summary)
    } finally {
      closeSync(log)
    }
  }
  return totals.failed > 0 ? 1 : 0
}

/** Re-read the store schema version for the report, or null when the file cannot be read back. */
function readUserVersionSafely(databasePath: string): number | null {
  try {
    return readUserVersion(databasePath)
  } catch {
    // The report keeps the failure that made the database unreadable; the
    // schema version is the only fact this read-back would add.
    return null
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  try {
    // pnpm forwards its own `--` separator into the script's argv, where
    // parseArgs would read it as an end-of-options marker before the options.
    const argv = process.argv.slice(2)
    if (argv[0] === '--') argv.shift()
    const { values } = parseArgs({
      args: argv,
      options: {
        database: { type: 'string' },
        apply: { type: 'boolean' },
        jobs: { type: 'string' },
        'busy-timeout-ms': { type: 'string' },
        'report-dir': { type: 'string' },
        help: { type: 'boolean' },
      },
      strict: true,
    })
    if (values.help) console.log(usage)
    else {
      const database = values.database
      if (database === undefined || database.length === 0) {
        throw new Error('--database PATH is required; this command never defaults to a Session database')
      }
      const jobs = values.jobs === undefined ? Math.min(availableParallelism(), 16) : Number(values.jobs)
      if (!Number.isSafeInteger(jobs) || jobs < 1) {
        throw new Error('--jobs must be a positive safe integer')
      }
      const busyTimeoutMs = values['busy-timeout-ms'] === undefined
        ? DEFAULT_BUSY_TIMEOUT_MS
        : Number(values['busy-timeout-ms'])
      if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > MAX_BUSY_TIMEOUT_MS) {
        throw new Error(`--busy-timeout-ms must be a non-negative safe integer at most ${MAX_BUSY_TIMEOUT_MS}`)
      }
      const reportDirectory = values['report-dir'] === undefined ? undefined : resolve(values['report-dir'])
      process.exitCode = await migrate({
        databasePath: resolve(database),
        apply: values.apply === true,
        jobs,
        busyTimeoutMs,
        ...reportDirectory === undefined ? {} : { reportDirectory },
      })
    }
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(usage)
    process.exitCode = 1
  }
}
