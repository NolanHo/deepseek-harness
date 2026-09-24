// Fork-owned released-descriptor identity compatibility (see FORK_SURFACE.md).
// The installed descriptor generation is 4 — the fork stamps it for the
// per-child `cwd` and `skillFilter` composition inputs — while a restored log
// written by an earlier generation carries 2 or 3. The strict fold reads only
// the installed version, so such a child had no identity and the Session
// controller's address fence reported its descriptor corrupt, even though the
// parent's own catalog and this deployment's `listChildren` read the same
// child's mode and label. Identity is the (mode, label, declaration seq) triple
// every mode-bearing generation carries with the installed meaning; the resume
// composition is not, which is why only this identity read is extended and
// `foldSubagentDescriptor` stays strict.

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SUBAGENT_DESCRIPTOR_VERSION, foldSubagentDescriptor } from '../descriptor.ts'
import type { SubagentDescriptorData } from '../descriptor.ts'

/**
 * Oldest descriptor generation whose payload declares an explicit mode with the
 * installed meaning: version 2 recorded the resolved child provider and model,
 * and version 3 added reasoning effort, persona, and the tool filter; neither
 * changed the identity members. Version 1 predates the mode field, so reading an
 * identity from it would assert a mode its payload does not declare.
 */
const OLDEST_MODE_BEARING_DESCRIPTOR_VERSION = 2

/**
 * Fold a released descriptor payload to the descriptor the installed schema
 * reads, by validating a copy stamped with the installed version. Every member
 * the installed schema declares survives that copy, and a payload carrying one
 * it does not declare — or a damaged identity field — is refused here exactly
 * as the strict fold refuses it.
 * @param event - one session event; a non-descriptor type yields no descriptor.
 * @returns the descriptor the installed fold reads from the released payload, or
 *   `undefined` without one.
 */
export function foldReleasedDescriptorIdentity(event: SessionEvent): SubagentDescriptorData | undefined {
  if (event.type !== 'subagent/descriptor') return undefined
  const version = event.data.version
  if (!Number.isSafeInteger(version)
    || version >= SUBAGENT_DESCRIPTOR_VERSION
    || version < OLDEST_MODE_BEARING_DESCRIPTOR_VERSION) {
    return undefined
  }
  try {
    return foldSubagentDescriptor([{ ...event, data: { ...event.data, version: SUBAGENT_DESCRIPTOR_VERSION } }])
  } catch {
    // The installed schema refuses this payload's members or identity fields, so
    // it establishes no identity — the same absent value damage folds to.
    return undefined
  }
}
