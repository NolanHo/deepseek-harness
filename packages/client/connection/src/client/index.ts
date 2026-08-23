/**
 * Browser wire client. The plugin selects fixture or HTTP transport, provides
 * the shared API client, and lets the runtime object layer start the stream
 * controller with its sinks.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.modules Context merge (the parsed boot manifest's
// trustedAuthorities feeds the serving-authority decision below).
import type {} from '@deepseek-ai/dsh-client-modules/client'
import type { HostDescription, IApiClient } from './api.ts'
import { ConnectionController, type ConnectionConfig, type ConnectionSinks, type ConnectionState } from './connection.ts'
import { FixtureApiClient } from './fixture.ts'
import { WebApiClient } from './web-api-client.ts'
import { createWebConnectionRpc, type RpcFetch } from './rpc.ts'
import { isLoopbackHostname } from '../loopback-hostname.ts'
import type { ClientConnectionRpc } from '../rpc.ts'

// ---- Contract re-exports (browser-safe apiproxy channels + core types) ----
export type {
  ApiProxy, SessionsApi, SessionSearchItem, SessionSummary, PromptContentPart, HostApi, EventsApi, MuxFrame, HostFrame,
  ApprovalResponsePayload, QuestionResponsePayload, HistoryEntry, ToolEventView,
  DirectoryEntry, DirectoryListing,
  ToolCallView, ToolResultView, WorkspaceApi, WorkspaceId, WorkspaceView,
  SkillsApi, SkillEntry,
  ModelCatalogFailure, ModelCatalogModel, ModelProviderGroup, ModelReasoning,
  MessageId, ModelReasoningEffort, ModelSelection, QueueAction, QueuedInboxItem, SessionModels,
  SubagentsApi, SubagentAddress, SubagentCatalog, SubagentListEntry, SubagentPromptReceipt,
  JobView,
  RpcRequest, RpcResponse, RpcResult, RpcError, RpcErrorCode,
  ClientRequest, ServerResponse, ServerRequest, ClientResponse, RpcMessage, RpcReceipt,
  HostDescription, IApiClient, SessionId, SessionEvent, ContentBlock, StreamChunk,
  GoalsApi, GoalRef,
  SettingsApi, SettingsNamespaceView, SettingsPathOpView, SettingsSecretView,
  CredentialsApi, CredentialView, ConfigurableProviderView, DiscoveredModelView, LlmApi,
} from './api.ts'
export {
  RpcId,
  AbstractApiClient,
  transportError,
} from './api.ts'

// Connection loop types are public through ConnectionHandle.start; the
// controller remains package-internal.
export type { ConnectionConfig, ConnectionSinks, ConnectionState }
export type { ClientConnectionRpc } from '../rpc.ts'
export type { RpcFetch } from './rpc.ts'

/** Observable Host description published by each completed connection handshake. */
export interface HostDescriptionSource {
  /** Latest connected-generation description; absent before connect and while reconnecting. */
  getSnapshot(): HostDescription | undefined
  /** Subscribe to description replacement and connection loss. */
  subscribe(listener: () => void): () => void
}

/** Required services (none — this is the wire root). */
export const inject: string[] = []

/**
 * Carrier override installed on the page global before plugin boot. The served
 * web app leaves it unset and gets HTTP + WebSocket; a shell that owns a
 * different physical transport (the worker preview's postMessage tunnel)
 * provides both halves here instead of forking this plugin.
 */
export interface ClientTransportHooks {
  /** Build the API carrier: unary calls plus the two downstream event streams. */
  createApiClient(): IApiClient
  /** Transport for generic unary RPC channels (the Typert gateway). */
  fetch: RpcFetch
  /**
   * Bundle transport for the module system, present when the carrier also owns
   * bundle bytes (the worker tunnel). Absent in the served web app, whose
   * bundles load over HTTP.
   */
  loadBundle?(url: string): Promise<void>
}

/** Page global carrying {@link ClientTransportHooks}; absent in the served web app. */
interface ClientTransportGlobal {
  __DSH_TRANSPORT__?: ClientTransportHooks
}

/**
 * Whether one boot-wire authority entry matches the current page authority,
 * mirroring the host fence's comparison semantics: a port-less entry matches
 * the hostname on any port; a `host:port` entry matches that exact authority.
 * The entry parses through WHATWG normalization, so case and a redundant
 * `:80` never decide trust; an unparsable entry never matches.
 * @param hostname - page hostname (WHATWG-normalized by the browser).
 * @param port - page port string ('' on a default port).
 * @param entry - one wire entry, canonical `host[:port]`.
 * @returns whether the entry covers the page authority.
 */
