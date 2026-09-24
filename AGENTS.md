# AGENTS.md

DeepSeek Harness is an all-plugin Cordis agent harness. Read [docs/architecture.md](docs/architecture.md) before changing `packages/`; follow [docs/AGENTS.md](docs/AGENTS.md) for documentation.

## Fork policy: NolanHo/deepseek-harness

This checkout is a **personal fork** of [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness): `origin` is `NolanHo/deepseek-harness`, `upstream` is the DeepSeek AI repository. Fork `master` deliberately carries local customizations on top of upstream `master`; it is a customized build, never a mirror.

- **Sync before every change**: `git fetch upstream` at the start of every change session and check for a newer `dsh-vX.Y-rc*`/stable tag; never merge raw `upstream/master` — its alpha churn is skipped by the cadence rule below, which owns how upstream is absorbed and keeps fork `master` mergeable through tag merges. Upstream is the authority; the fork only absorbs updates from it.
- **Never contribute back**: do not push to `upstream`, do not open PRs against `upstream`, do not merge fork work into upstream. All changes stay in the fork.
- **Record every change**: append one entry to `FORK_CHANGES.md` (bilingual, append-only) per change: date, what changed, why. Keep personal changes small and reviewable.
- **Pick up upstream on a cadence**: merge every `dsh-vX.Y-rc*`/stable tag, never master's alpha churn, and refresh `FORK_SURFACE.md`. Its [sync runbook](FORK_SURFACE.md#sync-procedure-runbook) owns the release-note review, the `verify-fork-surface` gate and baseline, and each tier's re-application steps.
- **Retirement deletes the code**: when a fork surface retires because upstream serves it, the same change deletes its module, injections, locale keys, config rows, and tests, and appends the retirement to `FORK_CHANGES.md`. `FORK_SURFACE.md` keeps one `retired` line per surface as runbook history; no dead `fork/` module, forwarding shim, or feature flag survives, and no behavior keeps a fork path beside an upstream path. Prefer the upstream extension point (`Config` field, service, slot) over a copied implementation in the first place.
- **Dual-path changes resolve to upstream**: when the fork and upstream changed one behavior — the same file, the same algorithm, or two implementations of one user-visible outcome — the fork deletes its copy and adopts upstream's, even where the fork's version measures better: one implementation to maintain and re-apply at every sync beats a marginal local edge. Keep the fork's version only when upstream's cannot serve a current production consumer or leaves a reproduced defect, and record that reason beside the retained row in `FORK_SURFACE.md`.
- **Prefer upstream on parity; keep the fork minimal**: at every sync, walk `FORK_SURFACE.md` against the new tag — when upstream ships an equivalent, drop the fork row and adopt upstream's (record the retirement in `FORK_CHANGES.md`); every retained divergence states why upstream cannot serve it. New divergences justify themselves the same way, prefer `Config` fields over patches and `src/fork/` modules over upstream-file edits ([convention](FORK_SURFACE.md#the-fork-module-convention)).
- **Every row names a live consumer**: at each sync's parity review, confirm every retained `FORK_SURFACE.md` row still has a consumer — the deployment composition, an installed plugin, a recorded defect, or a measured win — and retire the row the day its consumer disappears (first consumer audit: 2026-09-19, outcomes in `FORK_CHANGES.md`).

## Working tree: branches, never a dirty main checkout

The main checkout serves the running dsh and hosts concurrent agent sessions. Develop on a git worktree at `<repo>/.worktrees/<slug>` (git-ignored) on its own branch, and land through a PR against `origin/master` (or a clean fast-forward merge when the branch stays local). Every worktree lives in that `.worktrees/` directory — never `/tmp`, a sibling path, or another clone: only there does it stay git-ignored and get swept with the repository. Remove it once its branch has landed. Never develop on, or leave uncommitted changes in, the main checkout: uncommitted fork docs or sources there block other sessions' merges. Commit or stash before ending a session; a branch keeps the work recoverable and mergeable.

## Landing changes in the running deployment

The running dsh serves the deployment clone (for example `/root/dsh-web/app`); its supervisor program must stay up while agents work.

