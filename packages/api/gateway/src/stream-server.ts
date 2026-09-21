/** Host WebSocket owner for multiplexed Typert Remote streams. */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import {
  parseRemoteStreamClientMessage,
  type RemoteStreamFailure,
  type RemoteStreamServerMessage,
} from './stream-protocol.ts'

/** Open one validated Remote stream for a decoded wire request. */
export type RemoteStreamOpener = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<AsyncIterable<unknown>>

/** Convert an invocation or carrier failure to a stable wire value. */
export type RemoteStreamFailureMapper = (error: unknown) => RemoteStreamFailure

// Fork patch (FORK_SURFACE.md): upstream's mux reports no carrier lifecycle, so
// this injectable sink, its threshold, and the four report sites below are the
// fork's.
/**
 * Sink for one transport diagnostic line. The Host composition injects the
 * process logger, so the mux owns the message and never the destination.
 */
export interface RemoteStreamDiagnosticSink {
  /**
   * Emit one complete single-line message.
   * @param message - finished text; callers must not pass a format string with placeholders.
   */
  warn(message: string): void
}

/**
 * Diagnosis of a slow Remote stream carrier: where lines go and the elapsed
 * time that makes one worth reporting. A logical stream's first item and a
 * heartbeat timer tick are both measured against `slowMs`; healthy traffic
 * emits nothing, and the messages carry no payload or session values.
 */
export interface RemoteStreamDiagnostics {
  /** Destination for diagnostic lines. */
  readonly sink: RemoteStreamDiagnosticSink
  /** Elapsed milliseconds at or above which a first item or a late heartbeat tick is reported. */
  readonly slowMs: number
}

/**
 * `perMessageDeflate` options for the negotiable RFC 7692 compression: the
 * threshold keeps sub-kilobyte live frames raw (no deflate latency on the
 * typing path) while page bursts — one `opened` journal frame carrying the
 * whole history window — compress before the wire. Browsers negotiate the
 * extension automatically; a client that does not offer it falls back to raw
 * frames.
 */
const PER_MESSAGE_DEFLATE = { threshold: 1024 } as const

/** Pongs owed before the heartbeat timer terminates a dead carrier. */
const MAX_MISSED_HEARTBEATS = 2

/** Prefix of every mux diagnostic line; operators grep one stream carrier by it. */
const DIAGNOSTIC_PREFIX = 'api gateway: remote stream'

/** Minimum milliseconds between two late-heartbeat lines, so one stall cannot repeat per tick. */
const LATE_HEARTBEAT_REPORT_INTERVAL_MS = 5_000

/** Close-reason characters kept in a diagnostic line; ws admits 123 bytes from a peer, so only a maximum-length reason is clipped. */
const CLOSE_REASON_MAX_LENGTH = 120

/** Own the no-server WebSocket acceptor and every active logical stream. */
export class RemoteStreamMuxServer {
  private readonly server: WebSocketServer
  private readonly connections = new Set<Promise<void>>()
  private readonly missedHeartbeats = new WeakMap<WebSocket, number>()
  // Fork patch (FORK_SURFACE.md): acceptance time, heartbeat causation, and the
  // per-socket tick clock exist only to attribute a diagnostic line.
  private readonly acceptedAt = new WeakMap<WebSocket, number>()
  private readonly heartbeatTerminated = new WeakSet<WebSocket>()
  private heartbeatTimer: NodeJS.Timeout | undefined
  private lastHeartbeatTickAt = 0
  private lastLateHeartbeatAt = 0

  /**
   * @param open - Gateway stream dispatcher.
   * @param failure - Gateway error-to-wire mapper.
   * @param heartbeatIntervalMs - interval between WebSocket Ping control frames.
   * @param perMessageDeflate - negotiate RFC 7692 per-message compression with
   * clients that offer it.
   * @param diagnostics - where slow-carrier lines go and the threshold that
   * makes one worth reporting; absent emits nothing.
   */
  constructor(
    private readonly open: RemoteStreamOpener,
    private readonly failure: RemoteStreamFailureMapper,
    private readonly heartbeatIntervalMs: number,
    perMessageDeflate: boolean = false,
    private readonly diagnostics?: RemoteStreamDiagnostics,
  ) {
    this.server = new WebSocketServer({
      noServer: true,
      ...(perMessageDeflate ? { perMessageDeflate: PER_MESSAGE_DEFLATE } : {}),
    })
  }

