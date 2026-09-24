/** Tool-role V3-to-V4 migration with native V4 framing and delivery validation. */

export { releasedV3SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v2-to-v3'
export * from './codec.ts'
export * from './migration.ts'
export { assertReleasedV4Header, assertReleasedV4Relationships, restoreReleasedV4Artifact } from './validation.ts'
// Fork patch (FORK_SURFACE.md): a database-backed parent collects child evidence
// itself, so it validates one child's fact with the edge's own interpreter
// instead of refusing the whole parent over that child's unusable descriptor.
export { childCatalogFact, historicalChildCatalogSource } from './facts.ts'
export { RELEASED_V3_EVENT_TYPES } from './extension-identities.ts'