- **Exercise the change on another port first**: every product-visible change runs end-to-end on a second `dsh web` instance (its own `DSH_HOME` and bind patch, e.g. port 3097+) against the built artifacts before the production instance is touched. Never restart production to find out whether a change works.
- **Isolate the second instance's Session storage too**: a second instance needs its own session database, not just its own `DSH_HOME`. A profile that still declares the production `session-persistence-sqlite` path (`path: /root/.dsh/sessions.sqlite`) opens the production database — and a staged `profiles/<name>` that symlinks back to the production profile carries that path with it. Two instances then hold the same Session, their append cursors diverge, and both lose turns to append conflicts (`session <key> append starts at seq N / stored next seq M`). Point the staging row at its own file, or at a snapshot copy of the production database when the real Sessions are needed, and prove single ownership before starting:

```sh
for p in /proc/[0-9]*; do ls -la "$p/fd" 2>/dev/null | grep -q '/root/.dsh/sessions.sqlite' && echo "$p"; done
```

Only the supervisor-managed `dsh-web` may appear; a second pid means the instance is not isolated.
- **Never restart the deployment: hand it to the human**: an agent's deployment work stops at built artifacts — reset the deployment clone, rebuild, verify the built bundle, then report the restart as pending. Restarting `dsh-web` is the human's action alone, on their schedule: a restart drops every live Session's stream and the browser reader attached to it, and the human may be mid-turn. No detached script, `supervisorctl` call, or other route restarts it on an agent's behalf, and an agent re-verifies the served bundle and the GUI only after the human reports the restart.

## Pre-stable APIs and released Session data

Public APIs are pre-stable; update every consumer. Follow [version/status](docs/session-format-status.md) and [type acknowledgements](docs/cookbook/reviewing-persistence-type-changes.md). [Adjacent migration](.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md) may add a version-named successor but never move, overwrite, or delete committed generations; predecessors imply neither fallback nor downgrade support. SQLite uses monotonic `SCHEMA_VERSION`.

Acknowledge [declared persistence-type changes](docs/cookbook/reviewing-persistence-type-changes.md).

