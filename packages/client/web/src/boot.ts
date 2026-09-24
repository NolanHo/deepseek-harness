/**
 * Web boot kernel. It owns only the module system, Cordis loader, and a
 * framework-free boot page; plugin composition and the renderer handoff are
 * `bootClient` and `mountClient`. The dynamic UI renderer receives the mount
 * point after every client entry activates.
 * @module @deepseek-ai/dsh-client-web/src/boot
 */
import { Context } from '@deepseek-ai/cordis'
import type {
  BootManifest, BootPluginRow, ClientModuleCreateOptions, ClientModuleSystem, DshWindow,
} from '@deepseek-ai/dsh-client-modules/client'
import { assertEntriesActive, bootClient } from './boot-client.ts'
import { BootPage } from './boot-page.ts'
import { mountClient } from './mount.ts'
// Fork patch (FORK_SURFACE.md): the deployment's reduced-motion opt-in and
// theme palette are applied to the document root before any entry activates.
import { applyReduceMotion } from './fork/reduce-motion.ts'
import { applyTheme } from './fork/deployment-theme.ts'
import { getStaticModules } from './seed.ts'
import './base.css'
import './fork/themes.css'

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
    applyReduceMotion(document.documentElement, globalThis.location.search)
    applyTheme(document.documentElement, globalThis.location.search)
    this.page = new BootPage(container)
  }

  /**
   * Load and activate every pre-mount client entry, hand the mount point to the
   * UI renderer, then create deferred entries in the background. Plugin
   * failures before the mount remain visible on the boot page.
   * @param onFailure - Optional carrier-owned fatal presentation; keeps the boot page visible.
   * @returns Resolves after application mount or failure reporting.
   */
  async run(onFailure?: (reason: unknown) => void): Promise<void> {
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
      // Fork patch (FORK_SURFACE.md): a deferred row is not part of the roster
      // this boot creates, so its batch bytes stay off the first-paint path.
      const preMount = this.manifest.plugins.filter(row => !row.deferred)
      this.page.setTotal(preMount.length)
      await prefetching
      await bootClient({
        ctx,
        modules: this.modules,
        manifest: { ...this.manifest, plugins: preMount },
        onEntryState: (name, state) => {
          if (onFailure === undefined || state !== 'failed') this.page.setState(name, state)
        },
      })
      await mountClient(ctx, this.container)
      // The application is up: fetch and create the deferred batches whose
      // bytes stayed off the first-paint critical path. Their UI arrives as
      // the slots they fill register; a failure lands in the console (the
      // boot page is gone).
      void this.activateDeferred(ctx, this.manifest.plugins.filter(row => row.deferred))
    } catch (reason) {
      console.error(reason)
      if (onFailure !== undefined) onFailure(reason)
      else this.page.fail(reason instanceof Error ? reason.message : String(reason))
    }
  }

  /** Dispose the client plugin tree and whichever page owns the mount point. */
  async dispose(): Promise<void> {
    const ctx = this.ctx
    this.ctx = undefined
    if (ctx !== undefined) await ctx.fiber.dispose()
    this.page.dispose()
  }

  /** Prefetch stage-one bundles and their dynamic requests before concurrent plugin imports. */
  private async prefetchImmediateTier(): Promise<void> {
    await Promise.all(this.manifest.plugins
      .filter(row => row.immediately)
      .map(row => this.modules.prefetch(row.id).catch((_prefetchError: unknown) => {
        // Prefetch only starts transport early; the Loader import retries and reports this bundle failure.
      })))
  }

  // Fork patch (FORK_SURFACE.md): the deferred batches are created here,
  // after the application is up, so their bytes stay off the first-paint path.
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
      // Every pre-mount entry was audited before the mount, so a failure here
      // belongs to a deferred batch.
      assertEntriesActive(ctx, this.modules)
    } catch (reason) {
      console.error(reason instanceof Error ? reason.message : String(reason))
    }
  }
}
