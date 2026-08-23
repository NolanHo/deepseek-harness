/**
 * Client-side page-authority trust: the connection handle reports whether the
 * page authority is one this deployment serves at — loopback, or listed in
 * the host-published boot wire (`modules.manifest.trustedAuthorities`).
 * Entry semantics mirror the host fence: a port-less entry matches the
 * hostname on any port; a `host:port` entry matches that exact authority.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, type ConnectionHandle } from '../src/client/index.ts'

type Win = { location?: { hostname: string; port: string; search: string; origin?: string } }

afterEach(() => {
  delete (globalThis as Win).location
})

/** The modules-service face the connection client reads: the parsed boot manifest. */
function modulesWith(trustedAuthorities: readonly string[]): { manifest: { trustedAuthorities: string[] } } {
  return { manifest: { trustedAuthorities: [...trustedAuthorities] } }
}

async function mount(modules?: { manifest: { trustedAuthorities: string[] } }): Promise<ConnectionHandle> {
  const ctx = new Context()
  if (modules !== undefined) ctx.provide('modules', modules as never)
  await ctx.plugin({ apply, inject: [] })
  const handle = ctx.get('connection') as ConnectionHandle | undefined
  if (handle === undefined) throw new Error('ctx.connection not provided')
  return handle
}

describe('connection client page-authority trust', () => {
  it('trusts a page authority listed port-less in the boot wire on any port', async () => {
    ;(globalThis as Win).location = { hostname: '192.168.4.7', port: '8080', search: '', origin: 'http://192.168.4.7:8080' }
    expect((await mount(modulesWith(['app.internal', '192.168.4.7']))).isServingAuthority).toBe(true)
  })

  it('trusts a default-port page authority matching a port-less wire entry', async () => {
    ;(globalThis as Win).location = { hostname: 'app.internal', port: '', search: '', origin: 'https://app.internal' }
    expect((await mount(modulesWith(['app.internal']))).isServingAuthority).toBe(true)
  })

  it('trusts a page authority matching a host:port wire entry exactly', async () => {
    ;(globalThis as Win).location = { hostname: 'app.internal', port: '443', search: '', origin: 'https://app.internal:443' }
    expect((await mount(modulesWith(['app.internal:443']))).isServingAuthority).toBe(true)
  })

  it('refuses a page port that differs from an exact host:port wire entry', async () => {
    ;(globalThis as Win).location = { hostname: 'app.internal', port: '8443', search: '', origin: 'https://app.internal:8443' }
    expect((await mount(modulesWith(['app.internal:443']))).isServingAuthority).toBe(false)
  })

  it('refuses a page authority absent from the wire list', async () => {
    ;(globalThis as Win).location = { hostname: 'other.example', port: '', search: '', origin: 'https://other.example' }
    expect((await mount(modulesWith(['app.internal']))).isServingAuthority).toBe(false)
  })

  it('trusts a loopback page authority even with an empty wire list', async () => {
    ;(globalThis as Win).location = { hostname: '127.0.0.1', port: '5173', search: '', origin: 'http://127.0.0.1:5173' }
    expect((await mount(modulesWith([]))).isServingAuthority).toBe(true)
  })

  it('refuses a non-loopback page authority when no modules service is provided', async () => {
    ;(globalThis as Win).location = { hostname: '192.0.2.20', port: '', search: '', origin: 'https://192.0.2.20' }
    expect((await mount()).isServingAuthority).toBe(false)
  })
})
