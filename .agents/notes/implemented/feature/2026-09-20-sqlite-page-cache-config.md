# Agent Note: The SQLite session store takes its page cache from a validated Config field

Status: implemented

English | [中文](2026-09-20-sqlite-page-cache-config.zh.md)

> Scope: why `@deepseek-ai/dsh-session-persistence-sqlite` exposes `cacheSizeKib`, why its value is substituted into the pragma statement instead of bound, and what the connection's read-back guarantees.

## Problem

Every connection the provider opened carried SQLite's compiled page-cache suggestion — `-2000` KiB, about 1.95 MiB — with no field to change it. How much page cache a session store gets is a deployment-varying tunable, and this repository keeps those in validated `Config` fields ([rule](../../../../AGENTS.md#conventions)); reaching a different size meant editing package code and re-applying the edit at every upstream sync.

## Decision

`cacheSizeKib?: number` is a `Config` field on `SqliteSessionPersistence`, validated as `z.number().step(1).min(0).max(MAX_CACHE_SIZE_KIB)`. `configurePageCache` applies it inside `openDatabase` after the journal mode and the durability settings, so every connection the provider hands out carries its own value.

**Omitted or empty executes no pragma**, so a deployment that sets nothing — or leaves the `cordis.yml` value empty, which arrives as null — keeps SQLite's default suggestion and changes nothing about the connection; the field is the switch's on state rather than a new default.

**The value is substituted into the statement, never bound.** SQLite's pragma grammar takes no parameter — `PRAGMA cache_size = ?` fails with `near "?": syntax error` on the SQLite 3.51.3 that Node ships — so `resources/sql/cache-size.sql` declares `PRAGMA cache_size = -?` and `sql('cache-size', n)` replaces that one token. The substitution is confined to it: the `sql()` overloads accept an argument only for `'cache-size'`, any other resource name with an argument is a compile error, and `tests/sql-resource-boundary.spec.ts` rejects every `sql`/`testSql` call in `src` or `tests` whose argument does not follow the `'cache-size'` name.

**Application is verified, not trusted.** The connection reads `PRAGMA cache_size` back and rejects the open when it did not retain `-cacheSizeKib`, naming the retained and the expected KiB; the failed connection closes. `0` needs no branch in that comparison: `-0` and `0` are equal under `===`.

**`0` means SQLite's zero-page suggestion.** The connection applies `-0`, which SQLite floors to 10 pages. It is not the 2,000 KiB default, and it is not how a caller restores it.

**The field's ceiling is `MAX_CACHE_SIZE_KIB = 2_147_483_647`**, the INT32_MAX magnitude it carries. SQLite also accepts the literal `-2147483648`, one past that magnitude, which the field never emits.

**Three physical settings stay untouched on purpose**: `mmap_size = 0` (memory-mapped I/O carries SIGBUS semantics against truncation, and the connection read-back pins the value on a file-backed connection), `synchronous = FULL`, and the 64 KiB `page_size`. Each one reopens its own durability argument, so configuring them is separate work.

## Alternatives considered

**Bind the value as a SQLite parameter.** The engine refuses it: a pragma statement accepts no bind parameter, so the choice was substitution or no field at all.

**Substitute a caller value into any resource through `sql()`.** A general interpolation path would put caller text into every packaged statement, the schema and the transaction statements included. The overload plus the boundary spec keep the free variable to the one statement whose grammar needs it.

**Trust the pragma and skip the read-back.** A pragma SQLite ignored would leave a deployment running a cache size nobody chose, with the field silently lying about the connection. The package's other connection settings already read back and fail loud.

**Let `0` restore SQLite's default.** The pragma's own `0` is the zero-page suggestion, and a reset semantic would need a second sentinel and diverge from the documented behavior; a deployment that wants the default omits the field.

**Make `mmap_size`, `synchronous`, and `page_size` configurable in the same pass.** Each is a durability or failure-mode decision of its own, and `mmap_size` is pinned by SIGBUS semantics against truncation; one field for all three would hide three arguments behind one name.

## Consequences

A deployment can size the page cache per connection from `cordis.yml`, and unsetting the field leaves the connection on SQLite's default suggestion — nothing changes until it is set. A value SQLite accepts but the schema does not (negative, fractional, past the ceiling) fails at mount, and a value the connection does not retain fails the open instead of silently running a different cache. `0` is accepted and is almost never what a tuning pass wants, since it yields the 10-page floor.

## Testing

`tests/page-cache.spec.ts` records every connection the provider opens and pins that a mount with `1_048_576` receives `-1_048_576`, an omitted field or an explicit null keeps `-2000` with no `cache_size` statement executed, `0`, `64`, and `MAX_CACHE_SIZE_KIB` each land as their own negation, and `-1`, `1.5`, and `2_147_483_648` reject at mount. `tests/sql-resource-boundary.spec.ts` pins the substitution cage across the package's TypeScript sources. `tests/page-cache-async-composition.spec.ts` mounts this field beside `asyncCodec` and pins that the composed store keeps the configured cache on its connection.

## Related

- The package README owns the operator-facing field table and startup behavior: [session-persistence-sqlite](../../../../packages/session/session-persistence-sqlite/README.md)
- The fork inventory row this provider lives under: [FORK_SURFACE.md](../../../../FORK_SURFACE.md)
- The pooled decoder this field composes with: [async codec note](2026-09-20-async-session-codec.md)
