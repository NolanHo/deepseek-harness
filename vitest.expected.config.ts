import { availableParallelism } from 'node:os'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

/** Owner-local assembled expected-output tests that do not use a recorded session as their input. */
export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    setupFiles: ['./scripts/test-invariants.ts'],
    include: [
      'apps/cli/tests/**/*.expected.e2e.ts',
    ],
    // Fork decision (FORK_CHANGES.md 2026-09-05): the sandbox capability is
    // disabled in the fork composition, so these expected-output suites are
    // excluded — subagent-inheritance replays a delegation into the read-only
    // sandbox mode and pins the sandbox/mode event, the sandbox-policy prompt
    // context, and the sandbox denial output in its assembled expectations,
    // and image-offload's assembled runtime context pins the
    // sandbox-policy-generated `Current DSH file policy` sentence (its only
    // producer). Both hard-assert composition the fork no longer mounts.
    // Restore path: clear the `disabled: true` flags on
    // sandbox/sandbox-policy/permission and revert the executor rows' `name`s
    // in packages/bundle/base/cordis.patch.yml, then delete this list.
    exclude: [
      'apps/cli/tests/profiles/headless/tests/subagent-inheritance.expected.e2e.ts',
      'apps/cli/tests/profiles/acp/tests/image-offload.expected.e2e.ts',
    ],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    maxWorkers: Math.min(5, availableParallelism()),
  },
})
