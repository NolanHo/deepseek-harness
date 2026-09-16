// Fork-owned config-surface guard (see FORK_SURFACE.md): the loader resolves a
// plugin config with Schemastery's NON-strict object schema, which merges
// undeclared input keys through instead of rejecting them
// (`vendor/schemastery/src/index.ts`, `Schema.extend('object', ...)`:
// `if (!strict) merge(result, data)`; Cordis validates through
// `Config['~standard'].validate`). `src/index.ts` keeps only the marked call
// site, so upstream's own load-time assertions stay mergeable.

/**
 * Config keys used when the schema does not expose its declared-key map. Keep in
 * sync with `Config` in `src/index.ts`: an upstream key added there must be
 * added here too, or a legal upstream config would fail the guard below. Only
 * reachable if a future Schemastery stops exposing `dict`.
 */
const FALLBACK_CONFIG_KEYS = [
  // Upstream's keys, in `Config` declaration order.
  'provider',
  'toolName',
  'modelSelectionSettings',
  'enableRunInBackground',
  'backgroundMode',
  'agentOptions',
  'persona',
  'toolFilter',
  'maxDepth',
  // The fork patch's keys.
  'models',
  'defaultModel',
  'cwd',
  'skillFilter',
] as const

/**
 * The config keys one plugin instance accepts, derived from its own object
 * schema's declared-key map (`Config.dict`) so an upstream key added to `Config`
 * is accepted with no second list to edit.
 * @param dict - the schema's declared-key map, or `undefined` when the schema
 *   exposes none.
 * @returns the allowed keys: the schema's own declared keys, or the fallback
 *   list.
 */
export function allowedConfigKeys(dict: Readonly<Record<string, unknown>> | undefined): ReadonlySet<string> {
  return new Set(dict === undefined ? FALLBACK_CONFIG_KEYS : Object.keys(dict))
}

/**
 * Reject config keys outside the schema's declared surface. Without this the
 * non-strict loader path above lets a top-level typo survive into `apply()`: a
 * row spelling `models` as `modelz` would mount the upstream face instead — no
 * `model` parameter, an inert `defaultModel`, and children inheriting the
 * parent's route — silently. Keys are read from `Object.keys` only; symbols and
 * the prototype chain are not config surface.
 * @param config - the config object `apply()` received.
 * @param allowed - the keys the plugin's schema declares.
 * @throws when the config carries a key outside `allowed`, naming the unknown
 *   keys and listing the allowed set.
 */
export function assertKnownConfigKeys(config: object, allowed: ReadonlySet<string>): void {
  const unknown = Object.keys(config).filter(key => !allowed.has(key))
  if (unknown.length === 0) return
  throw new Error(
    `tool-subagent: unknown config key(s) ${unknown.map(key => `"${key}"`).join(', ')} `
    + `(allowed: ${[...allowed].join(', ')})`,
  )
}
