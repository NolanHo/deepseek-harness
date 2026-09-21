/**
 * Test-side decoding of stored data columns, so a spec can state the decoded
 * JSON text size a scan reports without reading it back from the code under
 * test. The dictionary is the packaged schema-20 resource.
 */

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_DICTIONARY = readFileSync(new URL('../resources/zstd-dictionary.bin', import.meta.url))

/**
 * Decode one physical data column exactly as the physical codec does.
 * @param data - stored text, or a dictionary-compressed frame.
 * @returns the decoded UTF-8 text.
 */
export function decodedColumnText(data: string | Uint8Array): string {
  return typeof data === 'string'
    ? data
    : zstdDecompressSync(data, { dictionary: ZSTD_DICTIONARY }).toString('utf8')
}
