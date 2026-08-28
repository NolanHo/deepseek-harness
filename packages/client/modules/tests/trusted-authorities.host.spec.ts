/** Node-half trusted-authority composition: the served graph carries the
 * published list, the rev covers it, publication recomposes the graph and
 * notifies listeners once per change, and the injected HTML carries the
 * settled list in the boot wire. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderIndexInjections, type WebServer } from '@deepseek-ai/dsh-host-webserver'
import { ClientModuleRegistry, bootInjections } from '../src/index.ts'

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

/** Create one resolvable, built client package for the activation scan. */
function writeBuiltPackage(packageName: string): void {
  root ??= realpathSync(mkdtempSync(join(tmpdir(), 'dsh-client-modules-')))
  const pkgRoot = join(root, 'node_modules', ...packageName.split('/'))
  const clientPath = join(pkgRoot, 'lib', 'client.js')
  mkdirSync(dirname(clientPath), { recursive: true })
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({
    name: packageName,
    exports: {
      './client': './lib/client.js',
      './package.json': './package.json',
    },
    dsh: { client: { platform: 'web' } },
  }))
  writeFileSync(clientPath, 'module.exports = {}\n')
}

/** Construct the node-half service over one built fixture entry. */
function construct(packageName: string): ClientModuleRegistry {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root!).href + '/'
  ctx.provide('loader', {
    *entries() {
      yield {
        options: { name: packageName },
        fiber: {},
        disabled: false,
        parent: { tree: { ctx: { baseUrl: ctx.baseUrl } } },
      }
    },
  })
  const webServer: Pick<WebServer, 'port' | 'register' | 'tapIndex'> = {
    port: 0,
    register: () => () => {},
    tapIndex: () => () => {},
  }
  ctx.provide('webServer', webServer as WebServer)
  return new ClientModuleRegistry(ctx)
}

describe('trusted-authority composition', () => {
  it('composes the trustedAuthorities field into the served graph', () => {
    writeBuiltPackage('@fixture/trusted-authorities')
    expect(construct('@fixture/trusted-authorities').graph().trustedAuthorities).toEqual([])
  })

  it('recomposes the graph rev when only the authority list changes', () => {
    writeBuiltPackage('@fixture/trusted-authorities-rev')
    const service = construct('@fixture/trusted-authorities-rev')
    const before = service.graph()
    service.publishTrustedAuthorities(['app.internal'])
    const after = service.graph()
    expect(after.trustedAuthorities).toEqual(['app.internal'])
    expect(after.entries).toEqual(before.entries)
    expect(after.rev).not.toBe(before.rev)
  })

  it('fires graph-changed listeners exactly once per changed publication, not on same-value', () => {
    writeBuiltPackage('@fixture/trusted-authorities-notify')
    const service = construct('@fixture/trusted-authorities-notify')
    const listener = vi.fn()
    const off = service.onGraphChanged(listener)

    service.publishTrustedAuthorities(['app.internal'])
    expect(listener).toHaveBeenCalledTimes(1)
    service.publishTrustedAuthorities(['app.internal'])
    expect(listener).toHaveBeenCalledTimes(1)
    service.publishTrustedAuthorities(['app.internal', '192.168.4.7'])
    expect(listener).toHaveBeenCalledTimes(2)
    service.publishTrustedAuthorities([])
    expect(listener).toHaveBeenCalledTimes(3)

    off()
    service.publishTrustedAuthorities(['other.internal'])
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('takes a fresh copy of the published list', () => {
    writeBuiltPackage('@fixture/trusted-authorities-copy')
    const service = construct('@fixture/trusted-authorities-copy')
    const input = ['app.internal']
    service.publishTrustedAuthorities(input)
    input.push('late.internal')
    expect(service.graph().trustedAuthorities).toEqual(['app.internal'])
  })

  it('renders the settled list into the injected boot graph global', () => {
    writeBuiltPackage('@fixture/trusted-authorities-html')
    const service = construct('@fixture/trusted-authorities-html')
    service.publishTrustedAuthorities(['app.internal'])
    const html = renderIndexInjections(
      '<html><head></head><body></body></html>',
      bootInjections(service.graph()),
    )
    expect(html).toContain('"trustedAuthorities":["app.internal"]')
  })
})
