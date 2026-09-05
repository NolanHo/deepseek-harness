import { availableParallelism } from 'node:os'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

const DEFAULT_SNAPSHOT_MAX_CONCURRENCY = 5

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback

  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return value
}

const snapshotMaxConcurrency = positiveIntFromEnv(
  'DSH_SNAPSHOT_MAX_CONCURRENCY',
  Math.min(DEFAULT_SNAPSHOT_MAX_CONCURRENCY, availableParallelism()),
)

// Replay is the keyless default: boot real subprocess paths from recorded model responses and diff
// assembled requests, normalized protocol or transcript output, and persisted-log expected outputs.
// `record` calls the real API and updates fixtures and expected outputs; `refresh` replays committed scripts
// and updates current expected outputs. Replay/refresh never load `.env`; only record reads a key from the
// environment or root `.env`.
if (process.env.DSH_SNAPSHOT === 'record') {
  try {
    process.loadEnvFile(new URL('.env', import.meta.url).pathname)
  } catch (error) {
    // ENOENT (no .env) is fine — the key may already be in the environment.
    // Surface any other failure rather than silently recording with wrong env.
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
  }
}

export default defineConfig({
  // Same resolution note as vitest.config.ts: bare workspace names resolve
  // through the tsconfig.base.json paths facade; the native option cannot do
  // this (the root tsconfig is a solution file with no paths).
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    setupFiles: ['./scripts/test-invariants.ts'],
    include: [
      'scripts/session-snapshot-corpus.corpus.ts',
      // The assembled Web snapshot executes generated client bundles; source
      // mode remains the zero-build path, while lib mode requires a prior build.
      ...(process.env.DSH_EXAMPLE_MODE === 'lib' ? ['apps/web/tests/**/*.snapshot.ts'] : []),
      'snapshots/**/*.snapshot.ts',
    ],
    // Fork decision (FORK_CHANGES.md 2026-09-05): the sandbox capability is
    // disabled in the fork composition, so snapshots/acp/acp.snapshot.ts is
    // not collected — the escalation-approved, escalation-rejected, and
    // fs-escalation-approved scenarios replay recorded sandbox
    // denial→escalation→approval flows, and cancel, cancel-tool-calls, and
    // image-compaction fail with them (their sessions pin sandbox/approval
    // events and the class tool-schema headers escalate from the same
    // escalation-approved sidecar). The suite's fixtures make a scenario-list
    // exclusion impossible: every directory must stay registered and
    // escalation-approved doubles as the tokenized header-pin and schema
    // owner for every ACP class, so only handshake and reject-extra-dirs
    // could replay green and they cannot be registered without the pin owner.
    // Re-enabling the sandbox needs an explicit `disabled: false` and the
    // original provider `name`s (an overlay patch cannot clear the base's
    // sticky `disabled: true` or re-match the swapped names), so the old
    // fixture patches cannot revive the corpus. Restore path: clear the
    // `disabled: true` flags on sandbox/sandbox-policy/permission and revert
    // the executor rows' `name`s in packages/bundle/base/cordis.patch.yml
    // (or replay from an upstream-synced corpus), then delete this list.
    exclude: [
      'snapshots/acp/acp.snapshot.ts',
    ],
    // Replay never writes committed outputs and every scenario owns its
    // mutable runtime state (the subprocess suites use a unique temp dir and
    // fixture set per scenario), so replay runs the snapshot files in
    // parallel and bounds in-file concurrency with the environment knob
    // (value 1 restores fully serial replay on constrained machines). Record
    // and refresh stay serial: record spends real API quota per scenario, and
    // refresh write-back harvests volatile values from fixtures already on
    // disk, so concurrent writers would corrupt expected outputs.
    testTimeout: 120_000,
    hookTimeout: 30_000,
    fileParallelism: (process.env.DSH_SNAPSHOT || 'replay') === 'replay' && snapshotMaxConcurrency > 1,
    maxConcurrency: snapshotMaxConcurrency,
  },
})
