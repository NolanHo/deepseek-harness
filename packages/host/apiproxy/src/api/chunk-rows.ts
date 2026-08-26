/**
 * The wire chunk codec: the storage layer's lossless delta-run packing,
 * re-exported here so browser packages import one wire surface
 * (`@deepseek-ai/dsh-host-apiproxy/api`) instead of reaching into the
 * session store's module graph (whose main entry declares the host-only
 * `sessions` service — the Client program must never load it).
 */
export { decodeStorageRecord } from '@deepseek-ai/dsh-session/chunk-rows'
export type { ChunkRow } from '@deepseek-ai/dsh-session/chunk-rows'