function matchesAuthority(hostname: string, port: string, entry: string): boolean {
  let entryUrl: URL
  try {
    entryUrl = new URL(`http://${entry}`)
  } catch {
    // A malformed wire entry — the host validated every entry, so only a
    // broken wire contract reaches this catch. Never a match.
    return false
  }
  // Judged under both special schemes, whose default ports differ, so `:80`
  // and `:443` still count as explicit — the host fence's canonical rule.
  // The https re-parse cannot fail once the http parse succeeded (both are
  // WHATWG special schemes); the host fence relies on the same fact.
  const entryPort = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  if (entryPort === '') return entryUrl.hostname === hostname
  return entryUrl.host === (port === '' ? hostname : `${hostname}:${port}`)
}

/**
 * The ctx.connection service API: the API client plus a one-shot
 * controller starter (the runtime plugin supplies sinks when its object layer
 * is ready — connection stays consumer-agnostic).
 */
export interface ConnectionHandle {
  /** Shared api client (fixture or real, decided at boot from the page URL). */
  readonly api: IApiClient
  /**
   * Whether the current page authority is one this deployment serves at:
   * loopback, or listed in the host-published boot wire; non-browser
   * contexts default to true.
   */
  readonly isServingAuthority: boolean
  /** Generation-scoped Host facts, including the account home and native path-open capability. */
  readonly hostDescription: HostDescriptionSource
  /** Generic logical RPC channels over the same Connection transport. */
  readonly rpc: ClientConnectionRpc
  /**
   * Start the connect/pump/reconnect loop with the consumer's frame sinks.
   * One consumer owns the streams (the runtime object layer); a second call
   * throws.
   * @param sinks - frame/state callbacks.
   * @param config - reconnect/backoff tunables.
   * @returns stop handle for the loop.
   */
  start(sinks: ConnectionSinks, config?: ConnectionConfig): { stop(): void }
}

/**
 * Client plugin body: pick the api by page mode and provide ctx.connection.
 * @param ctx - client cordis context.
 */
export function apply(ctx: Context): void {
  const pageLocation = typeof location === 'undefined' ? undefined : location
  const fixture = pageLocation !== undefined && new URLSearchParams(pageLocation.search).has('fixture')
  const fixtureClient = fixture ? new FixtureApiClient() : undefined
  const transport = (globalThis as ClientTransportGlobal).__DSH_TRANSPORT__
  const api: IApiClient = fixtureClient ?? transport?.createApiClient() ?? new WebApiClient()
  const rpc = fixtureClient?.rpc ?? createWebConnectionRpc(transport?.fetch)
  let started = false
  let description: HostDescription | undefined
  const descriptionListeners = new Set<() => void>()
  const publishDescription = (next: HostDescription | undefined): void => {
    if (Object.is(description, next)) return
    description = next
    for (const listener of [...descriptionListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[web-runtime] host-description listener threw:', error)
      }
    }
  }
  const handle: ConnectionHandle = {
    api,
    isServingAuthority: pageLocation === undefined
      || isLoopbackHostname(pageLocation.hostname)
      || (ctx.get('modules')?.manifest.trustedAuthorities ?? []).some(
        entry => matchesAuthority(pageLocation.hostname, pageLocation.port, entry),
      ),
    hostDescription: {
      getSnapshot: () => description,
      subscribe: (listener) => {
        descriptionListeners.add(listener)
        return () => { descriptionListeners.delete(listener) }
      },
    },
    rpc,
    start(sinks, config) {
      if (started) throw new Error('connection: the stream loop is already owned by another consumer')
      started = true
      const controller = new ConnectionController(api, {
        ...sinks,
        onConnected: (next) => {
          publishDescription(next)
          // A description subscriber may synchronously stop the loop. In that
          // case publishDescription(undefined) has already retracted this
          // generation, so do not leak its stale connected notification to
          // the consumer sink afterward.
          if (!Object.is(description, next)) return
          sinks.onConnected?.(next)
        },
        onStateChange: (state) => {
          if (state === 'reconnecting') publishDescription(undefined)
          sinks.onStateChange?.(state)
        },
      }, config ?? {})
      controller.start()
      return {
        stop: () => {
          controller.stop()
          publishDescription(undefined)
        },
      }
    },
  }
  ctx.provide('connection', handle)
}
