// @vitest-environment jsdom
/**
 * Boot-wire trusted-authority field: the wire keeps the host-published list
 * of non-loopback serving authorities, old HTML (no field) defaults to an
 * empty list, and a malformed field fails loudly.
 */
import { describe, expect, it } from 'vitest'
import { parseBootManifest } from '../src/client/index.ts'

const WIRE = {
  rev: 'graph',
  entries: [{ id: 'a', url: '/plugins/a/client.js', rev: '1' }],
}

describe('boot manifest trustedAuthorities', () => {
  it('keeps the host-published trustedAuthorities string array from the wire', () => {
    const manifest = parseBootManifest({
      ...WIRE,
      trustedAuthorities: ['app.internal', '192.168.4.7'],
    })
    expect(manifest.trustedAuthorities).toEqual(['app.internal', '192.168.4.7'])
  })

  it('defaults an absent trustedAuthorities field to an empty list (old HTML)', () => {
    expect(parseBootManifest(WIRE).trustedAuthorities).toEqual([])
  })

  it('rejects a non-array trustedAuthorities field', () => {
    expect(() => parseBootManifest({ ...WIRE, trustedAuthorities: 'app.internal' }))
      .toThrow('client-modules: boot manifest trustedAuthorities must be an array of strings')
  })

  it('rejects a trustedAuthorities entry that is not a string', () => {
    expect(() => parseBootManifest({ ...WIRE, trustedAuthorities: ['app.internal', 443] }))
      .toThrow('client-modules: boot manifest trustedAuthorities must be an array of strings')
  })
})
