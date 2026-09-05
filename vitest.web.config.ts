import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

// Web browser lane: real host entry points, built-client interaction snapshots,
// and replayed keyless e2e scenarios outside the unit/e2e includes. Linux PR CI
// pins DSH_SNAPSHOT=replay and compares committed goldens; record/refresh remain
// explicit local workflows. Real-model cases self-skip without DEEPSEEK_API_KEY.
try {
  // Node >= 21.7 native; throws when the file does not exist.
  process.loadEnvFile(new URL('.env', import.meta.url).pathname)
} catch {
  // No .env — fine, the environment may already carry the variables.
}

export default defineConfig({
  // Same resolution note as vitest.config.ts: the tsconfig.base.json paths
  // facade has no include (match-all), so apps/web/tests resolves bare
  // workspace imports to source like every other lane.
  plugins: [
    tsconfigPaths({ projects: ['./tsconfig.base.json'] }),
    standardDecoratorPlugin(),
  ],
  test: {
    execArgv: vitestExecArgv,
    include: [
      'apps/web/tests/**/*.e2e.ts',
      'apps/web/tests/**/*.snapshot.ts',
      'packages/experimental/inspector/tests/client-browser.e2e.ts',
    ],
    // Fork decision (FORK_CHANGES.md 2026-09-05): the sandbox capability is
    // disabled in the fork composition, so these browser suites are excluded —
    // settings-chrome asserts the Permission settings row against goldens in
    // apps/web/tests/expected/settings-chrome/, and permission-policy-context
    // replays the sandbox-policy scenario recorded under
    // snapshots/web/permission-policy-context/. Both surfaces hard-assert
    // composition the fork no longer mounts. Restore path: clear the
    // `disabled: true` flags on sandbox/sandbox-policy/permission and revert
    // the executor rows' `name`s in packages/bundle/base/cordis.patch.yml,
    // then delete this list.
    exclude: [
      'apps/web/tests/settings-chrome.e2e.ts',
      'apps/web/tests/permission-policy-context.e2e.ts',
    ],
    // Local and record runs stay serial. CI runs workspace-mutating HMR and
    // dynamic Cordis lifecycle coverage before parallelizing the remaining files.
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
