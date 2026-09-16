// Fork-owned delegation-scope module (see FORK_SURFACE.md): the per-child
// workspace and skill scope upstream's delegation tool does not carry. The
// request fields themselves belong to the subagent seam; this module owns the
// load-time validation and the request mapping, so `src/index.ts` keeps one
// marked import and two marked request spreads.

import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { SkillFilter } from '@deepseek-ai/dsh-subagent'

/** A skill allow/deny filter as written in configuration. */
export interface DelegationSkillFilterConfig {
  /** Skill names the child keeps; everything else is restricted away. */
  readonly allow?: readonly string[]
  /** Skill names restricted away from the child. */
  readonly deny?: readonly string[]
}

/** The configuration keys the per-child scope reads. */
export interface DelegationScopeConfig {
  /** Child working directory; must be an existing absolute directory. */
  readonly cwd?: string
  /** Child skill scope; exactly one of `allow` or `deny`. */
  readonly skillFilter?: DelegationSkillFilterConfig
}

/** Validated per-child isolation, already in request-field shape. */
export interface DelegationScope {
  readonly cwd?: string
  readonly skillFilter?: SkillFilter
}

/**
 * Validate one instance's per-child isolation and map it onto the start
 * request's `cwd`/`skillFilter` fields.
 *
 * Validation is deliberately load-time: the in-process child creation path
 * rejects a relative or missing workspace and a filter without the skill
 * registry, so a misconfiguration would otherwise surface at the first
 * delegation instead of at plugin load. The filter shape is enforced here in
 * full (object, known keys, array-of-string members, exactly one direction)
 * because every unusable shape widens or breaks the child's skill face
 * silently otherwise.
 * @param config - the instance config carrying the optional scope keys.
 * @returns the request fields to spread, with omitted keys staying omitted.
 * @throws when `cwd` is not a non-empty absolute path or not an existing
 *   directory, or when `skillFilter` is not an object naming exactly one of
 *   `allow`/`deny` with string-array members.
 */
export function resolveDelegationScope(config: DelegationScopeConfig): DelegationScope {
  const { cwd } = config
  if (cwd !== undefined) {
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new Error('tool-subagent: `cwd` must be a non-empty absolute path when present')
    }
    if (!isAbsolute(cwd)) {
      throw new Error(`tool-subagent: \`cwd\` must be an absolute path (got "${cwd}")`)
    }
    const stats = existsSync(cwd) ? statSync(cwd) : undefined
    if (stats?.isDirectory() !== true) {
      throw new Error(`tool-subagent: \`cwd\` "${cwd}" must be an existing directory`)
    }
  }
  const skillFilter = config.skillFilter === undefined
    ? undefined
    : assertSkillFilter(config.skillFilter)
  return {
    ...cwd === undefined ? {} : { cwd },
    ...skillFilter === undefined ? {} : { skillFilter },
  }
}

/**
 * Validate one `skillFilter` value. Arrays and `null` are objects at runtime
 * but are not filters, and a lone-direction filter is the only usable shape:
 * the child creation path requires exactly one of `allow`/`deny`.
 */
function assertSkillFilter(value: unknown): SkillFilter {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('tool-subagent: `skillFilter` must be an object naming exactly one of `allow` or `deny`')
  }
  const filter = value as { readonly allow?: unknown; readonly deny?: unknown }
  const unknown = Object.keys(filter).filter(key => key !== 'allow' && key !== 'deny')
  if (unknown.length > 0) {
    throw new Error(
      `tool-subagent: \`skillFilter\` has unknown key(s) ${unknown.map(key => `"${key}"`).join(', ')} `
      + '(allowed: allow, deny)',
    )
  }
  for (const key of ['allow', 'deny'] as const) {
    const names = filter[key]
    // An empty `allow` is meaningful (restrict every skill away); a non-array
    // or a non-string member would silently widen the child's skill face.
    if (names !== undefined && (!Array.isArray(names) || names.some(name => typeof name !== 'string'))) {
      throw new Error(`tool-subagent: \`skillFilter\` \`${key}\` must be an array of skill names when present`)
    }
  }
  if (filter.allow === undefined && filter.deny === undefined) {
    throw new Error(
      'tool-subagent: `skillFilter` is configured but names neither `allow` nor `deny` '
      + '— remove the key or fill the filter',
    )
  }
  if (filter.allow !== undefined && filter.deny !== undefined) {
    throw new Error('tool-subagent: `skillFilter` cannot name both `allow` and `deny`')
  }
  return filter as SkillFilter
}
