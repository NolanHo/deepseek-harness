// Fork-owned child-scoping module (see FORK_SURFACE.md): the per-child
// workspace stamping and skill scoping upstream's subagent composition does
// not carry. child-agent.ts keeps only the delegating call sites, so upstream
// signature changes stay small; these pure helpers own the behavior.

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillFilter } from '../types.ts'

/**
 * Resolve the workspace a child session is created with: an explicitly
 * requested `cwd` overrides the parent's header value once, at creation, and
 * a resumed child restores its own persisted header rather than re-reading
 * this value.
 * @param cwd - the child's requested workspace, if any.
 * @param parentCwd - the parent session header's workspace, if any.
 * @returns the child's creation workspace, or `undefined` without one.
 * @throws when a requested `cwd` is not an absolute path.
 */
export function stampChildCwd(cwd: string | undefined, parentCwd: string | undefined): string | undefined {
  if (cwd !== undefined && !isAbsolute(cwd)) {
    throw new Error(`child session cwd must be an absolute path, got "${cwd}"`)
  }
  return cwd ?? parentCwd
}

/**
 * The `ctx.skills` surface child composition consumes. Structural on purpose:
 * the subagent seam stays independent of the skill registry's declarations
 * while `applyChildSkillFilter` still reaches the one method it needs. The
 * `SkillFilter` request field is the registry's `SkillRestriction` shape.
 */
interface SkillsRestrictSurface {
  restrict(filter: SkillFilter): () => void
}

/**
 * Apply a per-child skill filter through the child's scoped creation context,
 * so restricted-away names read as nonexistent in the child's skill catalog
 * views. The skill registry is an optional composition member; a request that
 * names a filter must not silently skip scoping, so an absent registry fails
 * the child's creation.
 * @param childCtx - the child agent's scoped creation context.
 * @param filter - the per-child skill mask to register.
 * @throws when the skill registry is not composed.
 */
export function applyChildSkillFilter(childCtx: Context, filter: SkillFilter): void {
  // `ctx.get` returns `any` for untyped names, and this package deliberately
  // does not depend on the registry's declarations, so the structural surface
  // narrows it.
  const skills: SkillsRestrictSurface | undefined = childCtx.get('skills')
  if (skills === undefined) {
    throw new Error('skillFilter requires the skill registry: compose @deepseek-ai/dsh-skill before restricting a child\'s skills')
  }
  skills.restrict(filter)
}
