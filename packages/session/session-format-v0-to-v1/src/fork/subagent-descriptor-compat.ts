// Fork-owned released-v0 descriptor compatibility (see FORK_SURFACE.md). The
// frozen edge validates descriptor version 3 and refuses every other version;
// the installed `@deepseek-ai/dsh-subagent` stamps version 4 into new payloads,
// and a payload carrying 2 or 3 predates the composition inputs version 4
// added. Both cases reach the frozen payload rules through this module, so
// `dispositions.ts`, `migration.ts`, `payload-validation.ts`, and
// `validation.ts` keep single marked delegations here.

import {
  SessionFormatUnsupportedMigrationError,
  sessionFormatCount,
} from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatEvent,
  SessionFormatJsonValue,
} from '@deepseek-ai/dsh-session-format'
import { releasedV0Record } from '../validation-helpers.ts'

/**
 * Descriptor version the installed `@deepseek-ai/dsh-subagent` stamps into new
 * payloads; `SUBAGENT_DESCRIPTOR_VERSION` there owns the value. This edge reads
 * it here instead of importing the package: every released-format restore loads
 * this edge, and the subagent seam would bring its product peers (agent, tools,
 * jobs, sandbox) into that path. `tests/descriptor-compat.spec.ts` reads the
 * owning definition and fails when the version moves.
 */
export const CURRENT_SUBAGENT_DESCRIPTOR_VERSION = 4

/**
 * Oldest descriptor generation released v0 logs carry: version 2 recorded the
 * resolved child provider and model, version 3 added reasoning effort, persona,
 * and the tool filter. Every member those generations carry is a member of the
 * current schema, so upgrading them fabricates nothing.
 */
const OLDEST_RELEASED_DESCRIPTOR_VERSION = 2

/** Members every released descriptor payload carries. */
const DESCRIPTOR_REQUIRED_MEMBERS = ['version', 'mode', 'provider'] as const

/** Members only a continuable descriptor carries, beside `label`. */
const CONTINUABLE_DESCRIPTOR_MEMBERS = [
  'agentProvider',
  'agentModel',
  'agentReasoningEffort',
  'persona',
  'toolFilter',
  'cwd',
  'skillFilter',
] as const

/**
 * Members a released descriptor may carry beyond {@link DESCRIPTOR_REQUIRED_MEMBERS}:
 * the union of the released generations' optional members, which is the frozen
 * member inventory this edge admits.
 */
export const RELEASED_SUBAGENT_DESCRIPTOR_OPTIONAL_MEMBERS: readonly string[] = Object.freeze([
  'label',
  ...CONTINUABLE_DESCRIPTOR_MEMBERS,
])

/** Members the current schema declares for one descriptor mode. */
function currentSchemaMembers(mode: SessionFormatJsonValue | undefined): readonly string[] | undefined {
  if (mode === 'one-shot') return [...DESCRIPTOR_REQUIRED_MEMBERS, 'label']
  if (mode === 'continuable') {
    return [...DESCRIPTOR_REQUIRED_MEMBERS, ...RELEASED_SUBAGENT_DESCRIPTOR_OPTIONAL_MEMBERS]
  }
  return undefined
}

/**
 * Refuse a payload carrying a member the current schema does not declare, which
 * is a descriptor the installed fold rejects.
 * @param data - detached descriptor payload.
 * @param label - diagnostic subject.
 * @throws {SessionFormatUnsupportedMigrationError} on an undeclared member.
 */
function assertCurrentSchemaMembers(data: Record<string, SessionFormatJsonValue>, label: string): void {
  const members = currentSchemaMembers(data['mode'])
  // An unrecognized mode is a payload defect the frozen payload rules report.
  if (members === undefined) return
  const unknown = Object.keys(data).find(key => !members.includes(key))
  if (unknown !== undefined) {
    throw new SessionFormatUnsupportedMigrationError(
      `${label} descriptor carries member ${JSON.stringify(unknown)}, which the installed schema does not declare`,
    )
  }
}

/**
 * Bring one released-v0 `subagent/descriptor` payload to the installed schema.
 * Any other event passes through. The installed version passes through
 * unchanged. A released older generation whose members the current schema
 * declares is stamped with the installed version, keeping every carried member
 * and adding none: it predates the composition inputs the newer generation
 * introduced, so the contained Session migrates instead of staying unwritable.
 * @param event - one decoded released-v0 event.
 * @returns the event, with the installed version stamped when it was a
 *   descriptor carrying a released older one.
 * @throws {SessionFormatUnsupportedMigrationError} when the payload declares a
 *   member the installed schema does not, a version newer than the installed
 *   one, or a version below the released generations.
 */
export function upgradeReleasedSubagentDescriptor(event: SessionFormatEvent): SessionFormatEvent {
  if (event.type !== 'subagent/descriptor') return event
  const label = `${event.type} ${event.seq}`
  const data = releasedV0Record(event.data, `${label} data`)
  const version = sessionFormatCount(data['version'], `${label} version`)
  assertCurrentSchemaMembers(data, label)
  if (version === CURRENT_SUBAGENT_DESCRIPTOR_VERSION) return event
  if (version > CURRENT_SUBAGENT_DESCRIPTOR_VERSION) {
    throw new SessionFormatUnsupportedMigrationError(
      `${label} uses descriptor version ${version}, newer than the installed ${CURRENT_SUBAGENT_DESCRIPTOR_VERSION}`,
    )
  }
  if (version < OLDEST_RELEASED_DESCRIPTOR_VERSION) {
    throw new SessionFormatUnsupportedMigrationError(
      `${label} uses unreleased descriptor version ${version}`,
    )
  }
  return { ...event, data: { ...data, version: CURRENT_SUBAGENT_DESCRIPTOR_VERSION } }
}
