/**
 * Web boot kernel. It owns only the module system, Cordis loader, and a
 * framework-free boot page. The dynamic UI renderer receives the mount
 * point after every client entry activates.
 * @module @deepseek-ai/dsh-client-web/src/boot
 */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type {
  BootManifest, BootPluginRow, ClientModuleCreateOptions, ClientModuleSystem, DshWindow,
} from '@deepseek-ai/dsh-client-modules/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { BootPage } from './boot-page.ts'
import { getStaticModules } from './seed.ts'
import { STATE_LABELS } from './loader-status.ts'
import './base.css'

/** Module transport hook replaced by jsdom tests. */
export type BootSeams = Pick<ClientModuleCreateOptions, 'loadBundle'>

/** Browser boot entry consumed by `apps/web`. */
export class AppWebEntry {
  private readonly container: HTMLElement
  private readonly seams: BootSeams | undefined
  private readonly page: BootPage
  private ctx: Context | undefined
  private modules!: ClientModuleSystem
  private manifest!: BootManifest

  /**
   * Draw the boot page; {@link run} starts the loader.
   * @param container - Application mount point.
   * @param seams - Optional module transport replacement.
   */
  constructor(container: HTMLElement, seams?: BootSeams) {
    this.container = container
    this.seams = seams
    this.page = new BootPage(container)
  }

  /**
   * Load and activate every pre-mount client entry, hand the mount point to the
   * UI renderer, then create deferred entries in the background. Plugin
   * failures before the mount remain visible on the boot page.
   * @returns Resolves after application mount or failure rendering.
   */
  async run(): Promise<void> {
    try {
      // Boot-readiness gate: whichever bootstrap applies the injection table
      // settles this deferred once every row has taken effect — the served
      // index resolves it in the rendered tail, so the await returns on the
      // next microtask; an asynchronous bootstrap resolves it after its last
      // row, or rejects it into the failure rendering below. An absent global
      // means no bootstrap owns the document and there is nothing to wait for.
      await (globalThis as { __DSH_BOOT_READY__?: { promise: Promise<void> } }).__DSH_BOOT_READY__?.promise
      const win = globalThis as DshWindow
      const moduleLoader = win.__ModuleLoader__
      if (moduleLoader === undefined) {
        throw new Error('web boot: window.__ModuleLoader__ bootstrap facade is missing')
      }
      // A pre-injected transport (the worker preview page) owns bundle bytes;
      // its loadBundle is the default and explicit seams still win. The global
      // is `ClientTransportHooks`, owned by @deepseek-ai/dsh-client-connection;
      // this structural slice reads one optional member without adding a
      // package edge.
      const transport = (globalThis as {
        __DSH_TRANSPORT__?: { loadBundle?: ClientModuleCreateOptions['loadBundle'] }
      }).__DSH_TRANSPORT__
      this.modules = moduleLoader.create({
        boot: win.__DSH_BOOT__,
        staticModules: getStaticModules(),
        ...transport?.loadBundle === undefined ? {} : { loadBundle: transport.loadBundle },
        ...this.seams,
      })
      this.manifest = this.modules.manifest

      const prefetching = this.prefetchImmediateTier()
      const ctx = new Context()
      this.ctx = ctx
      await this.runPluginBoot(ctx, prefetching)
      await this.mountApp(ctx)
      // The application is up: fetch and create the deferred batches whose
      // bytes stayed off the first-paint critical path. Their UI arrives as
      // the slots they fill register; a failure lands in the console (the
      // boot page is gone).
      void this.activateDeferred(ctx, this.manifest.plugins.filter(row => row.deferred))
    } catch (reason) {
      console.error(reason)
      this.page.fail(reason instanceof Error ? reason.message : String(reason))
    }
  }

  /** Dispose the client plugin tree and whichever page owns the mount point. */
  async dispose(): Promise<void> {
    const ctx = this.ctx
    this.ctx = undefined
    if (ctx !== undefined) await ctx.fiber.dispose()
    this.page.dispose()
  }

  /** Mount through a dependency fiber so replacing uiRenderer remounts the application. */
  private async mountApp(ctx: Context): Promise<void> {
    const mounted = ctx.inject(['uiRenderer'], (scope) => {
      scope.effect(() => scope.uiRenderer.mount(this.container), 'web boot: application mount')
    })
    await mounted
  }

  /** Prefetch stage-one bundles and their dynamic requests before concurrent plugin imports. */
  private async prefetchImmediateTier(): Promise<void> {
    await Promise.all(this.manifest.plugins
      .filter(row => row.immediately)
      .map(row => this.modules.prefetch(row.id).catch((_prefetchError: unknown) => {
        // Prefetch only starts transport early; the Loader import retries and reports this bundle failure.
      })))
  }

  /** Mount the Loader, create pre-mount graph entries, await quiescence, and audit activation. */
  private async runPluginBoot(ctx: Context, prefetching: Promise<void>): Promise<void> {
    await ctx.plugin(Loader)
    const loader = ctx.loader
    loader.internal = this.modules as never

    ctx.on('internal/status', (fiber) => {
      const entry = fiber.entry
      if (entry === undefined || entry.fiber === undefined) return
      this.page.setState(entry.options.name, STATE_LABELS[entry.fiber.state])
    })

    const preMount = this.manifest.plugins.filter(row => !row.deferred)
    this.page.setTotal(preMount.length)
    await prefetching
    await Promise.all(preMount.map(async (row) => {
      this.page.setState(row.id, 'loading')
      const id = await loader.create({ name: row.id })
      if (loader.resolve(id).fiber === undefined) this.page.setState(row.id, 'failed')
    }))

    await loader.await()
    this.assertEntriesActive(ctx, new Set(preMount.map(row => row.id)))
  }

  /** Fetch and create deferred entries after mount, then audit them in the background. */
  private async activateDeferred(ctx: Context, rows: BootPluginRow[]): Promise<void> {
    try {
      const loader = ctx.loader
      await Promise.all(rows.map(async (row) => {
        const id = await loader.create({ name: row.id })
        if (loader.resolve(id).fiber === undefined) {
          console.error(`web boot: deferred entry ${row.id} did not import (see console for the import error)`)
        }
      }))
      await loader.await()
      this.assertEntriesActive(ctx, new Set(rows.map(row => row.id)))
    } catch (reason) {
      console.error(reason instanceof Error ? reason.message : String(reason))
    }
  }

  /** Reject entries that failed import/apply or still wait on missing services. */
  private assertEntriesActive(ctx: Context, expected: ReadonlySet<string>): void {
    const failures: string[] = []
    for (const entry of ctx.loader.entries()) {
      if (!expected.has(entry.options.name)) continue
      const name = entry.options.name
      if (entry.fiber === undefined) {
        failures.push(`${name}: import failed (see console for the import error)`)
        continue
      }
      const state = STATE_LABELS[entry.fiber.state]
      if (state === 'active') continue
      if (state === 'pending') {
        const missing = Object.keys(entry.fiber.inject).filter(service => ctx.get(service) === undefined)
        failures.push(`${name}: pending (waiting for service${missing.length === 1 ? '' : 's'}: ${missing.join(', ') || 'unknown'})`)
      } else {
        failures.push(`${name}: ${state}`)
      }
    }
    if (failures.length > 0) {
      throw new Error(`web boot: ${String(failures.length)} entr${failures.length === 1 ? 'y' : 'ies'} did not activate\n${failures.join('\n')}`)
    }
  }
}
