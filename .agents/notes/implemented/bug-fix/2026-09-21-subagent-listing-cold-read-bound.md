# Agent Note: A catalog listing bounds its cold Session reads

Status: implemented

English | [中文](2026-09-21-subagent-listing-cold-read-bound.zh.md)

> Scope: why `SubagentRuntime` exposes `coldReadConcurrency` and `coldReadBudget`, what one listing's budget is spent on, what a beyond-budget child reports, and why the budget counts Session reads rather than cold candidates.

## Problem

Opening the Web client on a workspace of 422 subagent Sessions whose projection cache was cold made the Host unusable. `subagents.list` resolved every non-live child by reading and decoding that child's complete stored Session log (`loadStoredLog`) — one whole-log zstd decode per child — and the first GUI load ran 423 such decodes per pass across 4–5 passes. On the production-isomorphic isolated instance that pinned one core at 100% for about 8 minutes; every RPC and stream sharing the event loop stalled, and clients timed out and reconnected for the duration.

A warm projection cache serves the same listing with zero Session reads, so the cost is a tail risk rather than an everyday one: it returns whenever the cache cannot answer — a new `DSH_HOME`, one projection unit's `stateVersion` change, a rewrite's `discard`, or lost storages. Upstream bounds only how many cold reads run at once, with the hardcoded `COLD_READ_CONCURRENCY = 4`; nothing bounds how many one listing starts, and no deployment setting exists at all.

## Decision

**Two validated `Config` fields bound one listing.** `coldReadConcurrency` (`z.natural().min(1).default(4)`) caps cold reads in flight, and `coldReadBudget` (`z.natural().min(1).default(64)`) caps the reads one listing starts. `SubagentRuntime` resolves both once in its constructor into `listingLimits` and passes them to `listChildren` and `listDescendants`, which forward them to the shared listing core in `src/list-children.ts`. Both defaults reproduce a serving state: `4` is the ported hardcoded constant, and `64` resolves a workspace of that size within one listing.

**The budget counts Session reads, never candidates.** A candidate the projection cache can answer is resolved to its row before selection (`cachedColdIdentity`), so it spends neither the budget nor a concurrency slot. Candidates that still need a read are taken in corpus order (`selectColdReads`) and drained by `coldReadConcurrency` workers (`observeColdIdentity`).

**A deferred candidate keeps the listing's existing vocabulary.** Every candidate past the budget reports the retryable `{kind:'diagnostic',reason:'unavailable'}` row the listing already produced for an absent or transiently failed observation, at its own corpus position. No wire value, error code, or ordering rule is added: the client's existing `unavailable` handling applies, and a later listing picks the candidate up. A read that fails for a final reason still reports `corrupt` as before; cancellation is unchanged, with `signal` observed around every persistence read.

**Advance is monotonic by construction.** Because cache-served candidates never enter the read queue, a repeated listing spends its budget on children it has not resolved yet instead of the same head. A child created after a listing appears in the next one, and can only be deferred while children ahead of it still need reads — never permanently behind rows the cache already serves.

**There is no unbounded setting.** Both fields validate `min(1)`; a deployment that must resolve a very large cold workspace in fewer listings raises `coldReadBudget` instead of disabling the bound. An unbounded listing is the reproduced defect.

## Alternatives considered

**Count the budget over cold candidates, before the cache rung.** A budget read literally — "the first N cold candidates per listing" — would spend itself on the same head every time: once those candidates are cache-served they would still consume it, so the tail would never be read and a child created behind a cache-served head would stay `unavailable` forever. Resolving the cache rung first is what lets the bound advance.

**Raise the concurrency constant instead.** The cost is `children × log length`: four concurrent whole-log decodes over 423 children is the same eight minutes of work at any concurrency. Concurrency bounds the peak one listing can demand, not the total, and a bare constant is not a deployment setting ([rule](../../../../AGENTS.md#conventions)).

**Bound by elapsed time or bytes.** Neither quantity is known before a read starts: a stored log's size arrives with the read, and a wall-clock budget makes a listing's output depend on host speed and load. A count of reads is checkable before each read begins, so a listing's worst case is knowable in advance.

**Report a distinct diagnostic for a deferred child.** A new reason would have to mean something to every client and to the wire contract, while "not read yet" is exactly what the existing retryable `unavailable` already says. Nothing in the client needs to distinguish a deferred read from a failed one.

**Stream the listing — live and cached rows first, cold rows as they resolve.** That changes the listing's wire contract and needs client work for ordering and re-listing; the per-candidate diagnostic the contract already carries makes the bound sufficient.

**Leave the cold path alone and rely on `asyncCodec`.** The sibling switch moves zstd decompression to the libuv pool, but the reads still happen, their count is unchanged, and the observation and projection folds still run on the event loop; the bound is orthogonal to where a decode runs ([async codec note](../feature/2026-09-20-async-session-codec.md)).

## Consequences

A cold workspace now resolves over ⌈children/64⌉ listings instead of one, and the deferred children render the diagnostic row the client already retries. In exchange one listing can no longer hold the event loop for minutes: its peak work is 64 reads with 4 in flight. A workspace inside the budget behaves exactly as before — cache-served candidates bypass the read queue entirely, and the concurrency default is the ported constant. The two bounds are deployment tunables, so serving a larger workspace is a configuration decision rather than a code edit.

Cost: `src/list-children.ts` now carries a fork-owned bound — the limits parameter through `prepareListing`, the projection-cache rung extracted into `cachedColdIdentity`, and `selectColdReads` — that an upstream sync must re-apply; `src/index.ts` carries the `Config`, the resolved `listingLimits`, and both call sites. The row in [FORK_SURFACE.md](../../../../FORK_SURFACE.md) records those sites.

## Testing

`packages/subagent/subagent/tests/list-children.spec.ts` gains the `SubagentRuntime cold-read bounds` block, which mounts the runtime over a synthetic cold corpus served through a mocked `sessionQuery` (no persistence backend and no Agent runtime take part) and counts every observation:

- the shipped defaults (`4`, `64`), the rejection of a bound below one at both the schema and the mount, and the same defaults on a directly constructed plugin (peak 4 with six candidates);
- a budget of 2 over 5 candidates reads exactly the first two and reports the remaining three `unavailable`, in corpus order;
- the default budget resolves every candidate of a corpus that fits;
- `coldReadConcurrency: 2` with six candidates holds both admitted reads open, proves a third never starts, and then resolves all six;
- after the cache serves the two read children, the next listing spends its budget on the remaining two and resolves the whole corpus — the observation order proves the advance.

`npx vitest run packages/subagent/subagent/tests/list-children.spec.ts` passes all 69 cases of that file, the new block among them. The production-scale reproduction (422 children, ~8 minutes of one pinned core) was measured on the isolated production-isomorphic instance before the change and was not repeated: the bound's effect is proven at the listing unit level — read counts and concurrency peaks — not by a wall-clock cold-load measurement, and no browser test renders a beyond-budget row, because that path is the existing `unavailable` diagnostic whose client handling is unchanged.

## Related

- The package README owns the operator-facing field table and startup behavior: [subagent](../../../../packages/subagent/subagent/README.md)
- The subsystem page owns where listing sits in the delegation surface: [subagent](../../../../docs/subsystems/subagent.md)
- The fork inventory row this surface is registered under: [FORK_SURFACE.md](../../../../FORK_SURFACE.md)
- The decoder cost this bound limits how often a listing pays: [async codec note](../feature/2026-09-20-async-session-codec.md)
