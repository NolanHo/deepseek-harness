---
description: "SQLite session persistence for deployments and maintainers choosing, configuring, or debugging the opt-in packed-row backend."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-sqlite

English | [中文](README.zh.md)

## Summary

`dsh-session-persistence-sqlite` stores every session's durable history in one queryable SQLite database instead of one file per session, so you can back up and query the whole deployment history as one file. Choosing it changes nothing for the agent loop, the model, or replay: it serves the same logical `SessionEvent` stream as the JSONL backend, and packing, compression, and recovery stay storage-internal. It is pre-release: it upgrades the schema-19 predecessor in place and rejects any other file it does not own. Its synchronous SQLite driver blocks the JavaScript thread. No shipped composition enables it by default.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this provider when a composition needs durable sessions backed by SQLite and accepts a process-local, synchronous database driver. The common path is explicit: load the session service, mount the provider, and give it a database path.

### When to choose it

Choose this backend when a local deployment benefits from one queryable database instead of many per-session files. Choose the JSONL backend when consumers need a per-session artifact: this provider returns `undefined` from `locate(meta)`, supports no raw artifacts, and exposes no per-session file. Account for synchronous SQLite and compression work before adopting it for a high-concurrency service.

### Disk footprint and performance

The packed layout exchanges some SQLite-local latency for a smaller queryable database. On the 501-session comparison corpus, the schema-19 layout used 233.18 MB against the SQLite comparison baseline's 438.31 MB and compressed JSONL's 148.15 MB. Full writes were about 2.3× faster than JSONL and suffix reads remained much faster; complete reads and forks were slightly slower than JSONL. The [persistence latency and page-size decision](../../../.agents/notes/archived/architecture/2026-08-25-persistence-latency-and-page-size.md) owns the method, complete metrics, and accepted trade-offs.

The disk cost buys a structured, queryable view of session history: external tooling can analyze `sessions` and `events` with SQL, decoding physical rows the way this provider does — the groundwork for features such as built-in full-text search.

A full read restores every stored row, and resuming a session — or any other consumer that opens one and reads it — repeats that work on data that has not changed. `decodedLogCacheBytes` keeps the logs a connection has already decoded and answers a repeat read of a session whose stored revision has not changed with the objects the first read produced. The default `0` keeps the uncached behavior exactly: nothing is retained and every read builds a fresh object graph.

<a id="minimal-configuration"></a>
### Minimal configuration

Load the session service first, then mount the provider with a database path. Use an absolute path when the location must not depend on the process working directory; relative paths resolve from that directory. `:memory:` is valid for an in-process database whose contents disappear with the process.

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-persistence-sqlite'
  config:
    path: /absolute/path/to/sessions.db
```

| Field | Default | Meaning |
|---|---|---|
| `path` | required | SQLite database path, or `:memory:` |
| `journalMode` | `wal` | Durable journal mode: `wal`, `delete`, `truncate`, or `persist` |
| `busyTimeoutMs` | `5,000` | Maximum synchronous wait for another connection's lock |
| `cacheSizeKib` | SQLite's `-2000` (about 1.95 MiB) | SQLite page cache per connection, in KiB; an omitted or empty field executes no pragma |
| `writeBatchMaxDelayMs` | `200` | Fixed live-event coalescing window, in milliseconds |
| `asyncCodec` | `false` | Decompress stored logs on the libuv thread pool instead of the reading thread |
| `decodedLogCacheBytes` | `0` (disabled) | Whole decoded logs one connection may retain, in decoded JSON text bytes |

The [minimal configuration](#minimal-configuration) table lists the fields this package accepts, and the generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-persistence-sqlite) is the exhaustive source for each field and its JSDoc.

### Migrating existing JSONL sessions

There is no built-in migration tool: the JSONL and SQLite stores are separate, and nothing copies sessions between them. Because both backends implement the same logical contract, you can carry a session over with the persistence API — read on the JSONL side, write on the SQLite side. One backend serves `ctx.sessionPersistence` per composition, so run the two halves as separate runs or processes:

```text
// Export — run against the JSONL composition, per session id:
const { meta, events } = await ctx.sessionPersistence.load(id)