  /**
   * Upgrade one trusted request and begin serving its logical streams.
   * @param req - authenticated HTTP upgrade request.
   * @param socket - carrier socket transferred to the WebSocket server.
   * @param head - bytes already read after the HTTP upgrade headers.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.server.handleUpgrade(req, socket, head, (websocket) => {
      this.missedHeartbeats.set(websocket, 0)
      this.acceptedAt.set(websocket, Date.now())
      websocket.on('pong', () => { this.missedHeartbeats.set(websocket, 0) })
      this.startHeartbeat()
      const connection = new RemoteStreamMuxConnection(websocket, this.open, this.failure, this.diagnostics)
      // Fork patch (FORK_SURFACE.md): every carrier close is reported with its cause.
      websocket.once('close', (code, reason) => {
        this.reportSocketClose(websocket, connection.openedStreams, code, reason)
      })
      const done = connection.run()
      this.connections.add(done)
      void done.then(() => { this.connections.delete(done) })
    })
  }

  /** Terminate all sockets and wait until every iterator has returned. */
  async close(): Promise<void> {
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    for (const socket of this.server.clients) socket.terminate()
    const closed = Promise.withResolvers<void>()
    this.server.close((error) => {
      if (error === undefined) closed.resolve()
      else closed.reject(error)
    })
    await closed.promise
    await Promise.all(this.connections)
  }

  /** Start one `unref()` timer after the first upgrade; it spans empty-client periods until close(). */
  private startHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) return
    this.lastHeartbeatTickAt = Date.now()
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now()
      this.reportLateHeartbeat(now)
      this.lastHeartbeatTickAt = now
      for (const socket of this.server.clients) {
        if (socket.readyState !== WebSocket.OPEN) continue
        const missed = this.missedHeartbeats.get(socket) as number
        if (missed >= MAX_MISSED_HEARTBEATS) {
          setImmediate(() => {
            if ((this.missedHeartbeats.get(socket) as number) >= MAX_MISSED_HEARTBEATS) {
              this.heartbeatTerminated.add(socket)
              socket.terminate()
              this.reportHeartbeatTerminate(socket)
            }
          })
          continue
        }
        this.missedHeartbeats.set(socket, missed + 1)
        socket.ping()
      }
    }, this.heartbeatIntervalMs)
    this.heartbeatTimer.unref()
  }

  /**
   * Report one carrier close with everything needed to attribute it: the peer
   * or local close code, the clipped reason, socket lifetime, how many logical
   * streams it carried, and whether the heartbeat killed it.
   */
  private reportSocketClose(
    socket: WebSocket,
    openedStreams: number,
    code: number,
    reason: Buffer,
  ): void {
    if (this.diagnostics === undefined) return
    const text = reason.toString('utf8')
    const clipped = text.length > CLOSE_REASON_MAX_LENGTH
      ? `${text.slice(0, CLOSE_REASON_MAX_LENGTH)}...`
      : text
    const lifetimeMs = Date.now() - (this.acceptedAt.get(socket) as number)
    this.diagnostics.sink.warn(
      `${DIAGNOSTIC_PREFIX} socket closed code=${String(code)} reason=${JSON.stringify(clipped)}`
      + ` lifetimeMs=${String(lifetimeMs)} streams=${String(openedStreams)}`
      + ` heartbeat=${String(this.heartbeatTerminated.has(socket))}`,
    )
  }

  /** Report the actual heartbeat terminate once, after its `setImmediate` re-check confirmed the socket still owed pongs. */
  private reportHeartbeatTerminate(socket: WebSocket): void {
    if (this.diagnostics === undefined) return
    const missed = this.missedHeartbeats.get(socket) as number
    const lifetimeMs = Date.now() - (this.acceptedAt.get(socket) as number)
    this.diagnostics.sink.warn(
      `${DIAGNOSTIC_PREFIX} heartbeat terminate missed=${String(missed)} lifetimeMs=${String(lifetimeMs)}`,
    )
  }

  /** Report a heartbeat tick that the event loop delayed past its interval, at most once per {@link LATE_HEARTBEAT_REPORT_INTERVAL_MS}. */
  private reportLateHeartbeat(now: number): void {
    if (this.diagnostics === undefined) return
    const driftMs = now - this.lastHeartbeatTickAt - this.heartbeatIntervalMs
    if (driftMs < this.diagnostics.slowMs
      || now - this.lastLateHeartbeatAt < LATE_HEARTBEAT_REPORT_INTERVAL_MS) return
    this.lastLateHeartbeatAt = now
    this.diagnostics.sink.warn(`${DIAGNOSTIC_PREFIX} heartbeat tick late driftMs=${String(driftMs)}`)
  }
}

