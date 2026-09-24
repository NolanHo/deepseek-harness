// Fork-owned V3→V4 descriptor-generation compatibility (see FORK_SURFACE.md).
// The frozen edge interprets descriptor versions 1 through 3 and degrades every
// other generation to unknown-mode catalog membership; the installed
// `@deepseek-ai/dsh-subagent` stamps version 4 into every new payload, so a
// parent's own recorded child would lose the mode and label its child carries.
// This module owns the interpreted generation set, and `facts.ts` keeps one
// marked delegation here.

/**
 * Descriptor version the installed `@deepseek-ai/dsh-subagent` stamps into new
 * payloads; `SUBAGENT_DESCRIPTOR_VERSION` there owns the value. This edge reads
 * it here instead of importing the package: every released-format restore loads
 * this edge, and the subagent seam would bring its product peers (agent, tools,
 * jobs, sandbox) into that path.
 */
export const CURRENT_SUBAGENT_DESCRIPTOR_VERSION = 4

/**
 * Descriptor generations whose discovery fields a parent catalog interprets:
 * the three released generations this edge was written against, plus the
 * generation the installed subagent package writes. A parent that already lists
 * the child retains its own entry; a descendant of an unlisted generation keeps
 * unknown-mode membership instead of asserting a mode this edge cannot read.
 */
const INTERPRETED_DESCRIPTOR_VERSIONS: readonly number[] = Object.freeze([
  1,
  2,
  3,
  CURRENT_SUBAGENT_DESCRIPTOR_VERSION,
])

/**
 * Whether one descriptor payload carries a generation the parent catalog reads.
 * @param version - the `version` member of a decoded descriptor payload, of any type.
 * @returns true for the released generations and the installed one.
 */
export function isInterpretedDescriptorVersion(version: unknown): boolean {
  return typeof version === 'number' && INTERPRETED_DESCRIPTOR_VERSIONS.includes(version)
}
