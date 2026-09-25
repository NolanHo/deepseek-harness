/**
 * Closed, package-owned SQL resource loading for SQLite.
 * @module @deepseek-ai/dsh-session-persistence-sqlite/sql
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SQL_RESOURCES = [
  'begin',
  'begin-immediate',
  'cache-size',
  'commit',
  'delete-event-row',
  'delete-events-from',
  'foreign-keys-on',
  'insert-event',
  'insert-persistence-state',
  'journal-mode-delete',
  'journal-mode-persist',
  'journal-mode-truncate',
  'journal-mode-wal',
  'migrate-schema-20',
  'mmap-off',
  'page-size',
  'rollback',
  'schema',
  'select-application-id',
  'select-cache-size',
  'select-child-descriptor',
  'select-child-descriptor-count',
  'select-child-sessions',
  'select-events',
  'select-events-from',
  'select-events-from-through',
  'select-listed-sessions',
  'select-max-seq',
  'select-mmap-size',
  'select-packed-predecessors',
  'select-parented-sessions',
  'select-schema-objects',
  'select-session',
  'select-session-key',
  'select-sessions',
  'select-store-id',
  'select-synchronous',
  'select-tail-events',
  'select-trusted-schema',
  'select-user-message-cut',
  'select-user-message-cut-before',
  'select-user-object-count',
  'select-user-version',
  'set-application-id',
  'set-user-version-20',
  'synchronous-full',
  'trusted-schema-off',
  'update-session-revision',
  'upsert-session',
] as const

/** A resource basename selected exclusively by package code. */
export type SqlResourceName = typeof SQL_RESOURCES[number]

const cache = new Map<SqlResourceName, string>()

/**
 * Load `cache-size` with the validated value substituted for its `?` token:
 * SQLite's pragma grammar refuses a bound value there.
 * @param name - the one resource whose token takes a value from the caller.
 * @param argument - validated page cache in KiB, substituted into `-?`.
 * @returns the resource text.
 */
export function sql(name: 'cache-size', argument: number): string
/**
 * Load any other package-owned SQL resource verbatim; the `?` tokens these
 * resources declare are bound by the caller, never substituted here.
 * @param name - package-owned resource basename.
 * @returns the resource text.
 */
export function sql(name: Exclude<SqlResourceName, 'cache-size'>): string
export function sql(name: SqlResourceName, argument?: number): string {
  let statement = cache.get(name)
  if (statement === undefined) {
    statement = readFileSync(
      fileURLToPath(new URL(`../resources/sql/${name}.sql`, import.meta.url)),
      'utf8',
    )
    cache.set(name, statement)
  }
  return argument === undefined ? statement : statement.replace('?', String(argument))
}
