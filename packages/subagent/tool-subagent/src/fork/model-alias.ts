// Fork-owned model-alias module (see FORK_SURFACE.md): the per-instance alias
// face upstream's delegation tool does not carry. `src/index.ts` keeps only the
// marked call sites, so upstream's model-face and route-resolution rewrites stay
// mergeable.

import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/** One `models` entry: a model-facing alias for one exact child LLM route. */
export interface AliasRouteConfig {
  /** Alias accepted by the tool's `model` parameter. */
  readonly alias: string
  /** Registered LLM provider route, preflighted against the live adapter before the child starts. */
  readonly provider: string
  /** Provider-owned exact model id. */
  readonly model: string
  /** Adapter-owned reasoning effort; omitted uses the selected model's own default. */
  readonly reasoningEffort?: string
}

/** The configuration keys the alias face reads. */
export interface ModelAliasConfig {
  /** The instance's alias table; omitted keeps upstream's model face. */
  readonly models?: readonly AliasRouteConfig[]
  /** Default alias when a call omits `model`; defaults to the first entry. */
  readonly defaultModel?: string
}

/** One validated alias table entry, detached from the raw config object. */
interface AliasRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/**
 * One tool instance's model face: the aliases it accepts, its default, and the
 * model-facing wording that advertises both. Provider and model ids never
 * appear here — the face is aliases only.
 */
export interface ModelAliasFace {
  /** Accepted alias → exact route. This instance's table IS its authorization surface. */
  readonly routes: ReadonlyMap<string, AliasRoute>
  /** Alias used when a call omits `model`. */
  readonly defaultModel: string
  /** Sentence appended to the tool description. */
  readonly descriptionSuffix: string
  /** Wording of the `model` parameter. */
  readonly parameterDescription: string
}

/** Reject a non-string or empty-string alias table value. */
function assertNonEmptyString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`tool-subagent: ${what} must be a non-empty string`)
  }
  return value
}

/** Keys one `models` entry accepts, in declaration order (also the wording order). */
const ALIAS_ENTRY_KEYS = ['alias', 'provider', 'model', 'reasoningEffort'] as const

/**
 * Validate one instance's alias table and build its model face. Misconfiguration
 * fails here, at plugin load, rather than at the first delegation.
 * @param config - the instance config carrying the optional alias keys.
 * @returns the resolved face, or `undefined` when `models` is omitted (upstream
 *   keeps its `provider`/`model`/`reasoning_effort` face and session policy).
 * @throws when `models` is present but is not a non-empty array, an entry is not
 *   an object or carries an unknown key, an entry's `alias`/`provider`/`model`
 *   is not a non-empty string, `reasoningEffort` is present but not a non-empty
 *   string, an alias repeats, `defaultModel` is not in the table, or
 *   `defaultModel` is present without `models`.
 */