**Application launch.** Only `dsh` profiles launch supported Node apps; package bins, demos, and public SDK argv escapes are forbidden ([rule](docs/architecture.md#application-launch)).

## Pre-release stance: foundation over blast radius

**Remove at the first tagged release.** Until then, prefer correct foundations to compatibility shims: rename or repackage freely and update every reference. Backends reject old on-disk formats. SQLite uses monotonic `SCHEMA_VERSION`; `dsh-session` keeps `SESSION_FORMAT_VERSION` at `0` with no compatibility promise.

## Repository layout

`vendor/` holds pinned Cordis source copies; `packages/` holds the `@deepseek-ai/dsh-*` workspaces grouped by capability family; `python/`, `native/`, `docs/`, `.agents/`, and `scripts/` complete the tree. The authoritative group-to-package map is [packages/README.md](packages/README.md); `docs/` owns [architecture](docs/architecture.md) and the generated catalogs.

## Commands

```sh
pnpm install            # pnpm workspaces, node ^22.19 || >=24
pnpm run clean           # remove build outputs and safe residue from deleted packages
pnpm run test           # unit tests
pnpm run test:coverage  # CI coverage gate: per-file 100% on packages/*/*/src
pnpm run test:e2e       # real-API tests; self-skip without DEEPSEEK_API_KEY
pnpm run test:expected  # owner-local process expectations
pnpm run test:snapshot  # keyless recorded-session replay through shipped profiles; filter: -t <name>
pnpm run test:snapshot:record  # re-record expected outputs (needs key)
pnpm run typecheck
pnpm run lint
pnpm run duplication    # cross-file TypeScript clone detection
pnpm run build          # tsc emits lib/types, tsdown bundles runtime
pnpm run hygiene        # publint + workspace/package/dependency checks + NodeNext consumer check
pnpm run check:windows-wine  # ONLY when diagnosing a known Windows failure (needs wine); CI owns this signal
pnpm run doc-sync       # documentation gates (scripts/run-gates.ts)
pnpm run test:docs      # quick documentation checks (no build; doc-quick aggregate)
pnpm run website:build  # VitePress build (doubles as dead-link check)
pnpm dsh --profile headless "task"  # run one task from source (needs DEEPSEEK_API_KEY)
pnpm run demo:ptc -- "task"  # headless PTC mode run (needs key)
pnpm run dev:web | dev:desktop  # build, then launch; Web also rebuilds client bundles on edits. start:web | start:desktop skip the build
make web|dev-web|desktop|dev-desktop|build  # the same commands; ARGS='--no-open' forwards options
```

### Host sandbox failures

If a required `gh`, `pnpm`, build, test, or generator command fails because the sandbox blocks credentials, network, IPC, watching, or nested `sandbox-exec`, retry unchanged with the narrowest host escalation. Require sandbox evidence; never bypass test failures or the product sandbox.

### Run relevant checks locally

Before pushing, follow [dsh-pre-push-checks](.agents/skills/dsh-pre-push-checks/SKILL.md); report only commands run. After `gh stack sync`, validate immediately; do not merge before checks pass.

- Match evidence to the surface: focused behavior tests, model/user-output snapshots, `doc-sync` for docs, built smokes for published paths, and real-API e2e for providers.
- Never default to the full suite or repeat a passing check for commit or push. CI owns exhaustive coverage and the platform matrix; rehearse all locally only by explicit request, for CI diagnosis, or for an irreducibly repository-wide change.
- `test:coverage`, not `test`, is the CI coverage gate ([why](docs/testing.md)).
- **Web browser automation and GIF recording:** launch with `pnpm dsh web --patch apps/web/tests/pin-browse-picker.overlay.yml` to use the [in-page directory picker](apps/web/tests/pin-browse-picker.overlay.yml); omit this override only when testing native picker behavior explicitly.

## Secrets / .env

Windows packaging/signing: [required reading](apps/desktop/README.md#windows-ev-signing).

Real-API tests/demos read `DEEPSEEK_API_KEY`, optional `DEEPSEEK_BASE_URL`, and root `.env`. cordis.yml allows `!!js` (never `!js`) under plugin `config` and entry `disabled`; other metadata stays literal, so conditional composition also uses overlays ([primer](docs/cordis-primer.md#loader-configuration)). Never commit credentials. CI e2e skips without a key; [testing.md](docs/testing.md) owns key policy.

## Conventions

- Packages use `@deepseek-ai/dsh-<name>`; vendor is [rescoped](docs/rescope.md) and `private: true`. Harness packages declare `@deepseek-ai/cordis` in `peerDependencies`/`devDependencies`. Workspace dependency sections use DSH `workspace:*`, vendor/native `workspace:~` ([rules](.agents/notes/implemented/process/2026-09-22-workspace-release-ranges.md)).
- ESM everywhere (`"type": "module"`). Use package names across packages and `.ts` in local relative imports. Config subprocesses run built `lib/` under plain Node; source regressions use their declared launcher ([testing policy](docs/testing.md#test-subprocess-launch-modes)). The `dsh` CLI source launch runs through tsx's ESM-only hook (`node --import tsx/esm`); modules it reaches must stay ESM (no CJS-only exports) — Node's native TypeScript modes are unavailable across the engines range ([source-launch contract](.agents/notes/implemented/architecture/2026-07-29-dsh-source-launch-tsx-esm.md)). Raw/Web `cordis.yml` bare plugins must appear in their resolver manifest's `dependencies`; `verify-cordis-config` enforces it.
- **Registrations are effects**: every contribution goes through `ctx.effect()` / `ctx.on()`; a registry's `register()` returns the disposer.
- **Runtime invariants assert owned relationships.** Publish `./invariant` only when independent observations can diverge. Otherwise omit its source and wiring and record why in its README; empty installers and checks of service presence, plugin metadata, effects, or fixed examples are invalid ([package invariant rules](packages/AGENTS.md)).
- **Typed events use declaration merging** and merge-extensible maps. Event JSDoc needs `@mode` and payload `@param`; scoped keys absent from payloads need `@dshScopeScan unsupported`. Public service methods document parameters and non-void returns. `SessionEventMap` members are required-on-read by default — builds that do not know a type refuse the log unless the event carries the envelope's `ignorable: true`; only structural format changes bump `SESSION_FORMAT_VERSION` ([mechanism](.agents/notes/implemented/architecture/2026-08-10-session-log-version-mechanism.md)).
- **Switch on discriminant tags.** Closed unions end in `assertNever`; merge-extensible unions fall through a documented default.
- **Waterfall listeners MUST call `next()`** to delegate; returning without it short-circuits the chain ([semantics](docs/cordis-primer.md#cordis-waterfall-semantics)).
- **Model-visible ⟺ logged**: anything that reaches a model request must be reconstructable from the session log; a new model-visible input requires a session event.
- **Plugins, not loop changes**: new behavior goes on documented extension points; changing `agent-loop` requires updating docs/architecture.md.
- **A capability seam comprises Service Definition / Service Provider / Consumer roles.** It is complete, never one role; split only when roles evolve independently ([glossary](docs/glossary.md#capability-seam)).
- **Prefer maintained dependencies over hand-rolling** when they genuinely delete owned code and tests ([policy](.agents/notes/implemented/process/2026-07-26-dependencies-over-hand-rolling.md)).
- **Explicit > implicit at package boundaries**: defaulting is an explicit `resolve(request): Spec` step in the owning implementation, never a hidden `?? default` inside `run()` (the `dsh-shell` request/spec split is the template).
- **No hardcoded tunables in plugins**: deployment-varying choices are validated `Config` fields changeable from cordis.yml; a `DEFAULT_*` constant or test hook is not configurability. Protocol constants, external specs, and security invariants stay fixed.
- **Misconfiguration fails loud** at load when self-contained, otherwise at the earliest resolvable point; never silently skip a missing referent.
- **Opaque cross-boundary ids are branded** (`Branded<B>` from `dsh-brand`), never bare `string`.
- **Trust TypeScript at typed same-process boundaries.** Do not add runtime validation, fallback behavior, or hostile-input tests solely for values the static interface requires; validate at parser/config, queued, model/tool JSON, durable/file, worker, process, and wire boundaries.
- **No new assertions to `unknown`** (`as unknown` or `<unknown>`). Preserve or reduce the exact legacy baseline; use typed values or validation for replacements ([rule](.agents/notes/implemented/process/2026-09-19-no-unknown-casts.md)).
- **Source plane vs artifact plane, never mixed.** Static gates and tests resolve workspace imports through tsconfig `paths` to `src` and pass on a clean tree; gates consuming built `lib/` declare that dependency ([layout](docs/development.md#typescript-project-layout)).
- **Keep compiler faces explicit.** A package with both Host and Client programs exposes face-specific leaf configs and a solution-only root; repo-wide programs seed a face config, never the root solution ([layout](docs/development.md#typescript-project-layout)).
- **An empty `catch` names the error** and why; keep its `try` to one statement.
- **Keep comments local.** Do not restate code, expand unrelated comments, or explain distant behavior without local need ([rationale](.agents/notes/implemented/process/2026-08-09-concrete-prose-names-actors-and-recorded-facts.md)).
- **Ban `prove` + `nance`** ([rule](.agents/notes/implemented/process/2026-08-26-ban-ambiguous-origin-label.md)).
- **Prefer symmetry for parallel values**; unexplained asymmetry usually signals a missed extraction.
- **Tests describe behavior, not correctness.** Change obsolete behavior with its tests; explain why in the PR.
- **Create Agent Notes only for durable decision rationale;** mechanical/local edits are exempt, including local UI changes ([scope](.agents/notes/README.md#when-to-write-one)). Archived notes are frozen: never edit or treat them as current authority ([archive policy](.agents/notes/README.md#archiving-and-deletion)).
- **Client UI copy is locale-owned.** Route product text through typed dictionaries and `t` or localized primitive props; `verify-client-ui-i18n` rejects hardcoded copy ([decision](.agents/notes/implemented/architecture/2026-08-23-locale-owned-client-ui-copy.md)).
- **Testing policy** — [docs/testing.md](docs/testing.md). Every non-trivial model- or product-user-visible change updates a keyless recorded-session snapshot; [snapshot ownership](snapshots/AGENTS.md) reserves the top-level tree for session-driven cases and keeps other expected output owner-local. Fixtures replay on macOS/Linux; fix fixtures, not normalizers.
- **Design each tool's UI presentation up front.** Host presenters stay pure; Web cards derive from raw events and persisted result metadata ([cookbook](docs/cookbook/adding-a-tool.md)).
- **Plan unit, e2e, and snapshot coverage** for capability seams, lifecycle paths, and transcript output; include missing snapshot-harness support in the same change.
- **Both SDKs project the loop.** Agent-loop, session-lifecycle, and `SessionEventMap` changes update the TypeScript and Python SDK expected outputs in the same PR; `pnpm run test` covers neither ([surfaces](docs/testing.md#when-a-snapshot-test-is-required)).
- **Choose PR history deliberately.** Split independent changes and fix the introducing PR before propagation. Standalone/stack branches may merge-forward or rebase. Rewrites use `--force-with-lease`, abort on remote movement, never raw `--force`; preserve an in-progress merge-forward checkpoint before taking a newer base ([rationale](.agents/notes/implemented/process/2026-08-02-native-github-stacks-and-optional-rebases.md)).
- **Labels:** one PR `kind/*`, all material `area/*`, and native Issue Type ([taxonomy](.agents/notes/implemented/process/2026-08-08-unified-github-label-taxonomy.md)).
- TODO markers: `FIXME`/`TODO`/`XXX` by urgency ([semantics](docs/development.md)).
- Files end with exactly one trailing newline; `git diff --cached --check` (pre-commit) gates it.

## Defensive patterns

Read [docs/defensive-patterns.md](docs/defensive-patterns.md) before lifecycle, concurrency, subprocess, or teardown work.

## Type safety and documentation

Everything compiles under `strict: true` with `noImplicitAny`; every remaining `any` explains why narrowing is infeasible. Every module and export has concise JSDoc for its non-obvious contract; function-like exports include `@param`/`@returns`, as enforced by `verify-export-jsdoc`. Heritage-declared members, plugin-protocol slots, and constructors keep their docs at the declaring Service Definition, protocol, or class.

Comments and docs state complete contracts and context, not reasoning transcripts. Use direct, concrete terms. Do not use metaphors. Before writing `contract`, `boundary`, or `shape`, ask whether a more exact term names the subject: write `response fields`, `JSON validation`, or `ESM exports` instead of `response shape`, `validation boundary`, or `module shape`. Keep `contract` for preconditions, postconditions, invariants, compatibility promises, and other obligations that callers, callees, implementers, providers, producers, or consumers rely on. Keep a literal process, wire, security, transaction, or lifecycle boundary. Do not narrate control flow or tests, preserve review history, or restate code. Keep behavior, failure, timing, ownership, and safe-use facts; link the rationale. Use [dsh-prose-standard](.agents/skills/dsh-prose-standard/SKILL.md) for decisions. Wire mechanically checkable invariants into an executed top-level gate and prove each changed acceptance path rejects an invalid case. Use narrow, justified exceptions instead of disabling a rule globally.

Docs accompany every code change: update affected README and JSDoc contracts together. Routine bilingual work follows [docs/AGENTS.md](docs/AGENTS.md); only explicit user invocation may run `dsh-translate-docs`. Current-state prose, one physical line per paragraph, one home per fact, and word budgets live there.

## Editing these instructions

`CLAUDE.md` symlinks `AGENTS.md` at root and `packages/`; edit the real file. Keep each rule self-contained while linking high-level docs. Condense when clarity survives; raise a `verify-doc-budgets` ceiling when the required content genuinely needs more space.

## Vendoring policy

`vendor/` packages are pinned source copies (manifest with upstream SHAs in [vendor/README.md](vendor/README.md)). Update via the sync procedure there; re-apply or retire the logged local modifications; rerun `pnpm run test && pnpm run build`.
