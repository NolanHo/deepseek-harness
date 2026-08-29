# Agent Note: Remote stream mux negotiates permessage-deflate

Status: implemented

English | [中文](2026-08-29-remote-mux-permessage-deflate.zh.md)

> Scope: the Gateway's Remote stream WebSocket (`/api/remote.mux`). One server option, config-gated.

## Problem

Cold-opening an event-dense session ships its whole first history window as one `opened` journal frame over the WebSocket (measured 1.2-1.4 MB for the largest sessions — ~70% of it streaming chunk events). The transport cannot compress it: permessage-deflate (RFC 7692) was not enabled, so the frame bytes cross the wire raw. On a loopback deployment this is invisible; behind a slow reverse-proxy path the same megabytes dominate the open latency, and HTTP gzip on the proxied responses does not reach WebSocket payloads.

## Decision

`RemoteStreamMuxServer` accepts a `perMessageDeflate` constructor flag wired to a new `Config.websocketPerMessageDeflate` (default false, enabled by this deployment's profile patch). The option is `perMessageDeflate: { threshold: 1024 }`: journal `opened` frames (whole history windows, always above the threshold) compress several-fold; live per-event frames stay raw — no deflate latency on the streaming path. Browsers negotiate the extension automatically in the WebSocket handshake; clients that do not offer it (or a ws client with `perMessageDeflate: false`) fall back to plain frames with no change on their side. The compression is transparent to the protocol: the mux's frame handling is untouched, only the transport encodes.

What this deliberately does not fix: the client-side cost of decoding and folding the window (8.5k events) — the render segment of a cold open is unchanged. If the open stays slow on fast links after this, the remaining lever is window content reduction, not transport.

## Alternatives considered

- **Compress the frame payloads in the mux protocol** (JSON-level gzip per item): duplicates what RFC 7692 standardizes for both peers, and every client would need a decoder.
- **Enable permessage-deflate unconditionally**: the flag stays config-gated like the webserver's gzip — deployments behind fast loopback links gain nothing and keep the zlib windows to themselves.
- **Shrink the window content instead** (skip chunk events on page reads): bigger lever for the render segment too, but it touches the page read and the fold's replay contract; kept as the follow-up if transport compression is not enough.
## Verification

`stream-server.host.spec.ts`: a negotiating client sees `permessage-deflate` in `socket.extensions` on both ends and a page-sized item round-trips; an opted-out client falls back to raw frames with the same round trip. The config schema test pins the default-off and the opt-in.

## Consequences

- Wire volume for cold-open windows drops several-fold behind slow paths; live-frame latency is unchanged (sub-threshold frames skip deflate).
- The extension costs a zlib window per connection (~300 KB both directions) — bounded by the few browser connections.