interface ActiveStream {
  readonly abort: AbortController
  done: Promise<void>
}

class RemoteStreamMuxConnection {
  private readonly streams = new Map<string, ActiveStream>()
  private writes = Promise.resolve()
  private opened = 0

  constructor(
    private readonly socket: WebSocket,
    private readonly open: RemoteStreamOpener,
    private readonly failure: RemoteStreamFailureMapper,
    private readonly diagnostics: RemoteStreamDiagnostics | undefined,
  ) {}

  /** Logical streams this carrier has opened, reported with its close line. */
  get openedStreams(): number {
    return this.opened
  }

  async run(): Promise<void> {
    const closed = new Promise<void>((resolve) => {
      this.socket.once('close', resolve)
      this.socket.once('error', () => { this.socket.terminate() })
      this.socket.on('message', (data, isBinary) => {
        if (isBinary) {
          this.socket.close(1003, 'text messages required')
          return
        }
        try {
          this.receive(rawText(data))
        } catch {
          this.socket.close(1008, 'invalid Remote stream request')
        }
      })
    })
    await closed
    const active = [...this.streams.values()]
    for (const stream of active) stream.abort.abort(new Error('Remote stream socket closed'))
    await Promise.all(active.map(stream => stream.done))
  }

  private receive(text: string): void {
    const message = parseRemoteStreamClientMessage(text)
    if (message.type === 'cancel') {
      this.streams.get(message.streamId)?.abort.abort(new Error('Remote stream cancelled'))
      return
    }
    if (this.streams.has(message.streamId)) {
      throw new Error(`api gateway: duplicate Remote stream id ${JSON.stringify(message.streamId)}`)
    }
    const abort = new AbortController()
    const active: ActiveStream = {
      abort,
      done: Promise.resolve(),
    }
    this.streams.set(message.streamId, active)
    this.opened += 1
    const done = this.pump(message.streamId, message.endpoint, message.payload, active)
    active.done = done
    const remove = (): void => { this.streams.delete(message.streamId) }
    void done.then(remove, remove)
  }

  private async pump(
    streamId: string,
    endpoint: string,
    payload: unknown,
    active: ActiveStream,
  ): Promise<void> {
    const startedAt = Date.now()
    try {
      const source = await this.open(endpoint, payload, active.abort.signal)
      let first = true
      for await (const value of source) {
        if (first) {
          first = false
          this.reportFirstItem(endpoint, startedAt)
        }
        await this.send({ type: 'item', streamId, value })
      }
      if (!active.abort.signal.aborted) await this.send({ type: 'end', streamId })
    } catch (error) {
      if (!active.abort.signal.aborted && this.socket.readyState === WebSocket.OPEN) {
        try {
          await this.send({ type: 'error', streamId, error: this.failure(error) })
        } catch {
          // A terminal frame that cannot be encoded or written leaves the
          // logical stream ambiguous, so fail the physical generation.
          this.socket.close(1011, 'Remote stream failure could not be delivered')
        }
      }
    }
  }

  /** Report a first item that took at least the configured slow threshold to produce. */
  private reportFirstItem(endpoint: string, startedAt: number): void {
    if (this.diagnostics === undefined) return
    const elapsedMs = Date.now() - startedAt
    if (elapsedMs < this.diagnostics.slowMs) return
    this.diagnostics.sink.warn(
      `${DIAGNOSTIC_PREFIX} first item slow endpoint=${JSON.stringify(endpoint)} elapsedMs=${String(elapsedMs)}`,
    )
  }

  private send(message: RemoteStreamServerMessage): Promise<void> {
    let text: string
    try {
      text = JSON.stringify(message)
    } catch (cause) {
      return Promise.reject(new Error('api gateway: Remote stream item is not JSON serializable', { cause }))
    }
    const delivery = this.writes.then(() => new Promise<void>((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error('api gateway: Remote stream socket is closed'))
        return
      }
      this.socket.send(text, (error) => {
        if (error) reject(error)
        else resolve()
      })
    }))
    this.writes = delivery.catch(() => undefined)
    return delivery
  }
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/**
 * Reject an upgrade without transferring socket ownership to ws.
 * @param socket - carrier socket that receives the HTTP rejection.
 * @param status - authentication or browser-trust rejection status.
 */
export function rejectRemoteStreamUpgrade(socket: Duplex, status: 401 | 403): void {
  const reason = status === 401 ? 'Unauthorized' : 'Forbidden'
  const body = reason.toLowerCase()
  socket.end([
    `HTTP/1.1 ${String(status)} ${reason}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    '',
    body,
  ].join('\r\n'))
}