// Import — run against the SQLite composition, per exported session:
await ctx.sessionPersistence.create(meta)
await ctx.sessionPersistence.append(id, events)
```

`list()` enumerates the materialized sessions to export. The exported events keep contiguous `seq` values starting at 0, so `append` accepts them as one ordered batch into a fresh session; `load` also commits any needed cold repair on the source first, so the exported log is balanced. Treat the migration as a one-time cutover: verify that the imported sessions load, then switch the composition to the SQLite provider. Continuing to write through the old JSONL root afterwards would let the two stores diverge.

### Startup and safe operation

A fresh database initializes directly at schema version 20 with 64 KiB pages. An existing schema-19 database is upgraded once, in place, inside the open transaction: the events table gains the `ignorable` envelope column, packed rows carry the schema-20 packed-row sentinel, and the old `is_packed` column is dropped. Databases with any other version, a foreign application identity, an unversioned non-pristine schema, or unexpected schema objects are rejected before any data is exposed or changed. Every statement and pragma comes from packaged `.sql` resources in `resources/sql/`, and runtime values are bound as SQLite parameters, so package code never assembles query text. The one exception is the optional `cache_size` value, which SQLite refuses to bind and which the validated `cacheSizeKib` substitutes into its packaged statement.

Each connection disables SQLite trusted schemas and memory-mapped I/O, verifies the requested journal mode, and pins `synchronous=FULL` so a resolved append remains durable across an OS crash or power loss. A configured `cacheSizeKib` gives that connection the requested page cache instead of SQLite's default suggestion of 2,000 KiB (`-2000`, about 1.95 MiB); omitting the field — or leaving the `cordis.yml` value empty, which arrives as null — executes no pragma and leaves that default alone, while `0` applies `-0`, a zero-page suggestion SQLite floors to its 10-page minimum. On POSIX, the database parent directory and file must belong to the current user, the parent must not be group/world-writable, and the file must grant no group or world permissions; Windows additionally rejects symbolic links and non-regular files, while ACL restriction stays the deployment's job. Path and ownership failures reject plugin initialization; Node's SQLite driver loads lazily on the first persistence operation. Ordinary `create` stays lazy until the first append, while `ensureMaterialized` writes a session metadata row with no event rows.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is built on one separation and three commitments:

- **Logical contract, physical format.** Callers always read and write ordinary `SessionEvent[]`; how rows are packed, stored, and compressed is private to this package.
- **The schema owns the format.** Schema 20 is a frozen physical contract: a database at another version, with a foreign identity, or with unexpected schema objects is rejected, never migrated. Schema-19 databases are the one accepted predecessor and are upgraded in place once at open. Changing the schema, row codec, page size, or dictionary bytes requires a new schema version.
- **Durability is the default.** Appends run in immediate transactions with `synchronous=FULL`, and a resolved `append()` means the batch is durable. Normal appends are insert-only: earlier event rows are never rewritten.
- **Efficiency within strict bounds.** Packing and compression keep the database small, but every limit is a hard format bound — at most 1,024 events and 1 MiB of payload per packed row.

The packed-row foundation lives in the archived "SQLite physical chunk-row decision" note (frozen record); the current compression, key, and page-size choices live in the [persistence latency and page-size decision](../../../.agents/notes/archived/architecture/2026-08-25-persistence-latency-and-page-size.md).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, service registration, coordinator wiring |
| [`src/store.ts`](src/store.ts) | Storage primitives: transactional append, reads, repair, truncate, path and ownership validation |
| [`src/schema.ts`](src/schema.ts) | Schema ownership: version gate, connection hardening, row decoding |
| [`src/codec.ts`](src/codec.ts) | Packing: which `assistant/chunk` runs become packed rows, size bounds |
| [`src/compression.ts`](src/compression.ts) | Physical encoding: dictionary compression, sequence lists, row scan and decode |
| [`src/sql.ts`](src/sql.ts) + [`resources/sql/`](resources/sql/) | Every SQL statement as a packaged, closed-name resource |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; packing is observable only by database round-trip) |

### Database schema

A fresh database contains three strict tables, defined in [`resources/sql/schema.sql`](resources/sql/schema.sql):

| Table | Purpose |
|---|---|
| `persistence_state` | One-row store identity |
| `sessions` | One row per session: header fields plus a monotonic revision |
| `events` | Physical event rows: one logical event, or one packed run |

The exact columns live in [`resources/sql/schema.sql`](resources/sql/schema.sql). `sessions.id` is an internal integer key while `sessions.session_key` retains the public session id. `events.data` holds text or an independently decodable Zstandard blob; compression uses the schema-owned shared dictionary only when the result is smaller. `events.source_event_seqs` uses tagged delta or run encoding. `events.ignorable` is `NULL` for an ordinary scalar event, `1` when the scalar event's envelope carries the ignorable marker, and `0` (the packed-row sentinel) for a packed chunk run, so a scalar event whose type matches a physical chunk tag remains unambiguous. Packed rows reuse the `seq` of their first logical event, so under the composite `(session_id, seq)` primary key physical order is logical order.

### Write path

Each append takes an immediate transaction, re-validates schema ownership, checks the stored tail so a stale writer cannot extend the log, packs only the new batch, inserts its rows, bumps the session revision once, and commits. The coordinator coalesces live events for the configured window, so high-frequency streams produce larger packed runs while physical writes stay proportional to newly durable batches.

`truncate` runs the same immediate transaction: it deletes every row at or past the cut, rewrites the one packed row whose run spans the cut so only its members below it survive, bumps the session revision once, and commits.

### Read and recovery

A full read locates the last valid `turn/end` in a reverse pass, then decodes each physical row into its logical events in forward order, rejecting gaps or malformed rows in the committed prefix. A malformed final row is treated as a torn tail: a mutating load may delete it under the write lock and close the log with synthetic closers. Suffix reads (`readFrom`) examine only the physical span that may contain the requested sequence, so they never parse unrelated earlier rows.

`asyncCodec` selects the thread that decompresses those rows. With it on, `zlib.zstdDecompress` decodes every compressed data column on the libuv thread pool before the same scan flattens the rows, so a cold read yields between rows and concurrent cold reads decompress in parallel up to the pool size. Compression, and any decode that runs while a write transaction is open (the append tail window, repair, truncate), stays on the calling thread: an await inside an open transaction would let another operation start a nested one on the same connection. Both settings write identical rows and read identical events; `tests/compression-async.spec.ts` and `tests/async-codec.spec.ts` pin that.

`decodedLogCacheBytes` retains whole decoded logs for one connection. A read reuses a retained log only when the session row it reads in that same call carries the revision the entry was read at, so a write from any connection or process misses instead of returning events the database no longer holds. Append, publish, repair, truncate, and header materialization additionally drop the session's entry, and `close()` drops every entry. The ceiling charges each log the decoded JSON text of its data columns — a compressed column's decompressed text — and evicts least-recently-used entries until the retained total fits; a log larger than the whole ceiling is never retained.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared persistence model to exhaustive configuration and the decision evidence behind the physical layout.

- [Session persistence subsystem](../../../docs/subsystems/persistence.md) — backend-neutral service semantics and provider relationships.
- [Session package map](../README.md) — adjacent persistence, projection, title, and telemetry packages.
- [Minimal configuration](#minimal-configuration) — the mount snippet and the fields it accepts.
- Archived "SQLite physical chunk-row decision" note (frozen record) — rationale, alternatives, and measurements behind the packed layout.
- [Persistence latency and page-size decision](../../../.agents/notes/archived/architecture/2026-08-25-persistence-latency-and-page-size.md) — the 501-session benchmark and schema-19 storage trade-offs.

-----

<a id="model-experience"></a>
## Model Experience

### Resumed conversation history

#### What the model sees

Nothing specific to SQLite. Resume restores the same logical events and derived messages as the JSONL backend; physical packed tags never reach prompts, tools, replay, or live `session/event` delivery.

#### Token effect

Zero live-request tokens. Resume pays only for the retained logical history and the current request envelope.

#### KV Cache effect

Physical packing does not mutate request prefixes. Provider cache reuse depends on the reconstructed history, current envelope, and model route exactly as with other persistence backends.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit or needs special operational care. They are current package constraints, not a general SQLite comparison or a task backlog.

- **Pre-release schema policy** — only the current schema 20 and its schema-19 predecessor open; any other on-disk version is rejected without conversion.
- **Packing depends on batch boundaries** — a compatible run split by the write-behind window or an explicit flush stays split across physical rows; this avoids rewriting prior rows at the cost of a timing-dependent packing ratio.
- **Synchronous SQLite and compression** — Node's SQLite driver blocks the JavaScript thread, and so does Zstandard compression. `asyncCodec` moves only the decompression of the two stored-log scans that read outside a transaction to the libuv thread pool; compression never uses the pool, and the decodes a write transaction holds stay synchronous.
- **Busy waits block the event loop** — SQLite waits inside synchronous calls; a competing writer can stall the thread for up to the configured `busyTimeoutMs`.
- **External SQL readers must decode physical rows** — a packed `events.type` (`text-chunks`, `reasoning-chunks`, `tool-call-chunks`) is not a logical event type; supported consumers read through this provider.
- **No deletion or historical compaction** — normal appends are insert-only and nothing removes old rows.
- **Decoded-log retention is charged by decoded text** — `decodedLogCacheBytes` charges each retained log the UTF-8 byte length of the JSON text its rows decoded to, while the retained value is the parsed, frozen event graph built from that text; sessions whose rows carry no text are retained for free (a byte ceiling does not bound the entry count). Read the ceiling as a cache size with headroom, not as a memory budget.
- **Out-of-band physical damage is masked while an entry lives** — the revision check catches every write this provider makes, but raw SQL outside it (an external tool or a second instance sharing the file) can change rows without moving the revision, and the retained log then keeps answering for that session until its entry is evicted, including the shrink guard's damage verdict. Restoring a backup over a running store is in-place damage of the same kind: stop the instance first, so the process opens the restored file instead of holding the replaced one.
- **A retained hit still reads the event rows** — a hit is validated against the revision the session row carries in the same transaction as the events, so it skips decompression, parsing, validation, and freezing but still pays the row scan; on this deployment's 66,736-row Session that measured ~0.3s against ~3.5s for a cold read.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The 501-session corpus contains private session data and is not committed. Its aggregate method, complete results, and rejected candidates are recorded in the [persistence latency and page-size decision](../../../.agents/notes/archived/architecture/2026-08-25-persistence-latency-and-page-size.md); the packaged dictionary's hash-pinned resource is the schema-20 source of truth.

</details>
