# Agent Note: Memoize live-session observations for search

Status: implemented

English | [中文](2026-08-28-live-session-search-observation-memo.zh.md)

## Problem

Session search recomputed a full observation — `structuredClone` of every event, shared-document extraction, `JSON.stringify`, and SHA-256 of the whole log — for **every attached session on every search**, before comparing fingerprints. Large attached logs (a 553k-event conversation, a 692k-event session) made each search burn ~12-13 core-seconds of pure JS on unchanged data; the SQLite index reconciliation itself was already incremental.

## Decision

Memoize the live observation per session keyed by event count plus tail seq/time. Attached logs mutate by append only (surface replacements, steering, and edits append too), so that key identifies the observation content; an unchanged session reuses the previous clone, documents, and fingerprint. Entries for detached sessions are evicted at the end of each stable observation, bounding the memo to the attached set. A changed session still pays one full recompute (the floor of the whole-log fingerprint design).

## Consequences

- Repeated searches over unchanged attached sessions cost their index lookups only (the 47 ms path); one full recompute remains the floor for any session that appended events.
- The memo lives in the observation layer, so the store, the index, and the wire are untouched.

## Alternatives considered

- **Reconcile the fingerprint incrementally**: the whole-log SHA is the design's integrity anchor; an incremental digest would change what "unchanged" means and belongs to a wire-format decision, not this bug fix.
- **Cache by mtime instead of a content key**: append-only mutation does not guarantee mtime granularity, and surface replacements can rewrite in place behind the same mtime on some filesystems.

## Verification

- A keyless unit test asserts a repeated search over an unchanged live session performs zero `structuredClone` calls, and that an append invalidates the memo (the fresh content is found).
- A standalone reproduction against the production stores: a 553k-event attached session costs 2420ms on the first search (one-time index), then **47ms** per repeated search; without the memo every search re-pays the full cost.
