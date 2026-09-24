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
    // apps/web/tests/expected/settings-chrome/, permission-policy-context
    // replays the sandbox-policy scenario recorded under
    // snapshots/web/permission-policy-context/, access-confirmation drives the
    // Access-mode picker into Full access through the permission preset table,
    // and seeded-history lands a `/permission read-only` command row through
    // the Access chip. All five hard-assert composition the fork no longer
    // mounts (the permission switcher renders nothing without the host
    // permission service). approval-composer replays the recorded approval
    // session under snapshots/web/approval-composer/ and opens it by driving
    // the same Access-mode chip (`[aria-label^="Access mode"]`) into Read
    // Only: the chip renders only from the host permission service's
    // `permissions` projection (InputBar.tsx), absent on the fork, so the
    // suite cannot reach its approval-takeover subject either. ptc-escalation
    // (new in dsh-v0.1.7-rc.1) drives the same absent chip into Read Only to
    // record a sandbox escalation, so the fork composition cannot reach its
    // subject. Restore path: clear the `disabled: true` flags on
    // sandbox/sandbox-policy/permission and revert the executor rows' `name`s
    // in packages/bundle/base/cordis.patch.yml, then delete this list.
    //
    // reasoning-preview (new in dsh-v0.1.7-rc.1) pins upstream's streaming
    // reasoning preview — the first-line text behind a fade mask. The fork's
    // ReasoningRow patch replaces that surface with the character-count summary
    // (FORK_SURFACE.md: reasoning row summary), so the preview it drives does
    // not exist here. Restore path: drop the fork's ReasoningRow patch and
    // re-record snapshots/web/reasoning-preview.
    exclude: [
      'apps/web/tests/settings-chrome.e2e.ts',
      'apps/web/tests/permission-policy-context.e2e.ts',
      'apps/web/tests/access-confirmation.e2e.ts',
      'apps/web/tests/seeded-history.e2e.ts',
      'apps/web/tests/approval-composer.e2e.ts',
      'apps/web/tests/ptc-escalation.e2e.ts',
      'apps/web/tests/reasoning-preview.e2e.ts',
    ],
    // Local and record runs stay serial. CI runs workspace-mutating HMR and
    // dynamic Cordis lifecycle coverage before parallelizing the remaining files.
    testTimeout: 180_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
