# Agent Note: Restored children keep their descriptor identity

Status: implemented

English | [中文](2026-09-23-restored-child-descriptor-identity.zh.md)

> Scope: how the `subagent` identity projection reads the descriptor generation a restored child log carries, and why the resume fold deliberately stays strict. The [subagent](../../../../packages/subagent/subagent/README.md) README owns the package's descriptor and projection contracts.

## Problem

Opening a migrated historical subagent child answered `RemoteError: subagent descriptor is corrupt` (`packages/api/session-controller/src/history.ts`, `validateAddress`, code `subagent/catalog-diagnostic`) even though the parent's own catalog listed that child and `listChildren` returned it with its mode and label. `apps/web/tests/preset-migration.snapshot.ts` failed both of its cases on that call after the `dsh-v0.1.7-rc.1` merge, and it was the last fork adaptation gap of that sync.

The cause is the fork's own descriptor generation. This fork stamps version 4 into every new `subagent/descriptor` for its per-child `cwd` and `skillFilter` composition inputs (FORK_SURFACE row `subagent` per-child cwd + skillFilter); a released log restored from disk keeps the generation its writer stamped — version 3 in the reproducing fixture. The released-v3 catalog edge already interprets generations 1 through 4 for the parent's membership, so the parent listed the child. The child's own `subagent` identity projection did not: `foldSubagentDescriptor` returns a descriptor only for the installed version, and a projection fold must never throw, so an unreadable generation folds to the state that serves the `null` sentinel — which `validateAddress` reports as a corrupt descriptor. Instrumenting the failing path showed the child's own event `{"version":3,"provider":"spawn","mode":"one-shot","label":"historical child"}` folding to `subagent: null` at `inheritedEventCount` 0.

## Decision

The `subagent` identity projection reads a released descriptor generation, at `packages/subagent/subagent/src/fork/released-descriptor-identity.ts` (`foldReleasedDescriptorIdentity`) through one marked delegation in `projection.ts`'s identity fold. The module takes a payload whose `version` is a safe integer below the installed one and at or above 2, stamps a copy with the installed version, and folds that copy through `foldSubagentDescriptor` — so the identity comes from the same schema the strict fold uses, an undeclared member or a damaged identity field establishes nothing, and version 1 (no `mode` field) stays unreadable. The `subagent` projection's `stateVersion` moved 2 to 3 so a row already cached as the `null` sentinel refolds instead of surviving the change.

Two boundaries are deliberate. `foldSubagentDescriptor` keeps refusing a released generation, because the resume composition needs the inputs version 4 added and a released payload cannot supply them: a restored continuable child is openable, listable, and steerable, and a cold resume still reports unsupported. And no stored payload is rewritten: upstream's contract that a migrated child's body survives V3 to V4 verbatim, which its own `preset-migration` spec asserts, stays intact.

## Alternatives considered

**Stamp the released descriptor at the V3-to-V4 migration edge, as the released-v0 edge does with `upgradeReleasedSubagentDescriptor`.** That would make the stored child log literally an installed-generation log, so identity and resume would both work, and it is the fork's registered convention on the other edge. It lost because it edits a payload owned by another seam to compensate for this one, and because it contradicts an upstream expectation the fork has not diverged from: the migration preserves a child's events verbatim, and the fixture's own successor body is asserted field for field.

**Loosen `foldSubagentDescriptor` to accept released generations.** One fold for every reader, no second rule. It lost because the resume composition would then be rebuilt from a payload that predates `cwd` and `skillFilter`, silently resuming a child with composition its descriptor never declared — the outcome the descriptor version exists to prevent.

**Read the identity from the parent's `subagent/catalog` fact instead.** The fact already carries mode and label, and the fork's SQLite and JSONL restore paths build it for exactly this reason. It lost because the address fence's evidence has to be the child's own declaration: the catalog is the parent's claim about the child, and an address authorizes delivery into the child, not into the parent's memory of it.

**Keep the released generation unsupported and the diagnostic as is.** That is the honest reading of one log and needs no code. It lost because this deployment's own restore already interprets the same payload to list the child, so `listChildren` promised an openable child that the app then refused — the two readers of one fact disagreed.

## Consequences

A restored child whose descriptor carries generation 2 or 3 now serves the identity a native child serves, so the address fence accepts it, `listChildren`'s live-identity path agrees with its catalog fact, and queue actions see the mode the catalog already reported. Identity is all that changed: the resume fold, the descriptor schema, the descriptor version, and every stored byte are untouched, and a generation at or above the installed one, a version below 2, and a payload the installed schema refuses all still fold to no identity. The projection-cache version bump discards cached identity rows once, so the first observation after this change refolds from the durable log.

## Related

[Per-child cwd and skill scoping for in-process subagents](../feature/2026-08-29-subagent-child-cwd-skillfilter.md) owns the version 4 descriptor and the per-child `cwd` and `skillFilter` members this compatibility reads around. [Released v0 descriptor versions reach the installed schema](2026-09-11-released-v0-descriptor-admission.md) owns the released-v0 edge's own upgrade of those payloads at migration time, and [Preserve V3 Sessions with incomplete child catalog evidence](2026-09-19-v3-incomplete-child-catalog-evidence.md) owns what the parent's catalog records for the same child.

## Testing

`packages/subagent/subagent/tests/released-descriptor-identity.spec.ts` covers the released one-shot and continuable identities, the installed generation, version 1, a generation newer than the installed one, a released payload carrying an undeclared member or an invalid mode, a non-descriptor event, a non-numeric version, and that the strict fold still refuses a released generation for resume. `packages/api/session-controller/tests/session-cold.host.spec.ts` adds the app-level case: a cold child whose own descriptor carries generation 3 pages through `SessionHistoryController.page({ address: subagent })`. Both are RED with the delegation commented out — the unit cases on the projection value and the cold-child case on `RemoteError: subagent descriptor is corrupt` — and green with it; `apps/web/tests/preset-migration.snapshot.ts` passes.
