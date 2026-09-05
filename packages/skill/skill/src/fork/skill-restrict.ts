// Fork-owned skill-restriction module (see FORK_SURFACE.md): the catalog
// restrictions upstream's skill registry does not carry — the `SkillRestriction`
// mask, its compile step, and the scope-layer filtering `SkillRegistry.restrict`
// applies to inherited catalog views. Restriction records live on their own
// scope layers inside this store, so `index.ts` keeps only a delegating method
// and one collect hook for future syncs.

import type { Context } from '@deepseek-ai/cordis'
import type { ScopeKey, ScopeLayer } from '@deepseek-ai/dsh-scope'
import { AnonymousEntries, ScopedLayers, scopeOf } from '@deepseek-ai/dsh-scope'

/**
 * Per-scope filter over inherited skill names. One direction only: `allow`
 * keeps only the named skills, `deny` removes the named skills. Declaring both
 * throws, as does declaring neither.
 */
export interface SkillRestriction {
  /** Skill names that stay visible; every other catalog name is restricted away. */
  readonly allow?: readonly string[]
  /** Skill names restricted away from the catalog view. */
  readonly deny?: readonly string[]
}

/** One restriction compiled at registration for repeated catalog filtering. */
interface CompiledSkillRestriction {
  readonly allow?: ReadonlySet<string>
  readonly deny?: ReadonlySet<string>
}

/** One scope's compiled skill-restriction registrations. */
class RestrictionLayer implements ScopeLayer {
  readonly entries = new AnonymousEntries<CompiledSkillRestriction>()

  /** Whether this layer holds no compiled restriction. */
  isEmpty(): boolean {
    return this.entries.isEmpty()
  }

  /** Whether every compiled restriction in this layer admits a skill name. */
  admits(name: string): boolean {
    for (const filter of this.entries.values()) {
      if ((filter.allow !== undefined && !filter.allow.has(name))
        || (filter.deny !== undefined && filter.deny.has(name))) return false
    }
    return true
  }
}

/**
 * Validate and compile one restriction at registration for repeated catalog
 * filtering. An empty filter and a filter naming both directions are
 * materialized-config bugs and throw; the compiled form owns the name sets.
 * @param filter - inherited-name mask: `allow` (keep only) or `deny` (remove), never both.
 * @returns the compiled restriction.
 * @throws when the filter names no direction or names both directions.
 */
function compileRestriction(filter: SkillRestriction): CompiledSkillRestriction {
  const allow = filter.allow
  const deny = filter.deny
  if (allow === undefined && deny === undefined) {
    throw new Error('skills.restrict({}) is a no-op: pass `allow` or `deny` (an empty filter is almost always a materialized-empty-config bug)')
  }
  if (allow !== undefined && deny !== undefined) {
    throw new Error('skills.restrict() cannot declare both allow and deny: name the keep-list or the drop-list, not both')
  }
  return {
    ...allow !== undefined ? { allow: new Set(allow) } : {},
    ...deny !== undefined ? { deny: new Set(deny) } : {},
  }
}

/**
 * Per-registry owner of catalog restrictions. One `SkillRegistry.restrict()`
 * registration appends a compiled restriction to this store's layer for the
 * calling scope; the Cordis effect owns that registration, keeps the layer
 * alive, and raises the registry's cache invalidation on commit and disposal.
 * A merged catalog view is then filtered through the viewing scope's chain of
 * restriction layers. Restrictions never enter the store's global layer: a
 * context-global mask is rejected at registration.
 */
export class SkillRestrictionStore {
  private readonly layers: ScopedLayers<RestrictionLayer>

  /**
   * @param onChange - registry cache invalidation raised whenever a
   * restriction registration commits or is disposed.
   */
  constructor(onChange: () => void) {
    this.layers = new ScopedLayers<RestrictionLayer>(
      () => new RestrictionLayer(),
      () => onChange(),
    )
  }

  /**
   * Restrict the inherited skill catalog for the calling agent scope. A
   * restriction filters what every view through that scope — `snapshot`,
   * `list`, and `get`, so the skill catalog tool and its loader read the same
   * filtered face — inherits from the global layer and every ancestor layer on
   * its chain; the scope's OWN registrations stay visible, so child machinery
   * registered into the restricting layer keeps its names. Restrictions
   * intersect across the whole chain: any scope on it may mask an inherited
   * name for everything nested inside it, and a restricted-away name reads
   * as nonexistent. The disposer lifts this restriction.
   *
   * Two deliberate divergences from `tools.restrict()`: the filter names one
   * direction only (`allow` and `deny` together throw, because a skill
   * catalog's keep-list and drop-list are configured by role, not composed),
   * and names are not validated against the catalog — discovery is
   * asynchronous, so a restrict-time check could not see providers that have
   * not answered yet; the filter applies to whatever the catalog yields.
   * @param ctx - the calling context; its scope selects the restricted scope
   * and owns the registration.
   * @param filter - inherited-name mask: `allow` (keep only) or `deny` (remove), never both.
   * @returns the exact disposer that lifts this restriction.
   * @throws when the calling context is unscoped or the filter is invalid.
   */
  restrict(ctx: Context, filter: SkillRestriction): () => void {
    const scope = scopeOf(ctx)
    if (scope === undefined) {
      throw new Error('skills.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — filter the catalog for the intended agent at its lookup instead')
    }
    const compiled = compileRestriction(filter)
    return this.layers.effect(
      ctx,
      layer => layer.entries.append(compiled),
      { label: 'skills.restrict()' },
    )
  }

  /**
   * Apply every restriction on the viewing scope's chain to a merged catalog
   * view, deleting restricted-away names in place. Rows registered by the
   * viewing scope's OWN layer stay visible — a child's filter must not strip
   * machinery registered into its own layer — while every restriction on the
   * chain, including the viewing scope's own, masks an inherited name.
   * Unrestricted chains skip the pass, so the common read path never iterates
   * the catalog.
   * @param entries - merged catalog rows keyed by skill name, mutated in place.
   * @param own - the viewing scope's own registry layer, or `undefined` without one.
   * @param scope - viewing scope whose chain supplies the restrictions.
   */
  filterInherited<T extends { readonly layer: object }>(
    entries: Map<string, T>,
    own: T['layer'] | undefined,
    scope: ScopeKey | undefined,
  ): void {
    const chain = this.layers.chainLayers(scope)
    if (chain.length === 0) return
    for (const [name, entry] of entries) {
      if (entry.layer === own) continue
      if (!chain.every(layer => layer.admits(name))) entries.delete(name)
    }
  }
}
