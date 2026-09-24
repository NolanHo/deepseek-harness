/** Browser Tool plugin: whole-call composition and keyed atomic Tool views. */
export { apply, inject } from './apply.ts'
// Fork patch (FORK_SURFACE.md): `GenericToolCard` + its props type are the marked
// value exports the out-of-tree `dsh-apollo` toolview consumes (export-discipline exception).
export { GenericToolCard } from './tool/toolviews/GenericToolCard.tsx'
export type { GenericToolCardProps } from './tool/toolviews/GenericToolCard.tsx'
export type {
  StartedToolCallViewProps, ToolCallCommonProps, ToolCallOwnerProps, ToolCallPhaseProps, ToolCallViewProps,
  ToolCallHookContext, ToolCallInjected, ToolHostInfoInjected, ToolTreeProps, UseToolCallArgumentsPartial,
} from './contract/slots.ts'
