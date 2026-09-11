# Agent Note: Released v0 descriptor versions reach the installed schema

Status: implemented

English | [中文](2026-09-11-released-v0-descriptor-admission.zh.md)

## Problem

The released-v0 edge admitted `subagent/descriptor` payloads at version 3 alone, the version current when format v0 shipped. The installed `@deepseek-ai/dsh-subagent` stamps version 4 (`SUBAGENT_DESCRIPTOR_VERSION`), so a v0 Session holding a descriptor written under another version refuses `@deepseek-ai/dsh-session-format-v0-to-v1` before its store grants write access: `persistence.open(id, 'write')` throws `SessionFormatUnsupportedMigrationError`, the Session cannot migrate, and a new turn in it fails. The deployed store holds 791 such Sessions — 569 at descriptor version 4 and 222 at version 2, 437 of them above 1,000 stored events. A version 2 payload carries mode, provider, label, and the resolved child provider and model; every one of those members is a member of the version 4 schema, so the refusal protects no stored information.

## Decision

- `packages/session/session-format-v0-to-v1/src/fork/subagent-descriptor-compat.ts` owns the released descriptor compatibility: `CURRENT_SUBAGENT_DESCRIPTOR_VERSION`, the released member inventory, and `upgradeReleasedSubagentDescriptor`. `dispositions.ts`, `migration.ts`, `payload-validation.ts`, and `validation.ts` keep marked `// Fork patch (FORK_SURFACE.md)` delegations into it.
- The constant is the value `packages/subagent/subagent/src/descriptor.ts` exports as `SUBAGENT_DESCRIPTOR_VERSION`; this edge reads it here instead of importing that package. Every released-format restore loads this edge, and the subagent seam would bring its product peers (agent, tools, jobs, sandbox, llm among them) into the restore path of historical Sessions. `tests/descriptor-compat.spec.ts` imports the owning definition by relative path and asserts equality, so a descriptor version bump fails that test instead of drifting silently.
- The released member inventory admits `cwd` and `skillFilter` beside the earlier optional members, and `payload-validation.ts` validates both: `cwd` as a non-empty string, `skillFilter` as the `allow`/`deny` record form `toolFilter` already uses. A payload the installed build wrote passes the frozen member and payload rules unchanged.
- The v0 normalizer stamps `CURRENT_SUBAGENT_DESCRIPTOR_VERSION` onto a descriptor carrying a released older version whose members the installed schema declares for its mode. It adds no member: those generations predate the composition inputs the newer version introduced, so the upgrade preserves the declared composition exactly. A one-shot payload admits only `label` beside its required members, so one carrying a continuable-only member refuses.
- A descriptor declaring a member the installed schema does not, a version newer than the installed one, or a version below version 2 refuses with `SessionFormatUnsupportedMigrationError` — the error the edge already raised for every non-3 version. No member is dropped silently and no value is fabricated.
- `assertReleasedEventPayload` admits version 3 and the installed version; the released-v1 edge keeps passing every other version through untouched, as it did before.

## Alternatives considered

**Import `SUBAGENT_DESCRIPTOR_VERSION` from `@deepseek-ai/dsh-subagent`.** The value would have one home and no parity test, and no import cycle follows. It costs a runtime dependency from a released-format codec to the subagent seam on the restore path of every historical Session, plus the package manifest and tsconfig reference that declares it. The parity test buys the same alert without either.

**Keep refusing every descriptor the edge did not freeze.** The refusal is loud and drops nothing on the reading side. It also leaves the containing Session permanently unwritable, because the store publishes a migrated log before it grants write access, so 791 deployed Sessions cannot accept a new turn — the state this change removes.

**Stamp the payload down to version 3 while migrating.** The installed fold reads version 3 as unsupported, so the child would stay non-resumable while its own payload named a version its reader rejects; the migrated log would contradict itself.

**Upgrade every version below the installed one, however old.** A generation this edge never saw may use the admitted member names with other meanings. Version 2 is the oldest generation released v0 logs carry (the deployed store holds versions 2 and 4 and nothing below), and its members mean what version 4 means.

**Teach `foldSubagentDescriptor` to read versions 2 and 3.** The descriptor's versioning rule makes a composition input a deliberate version change, and cold resume reconstructs composition through the installed reader. Migration owns on-disk compatibility; the fold owns the current schema.

## Consequences

- A released v0 Session migrates whatever released descriptor version it holds and accepts turns again. Its log carries the installed version, which is the version the installed fold classifies.
- Migration rewrites descriptors older than the installed version, so a migrated Session's payload differs from the bytes its writer stored. A stored version number is not meant to be read back out of a migrated log; the containing Session has already moved to the current format.
- One fork-owned module and four marked delegations sit in an upstream-owned package. A descriptor version bump moves the constant and the member inventory in that one module, and the parity test fails before anything else.
- The released-v1 edge validates the installed descriptor version's members where it previously skipped every payload outside version 3. A v1 Session whose version 4 payload declares an undeclared member now refuses instead of passing through unread; a well-formed payload written by the installed build validates as before.

## Testing

`packages/session/session-format-v0-to-v1/tests/descriptor-compat.spec.ts` migrates a version 4 payload carrying `cwd` and `skillFilter`, upgrades the version 2 payload the store holds and a version 3 one-shot payload, folds every migrated payload through `foldSubagentDescriptor`, and asserts each refusal (undeclared member, newer version, version below the released floor) with its error type and message. `packages/session/session-persistence-sqlite/tests/sqlite.spec.ts` opens a v0 fixture whose child descriptor carries version 4 for write and reads back the published Session — the production symptom this change removes, which that test reproduced as `subagent/descriptor 2 uses unsupported descriptor version 4` before the change. The record lane's output is identical with and without this change (99 failed / 16 passed / 2 skipped on this fork before and after); its remaining failures are the disabled sandbox composition, not descriptor handling.

## Related

[Per-child cwd and skill scoping for in-process subagents](../feature/2026-08-29-subagent-child-cwd-skillfilter.md) owns the version 4 descriptor, its `cwd` and `skillFilter` members, and the version 3 → 4 bump this migration compatibility follows.
