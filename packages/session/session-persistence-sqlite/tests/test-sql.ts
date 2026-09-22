/** Test-only loader for fixed SQLite fixtures. */

import { readFileSync } from 'node:fs'

export type TestSqlName =
  | 'add-unexpected-column'
  | 'corrupt-schema-19-packed-event'
  | 'count-events'
  | 'count-packed-events'
  | 'count-physical-types'
  | 'create-loose-schema'
  | 'create-schema-19-db'
  | 'create-unrelated-table'
  | 'delete-persistence-state'
  | 'delete-session-events'
  | 'delete-session-row'
  | 'empty-store-id'
  | 'insert-corrupt-event'
  | 'insert-packed-event'
  | 'insert-schema-19-descriptor-events'
  | 'insert-schema-19-descriptor-session'
  | 'insert-schema-19-events'
  | 'insert-schema-19-multibyte-events'
  | 'insert-schema-19-session'
  | 'measure-write-traffic'
  | 'replace-events-with-nonstrict-table'
  | 'select-cache-size'
  | 'select-last-event'
  | 'select-page-size'
  | 'select-session-version'
  | 'select-event-columns'
  | 'select-event-rowids'
  | 'select-event-rows'
  | 'select-user-version'
  | 'set-application-id-12345'
  | 'set-page-size-4096'
  | 'set-user-version-15'
  | 'set-user-version-16'
  | 'set-user-version-17'
  | 'set-user-version-18'
  | 'set-user-version-19'
  | 'update-invalid-session-metadata'
  | 'update-session-cwd'
  | 'vacuum'

/** Load one fixed test SQL resource. */
export function testSql(name: TestSqlName): string {
  return readFileSync(new URL(`./resources/sql/${name}.sql`, import.meta.url), 'utf8')
}
