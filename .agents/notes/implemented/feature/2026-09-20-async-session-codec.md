# Agent Note: The session-log codec decompresses on the libuv thread pool

Status: implemented

English | [中文](2026-09-20-async-session-codec.zh.md)

> Scope: why `@deepseek-ai/dsh-session-persistence-sqlite` gained an `asyncCodec` switch, why only decompression moved off the reading thread, and what the switch costs in memory.

## Problem

The paged cold read ([paged cold history reads](../architecture/2026-08-26-paged-cold-history-reads.md)) bounds how many physical rows a history page loads, but not what loading them costs: every compressed data column in that window is inflated by `zstdDecompressSync` on the thread serving the RPC. Decoding is the linear part of that read, so a large page — or two concurrent cold reads — holds the event loop for the whole scan, and every stream waits behind work that needs no JavaScript.

## Decision

`asyncCodec?: boolean` is a `Config` field on `SqliteSessionPersistence`, validated as `z.boolean().default(false)`. `false` is the existing synchronous path exactly; `true` builds the store with `scanRowsOnThreadPool`, which decodes the compressed data columns through `promisify(zstdDecompress)` and then runs the same `scanRows` classification over the hydrated rows, so both settings turn a stored log into the same events.

**Only decompression moves off the thread.** Compression stays `zstdCompressSync` on the caller's thread, and so does every decode a transaction holds.

**The pool is awaited only after the read transaction returns.** `loadStoredLog` and `loadStoredFrom` select their rows inside a synchronous `readTransaction` and hydrate afterwards. One `DatabaseSync` connection cannot carry two open transactions: an await inside one lets another operation reach the connection while it is open, and that operation's `BEGIN` fails with `cannot start a transaction within a transaction` — the operation fails where it meant to be atomic, while the open transaction's own rows and commit are unaffected. Every write path therefore keeps the synchronous decoder even with the switch on.

**Compression is not async because the two frames differ.** Node's asynchronous zstd entry point is the streaming one (`ZSTD_compressStream2`, which writes a window descriptor), while `zstdCompressSync` is the one-shot `ZSTD_compress2` whose single-segment frame carries `Frame_Content_Size`. With the storage codec's own options — its dictionary, level 3 — every one of five probe inputs differed on Node 25.9.0: synchronous frames open `28 b5 2f fd 60`, asynchronous ones `28 b5 2f fd 00`. Async compression would change what every stored row contains, and a `worker_thread` would restore byte equality only by adding a second isolate and heap to a switch whose premise is that it adds neither. Keeping compression synchronous is what makes both settings write byte-identical physical rows, which `tests/async-codec.spec.ts` compares column by column.

**The window bounds decodes in flight, not memory.** `HYDRATION_WINDOW = 8` submits at most eight columns at a time, but `hydrateDataColumns` accumulates every decoded column in one array while the caller still holds the compressed rows, so this path peaks above the synchronous scan, which decodes one row, uses it, and drops it.

**Eight is twice the pool this deployment actually has.** libuv's default thread pool is 4, and no `UV_THREADPOOL_SIZE` is set — not in the process environment, the supervisor program, or the launch scripts — so decodes past the fourth wait in the pool's queue instead of running.

**Coverage is the two cold-read paths.** Compression on append, publish, repair, and truncate, and every decode a write transaction holds, stay synchronous.

## Alternatives considered

**Compress on the thread pool too.** Rejected for the frame mismatch above: either the settings stop writing the same bytes and one of them has to be declared the stored format, or zstd moves into a `worker_thread`, buying byte equality with an extra isolate, heap, and a second copy of the codec to keep in step.

**Await the pool inside the read transaction.** Rejected: `readTransaction(async () => …)` is the natural shape, and what it produces is the transaction hazard above rather than a slowdown — the open transaction blocks every other operation's `BEGIN` for the length of the decode, so each of them fails with the nested-transaction error instead of running.

**Default the switch to `true`.** Rejected: `false` keeps the released path byte- and behavior-identical, which is what lets this change be bisected and rolled back by configuration alone; the deployment that wants pooled decode sets the field.

## Consequences

Off is the released behavior. On, a cold read yields between rows and concurrent cold reads share the pool; the decompression itself costs the same CPU, but off the reading thread, and concurrent reads overlap instead of queuing behind each other. On this deployment's 63,762-event Session, a GUI cold open with the pooled decoder measured 88–109 CPU·s against 26–29 CPU·s with the synchronous one (two runs per state, interleaved, one snapshot; both opened the Session, and only the pooled runs kept the event loop ticking), which a one-off scan comparison of the same rows (synchronous 490–526 ms against pooled 966–1072 ms, not a committed benchmark) does not predict — so this deployment keeps the switch off, and the amplification is not yet attributed. There is no format fork to migrate: both settings write identical rows and each reads logs the other wrote, so the field is the entire rollback. A thread-pool scan holds more memory than a synchronous scan of the same rows, and a write path's stall is unchanged, because compression and in-transaction decodes still run on the calling thread.

## Testing

`tests/compression-async.spec.ts` pins the pooled scan against the synchronous one: mixed physical logs decode to the same events, torn tails, committed corruption, and malformed rows classify identically, the packed `maxOutputLength` bound and the scan base behave the same, `zstdDecompress` is the entry point used when configured, and a column the pool cannot decode is left to the scan's own classification. `tests/async-codec.spec.ts` mounts the provider and pins that the field defaults to `false` and rejects a non-boolean, that both settings write byte-identical physical columns, that each reads logs the other wrote, and that only a configured store calls the pool decoder. `tests/page-cache-async-composition.spec.ts` mounts both `Config` fields together and pins that the composed store keeps the page cache on its connection, selects the pool decoder for a stored log, and rejects the first use when the connection did not retain the pragma.

## Related

- The paged read whose window this cost shaped: [paged cold history reads](../architecture/2026-08-26-paged-cold-history-reads.md)
- The package README owns the operator-facing field table and cold-read behavior: [session-persistence-sqlite](../../../../packages/session/session-persistence-sqlite/README.md)
- The page-cache `Config` field this switch composes with: [SQLite page-cache Config field note](2026-09-20-sqlite-page-cache-config.md)