export function resolveModelAliasFace(config: ModelAliasConfig): ModelAliasFace | undefined {
  if (config.models === undefined) {
    // A lone `defaultModel` is the `models` typo's other half: the alias face is
    // absent, so the key would be inert while the instance keeps the upstream
    // face and children inherit the parent's route.
    if (config.defaultModel !== undefined) {
      throw new Error(
        'tool-subagent: `defaultModel` is configured without `models` '
        + '— add the alias table or remove `defaultModel`',
      )
    }
    return undefined
  }
  // `Array.isArray` narrows the runtime value; a config surface that bypasses
  // Schemastery (direct `apply()`) can carry anything here.
  if (!Array.isArray(config.models) || config.models.length === 0) {
    throw new Error('tool-subagent: `models` must list at least one alias entry')
  }
  const routes = new Map<string, AliasRoute>()
  const candidates: readonly unknown[] = config.models
  // First alias in declaration order, captured during the loop: reading it back
  // as `aliases[0]` would need either a non-null assertion (banned by the
  // repository lint) or an empty-table guard that is unreachable after the
  // length check above (and would be reported as an uncovered branch).
  let firstAlias = ''
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new Error('tool-subagent: each `models` entry must be an object with `alias`, `provider`, and `model`')
    }
    const entry = candidate as Partial<AliasRouteConfig>
    // Cordis validates with a non-strict schema, so an unknown key survives into
    // the resolved config: a typo such as `reasoningEffortt` would otherwise
    // leave the child on the model default effort with no trace in the routing.
    const unknown = Object.keys(entry).filter(key => !(ALIAS_ENTRY_KEYS as readonly string[]).includes(key))
    if (unknown.length > 0) {
      throw new Error(
        `tool-subagent: a \`models\` entry has unknown key(s) ${unknown.map(key => `"${key}"`).join(', ')} `
        + `(allowed: ${ALIAS_ENTRY_KEYS.join(', ')})`,
      )
    }
    const alias = assertNonEmptyString(entry.alias, 'each `models` alias')
    const provider = assertNonEmptyString(entry.provider, `model "${alias}" provider`)
    const model = assertNonEmptyString(entry.model, `model "${alias}" model`)
    if (entry.reasoningEffort !== undefined && (typeof entry.reasoningEffort !== 'string' || entry.reasoningEffort.length === 0)) {
      throw new Error(`tool-subagent: model "${alias}" reasoningEffort must be a non-empty string when present`)
    }
    if (routes.has(alias)) {
      throw new Error(`tool-subagent: \`models\` repeats alias "${alias}"`)
    }
    if (firstAlias === '') firstAlias = alias
    routes.set(alias, {
      provider,
      model,
      ...entry.reasoningEffort === undefined ? {} : { reasoningEffort: entry.reasoningEffort },
    })
  }
  const aliases = [...routes.keys()]
  const defaultModel = config.defaultModel === undefined
    ? firstAlias
    : assertNonEmptyString(config.defaultModel, '`defaultModel`')
  if (!routes.has(defaultModel)) {
    throw new Error(
      `tool-subagent: \`defaultModel\` "${defaultModel}" is not in \`models\` (allowed: ${aliases.join(', ')})`,
    )
  }
  const allowed = aliases.join(', ')
  return {
    routes,
    defaultModel,
    descriptionSuffix: ` Child model routing uses a fixed alias whitelist: ${allowed}. `
      + `Omit \`model\` to use ${defaultModel}; any other value is rejected.`,
    parameterDescription: `Optional child model alias. Omit to use the default (${defaultModel}); `
      + `any other value is rejected. Allowed: ${allowed}.`,
  }
}

/**
 * Resolve the model-facing `model` value into one exact child route.
 * @param face - the instance's alias face.
 * @param requested - the model-facing alias, or `undefined` for the default.
 * @returns the route as child Agent options.
 * @throws when the alias is empty or outside this instance's table, listing the
 *   aliases this instance accepts.
 */
export function resolveAliasRoute(face: ModelAliasFace, requested: string | undefined): AgentOptions {
  if (requested !== undefined && requested.length === 0) {
    throw new Error('child `model` must be a non-empty alias when present')
  }
  const alias = requested ?? face.defaultModel
  const route = face.routes.get(alias)
  if (route === undefined) {
    throw new Error(
      `child model alias "${alias}" is not allowed for this tool instance `
      + `(allowed: ${[...face.routes.keys()].join(', ')})`,
    )
  }
  return {
    provider: route.provider,
    model: route.model,
    ...route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) },
  }
}

/**
 * Merge an alias route over the instance's configured child options. The route
 * owns provider, model, and effort: a configured effort belongs to the
 * configured route, so an alias without one uses the selected model's own
 * default instead of inheriting it (upstream's route-change rule). Configured
 * non-route fields such as `maxTokens` survive.
 * @param configured - the instance's `agentOptions`, if any.
 * @param route - the resolved alias route.
 * @returns child options carrying the alias route.
 */
export function aliasChildAgentOptions(configured: AgentOptions | undefined, route: AgentOptions): AgentOptions {
  const {
    provider: _configuredProvider,
    model: _configuredModel,
    reasoningEffort: _configuredReasoningEffort,
    ...configuredRest
  } = configured ?? {}
  return { ...configuredRest, ...route }
}
