/** Browser Tool plugin: whole-call composition and keyed atomic Tool views. */
export { apply, inject } from './apply.ts'
export { GenericToolCard } from './tool/toolviews/GenericToolCard.tsx'
export type { GenericToolCardProps } from './tool/toolviews/GenericToolCard.tsx'
export type {
  ToolCallOwnerProps, ToolCallViewProps, ToolHostInfoInjected, ToolTreeProps,
} from './contract/slots.ts'
