# Agent Note: Web client serving-authority trust

Status: implemented

English | [中文](2026-08-23-web-client-serving-authorities.zh.md)

## Problem

The web client decided settings-plane trust from the browser address bar alone: `connection.isLoopback = isLoopbackHostname(pageLocation.hostname)` fed every settings consumer's `'host'`/`'memory'` persistence choice. Deployments that serve pages through a loopback-rewrite proxy (the documented Caddy pattern: the frontend rewrites Host/Origin to 127.0.0.1 before the backend) present a non-loopback page authority, so the client switched the settings mirror to `'memory'` and the models-settings page failed with "settings are unavailable in this browser", even though the server-side fence accepts the rewritten request.

## Decision

This note extends the [api browser-trust boundary note](2026-07-28-api-browser-trust-boundary.md); the fence itself is unchanged (`trustedHosts` stays a rebinding fence, not authentication, and the privileged method set stays loopback-gated).

- The host publishes the deployment's non-loopback serving authorities — client-connection's validated `trustedHosts` minus loopback entries (loopback is first-party on the client without a wire entry) — into the boot wire as `window.__DSH_BOOT__.trustedAuthorities` (client-modules' `publishTrustedAuthorities`; the graph `rev` covers `[entries, trustedAuthorities]`, so a changed publication recomposes the wire and notifies graph listeners once).
- The client renames `connection.isLoopback` to `connection.isServingAuthority`: true when the page is absent (non-browser), its hostname is loopback, or its authority matches a wire entry under the host fence's comparison semantics (a port-less entry matches the hostname on any port; `host:port` matches that exact authority, both sides through WHATWG normalization).
- The settings plane (`'host'`/`'memory'` persistence, the local-document action, the produced-files folder opener) keys on the new field. Old HTML without the field parses as an empty list; old clients ignore the extra wire field.

## Alternatives considered

- **Keep `isLoopback` and add a second boolean for the wire list** — rejected: every consumer would have to combine two booleans into the same decision; one field names the settled answer, and the rename is exhaustive so no source keeps both.
- **Have the browser probe the server for its own authority** — rejected: the trust decision is consumed at plugin apply, before any transport round-trip, and a probe would re-derive the fence list from a live server instead of the settled config the fence actually gates on.
- **Carry the list in a client-side configuration instead of the host wire** — rejected: the host's `trustedHosts` is already the authoritative list; a second client-side declaration would drift from the fence that actually gates requests.

## Consequences

- A deployment behind a loopback-rewrite proxy serves the settings plane to its browser when its page authority is declared in `trustedHosts`; direct remote browsers (authority not listed) keep the `'memory'` mirror, unchanged.
- The wire gains a field that both directions tolerate: old HTML yields `[]`, old clients ignore it, and a malformed field fails the boot loudly.
- Server-side semantics do not move: `trustedHosts` is still reachability policy, not authentication, and the privileged method set is still loopback-only.
