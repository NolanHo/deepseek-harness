# Agent Note: The Remote stream mux reports its carrier lifecycle

Status: implemented

English | [中文](2026-09-21-remote-stream-carrier-diagnostics.zh.md)

> Scope: why `RemoteStreamMuxServer` reports slow carriers and closes, why those lines go to `process.stderr` instead of `ctx.logger`, and what each diagnostic means.

## Problem

In production the browser side's mux WebSocket was rebuilt roughly every 15 seconds for hours, and this path produced no log line at all. Traefik recorded 468 connections on that single route within 24 hours, a median connection lifetime of 14.5 s, and peaks of 90–135 connections per hour — while the mux could not say whether a connection ended because the heartbeat terminated a silent socket, because the ready or first frame arrived too late while the event loop was occupied elsewhere, or because the peer or an intermediary closed it. All three end in the same observable state, a closed socket, and nothing distinguished them after the fact.

## Decision

**An optional diagnostics argument, not a behavior switch.** `RemoteStreamMuxServer` takes a fifth constructor parameter, `RemoteStreamDiagnostics { sink, slowMs }`. Absent, the mux emits nothing and behaves exactly as before; present, the mux owns each message and the caller owns the destination. `TypertGatewayService` passes the deployment's sink and the resolved `diagnosticsSlowMs`.

**Four single-line diagnostics cover the whole carrier lifecycle.**

```text
api gateway: remote stream first item slow endpoint="session/events" elapsedMs=50
api gateway: remote stream heartbeat tick late driftMs=101
api gateway: remote stream heartbeat terminate missed=2 lifetimeMs=60
api gateway: remote stream socket closed code=1000 reason="peer done" lifetimeMs=1 streams=1 heartbeat=false
api gateway: remote stream socket closed code=1006 reason="" lifetimeMs=61 streams=0 heartbeat=true
```

The first line names the logical stream whose first item took at least the threshold to produce (`endpoint`, `elapsedMs`). The second reports a heartbeat tick the event loop delayed past its interval (`driftMs`), at most once per five seconds so one stall cannot repeat per tick. The third reports a heartbeat terminate with the pongs the socket missed. The fourth reports every socket close with the peer or local close code, the reason clipped to 120 characters, the socket's lifetime, the logical streams it opened, and whether the heartbeat caused the close — which is what separates "the mux killed a dead carrier" from "the carrier went away".

**The threshold is a validated `Config` field.** `diagnosticsSlowMs` (`z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(3_000)`) decides when a first item or a late tick is worth a line. Healthy traffic emits only the per-close line, so the field's value trades reporting sensitivity against log volume on a busy host; the deployment's scheduler, garbage collection, and network path set what "slow" means there.

**The lines go to the process's stderr, and the sink stays injectable.** This tree registers no console exporter — cordis's built-in exporter only appends to a memory ring buffer — so a `ctx.logger` line never reaches an operator log, while the deployment runs the process under a supervisor that folds stderr into the service log. A composition that does serve an exporter passes its own sink instead of the constant, and a test injects a recorder.

**Diagnostics carry attribution, never content.** No line carries stream payloads, Session ids, or Session values; a close reason is truncated at a character boundary before it is quoted, and the heartbeat-terminate line is emitted once, after the `setImmediate` re-check that confirmed the socket still owed pongs — a pong that arrived in between leaves only the close line, with `heartbeat=false`. Reporting never awaits, writes to, or closes the socket.

## Alternatives considered

**Log through `ctx.logger`.** The line would be written into cordis's in-memory ring buffer and never surface in an operator log, because no console exporter is registered in this tree. stderr is the stream the deployment already captures.

**Emit a Session event or a metric.** Neither has a consumer: this deployment reads text logs, and a Session event would add durable, wire, and model-visibility surface for data no code queries. The diagnostics are operational side output, not session state.

**Log only the close inside the connection's own run loop.** A close line alone cannot attribute the close: without the acceptance time, the missed-Pong count, and the heartbeat-caused flag, the three candidate causes stay indistinguishable — the exact gap this change closes.

**Log every heartbeat tick and every frame.** Volume on a busy host, and healthy traffic drowns the event worth seeing. The threshold plus the five-second throttle keep a quiet host silent and a stalling host self-reporting.

**Put the diagnostics behind a debug flag the deployment sets.** The incident was invisible precisely because nothing was enabled; a threshold makes a host report its own slowness with no flag, and `diagnosticsSlowMs` still lets a busy deployment raise the bar.

**Report one line per logical stream instead of per carrier.** The unit that churns is the carrier — traefik saw 468 connections, not the streams inside them — so the close line belongs on the carrier, while the per-stream delay is covered by the first-item line.

## Consequences

An operator can grep `api gateway: remote stream` and attribute a carrier's death from one line. The volume follows carrier churn: one line per close, plus one first-item line per slow stream and at most one late-tick line per five seconds, which on the recorded incident's 90–135 connections per hour is negligible. Because the evidence lives in the service log rather than in a metrics pipeline, nothing new has to be scraped, and the threshold is a deployment tunable rather than a protocol constant.

Cost: `stream-server.ts` now carries fork-owned instrumentation — the sink and diagnostics interfaces, the diagnostic constants, the acceptance/heartbeat-causation/opened-stream tracking, and the four report sites — that an upstream sync must re-apply; `index.ts` carries the field, the sink constant, and the construction argument. The mux's stream path itself is untouched. The row in [FORK_SURFACE.md](../../../../FORK_SURFACE.md) records those sites.

## Testing

`packages/api/gateway/tests/stream-server.host.spec.ts` gains the `Remote stream mux diagnostics` block, which drives a real mux over a real WebSocket with a recording sink: the heartbeat-terminate line plus the `heartbeat=true` close line; the close code, reason, lifetime, and opened-stream count of a peer close; a maximum-length reason clipped to one bounded line; a first item past the threshold with its endpoint; silence for a first item under a raised threshold; silence for a healthy carrier apart from its close line; and one late-tick line per throttling window. `packages/api/gateway/tests/gateway-stream.host.spec.ts` pins the field's default and its `[1, MAX_TIMER_DELAY_MS]` bounds, and captures the process's stderr through the composed Host to prove the routing and the line format end to end.

`npx vitest run packages/api/gateway/tests/stream-server.host.spec.ts packages/api/gateway/tests/gateway-stream.host.spec.ts` passes 43 cases across the two files (18 and 25), the new ones among them. The incident's numbers (a rebuild every ~15 seconds, 468 connections in 24 hours, a 14.5 s median lifetime, 90–135 connections per hour at peak) come from the production route's own records, and no test replays the production reconnect loop: the mux was not re-observed live from here, and operator-side readability is asserted against the injected recorder and the process's stderr rather than a log pipeline.

## Related

- The package README owns the operator-facing description of the lines: [gateway](../../../../packages/api/gateway/README.md)
- The fork inventory row this surface is registered under: [FORK_SURFACE.md](../../../../FORK_SURFACE.md)
- The mux's other transport-level field: [per-message deflate](../architecture/2026-08-29-remote-mux-permessage-deflate.md)
