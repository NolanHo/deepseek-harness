# Agent Note: Wire chunk packing and HTTP response compression for history pages

Status: implemented

English | [中文](2026-08-26-wire-chunk-packing-and-compression.zh.md)

> Scope: why `session.history` pages now ship packed chunk rows and why the fetch carrier compresses JSON responses — the wire-level fix for cold-open latency that the paged persistence read alone could not reach.

## Problem

After the paged cold read landed, measuring the real RPC on the migrated store showed the host read at ~40ms but the end-to-end history call still at 3.5–4.7s: a 25-turn page from the 812k-event session serialized to **35MB** — 159,976 `assistant/chunk` events whose JSON envelopes dwarf their payloads (the storage layer's own packing measured ~56× envelope waste on the same shape). JSON.stringify, the HTTP transfer, and the browser-side parse all paid that envelope cost; the server sent no compressed responses at all.

## Decision

**History wire entries reuse the storage chunk codec.** `pageEntries` runs `packChunkRuns` over the page: consecutive whitelisted delta-chunk runs (3+ members) fold into one `ChunkRow` (`text-chunks` / `reasoning-chunks` / `tool-call-chunks`), shipped as a new `HistoryEntry` union arm `{ packed }`. The codec is lossless, whitelist-shaped, and validated — the client expands packed rows with `decodeStorageRecord` back to the exact original events before the conversation fold, so nothing downstream sees a packed row. Page cuts, `baseSeq`, view alignment, and projection baselines all stay computed over expanded events (chunk entries never carry views).

**Browser packages import the codec through the wire surface.** `@deepseek-ai/dsh-host-apiproxy/api` re-exports `decodeStorageRecord`/`ChunkRow` (new `api/chunk-rows.ts`); client packages already value-import that entry (`transportError`), and it carries no cordis augmentation. Client packages must NOT import `@deepseek-ai/dsh-session`'s main entry: it declares the host-only `sessions: SessionStore` augmentation, and the two-face typecheck split ("one program cannot see both") turns any client-side load of it into `TS2717` conflicts and `ctx.get('sessions')` resolving to the host store (the client apply specs pin this). The pure `chunk-rows` subpath has a `tsconfig.base.json` paths entry for both faces.

**The fetch carrier compresses JSON responses.** `toFetchHandler` wraps the POST envelope path with `maybeCompress`: strongest advertised coding (zstd, then gzip), only for `application/json` bodies ≥ 1KiB, never for SSE streams or downloads. Every return past the `arrayBuffer()` read re-bodies the bytes into a new `Response` — returning the original Response after consuming its stream writes nothing, which surfaced as `net::ERR_EMPTY_RESPONSE` on every small `describe` call (the lane reproduced this as an endless connection-retry loop before the fix).

Measured effect on the 812k-event session: the 25-turn page's 160k chunk events collapse to a few hundred packed rows (~35MB → ~2–3MB before compression; zstd then takes the transfer below ~1MB).

## Consequences

- The wire page format gained the `{ packed }` arm; both ends of this fork move together (pre-release, no protocol versioning).
- Cold-open latency is now bounded by payload + render instead of the full-log rebuild; the client still expands every packed row at install time (decode is linear in the page).
- `agentPreset.list`, `credentials.describe`, `host.describe`, and other small JSON RPCs now also round-trip through the re-body gate (uncompressed, byte-identical).
- Tests that read `entry.event` on wire pages expand packed rows first (`wireEvents`-style helpers); client specs build packed fixtures with `packChunkRuns` and assert the exact expanded event stream.

## Alternatives considered

- **Compression alone, no packing**: rejected — it shrinks the transfer but not the JSON.stringify/parse cost, and the 56× envelope waste is the root.
- **Packing without the wire-surface import discipline**: rejected — importing the codec from `dsh-session` main into client packages breaks the two-face typecheck split (TS2717 on the `sessions` augmentation).
- **Compress streaming SSE**: rejected — SSE streams must stay flushable per frame; the history-page payload is the actual cost center.

## Verification

- `pnpm exec vitest run packages/host/apiproxy` 21 files / 391 tests green: packed-row round-trip (decode equals the exact events, 2-chunk runs stay scalar), gzip/zstd decompress-equality, tiny/incompressible/non-JSON paths, re-body completeness.
- Client runtime suite green (open + loadOlder expansion tests assert the exact event stream across a packed tail).
- `pnpm run typecheck` (0 errors) and the full browser lane: 269 passed; remaining failures are the pre-existing host sandbox set (no sandbox backend on this container).
