// A non-serving page authority keeps the settings plane process-local: the
// notice advances for this browser process only and returns on reload. The
// page loads through a Host-rewriting reverse proxy — the documented
// loopback-rewrite deployment pattern — so the page authority is
// remote.localhost while every request (API and WebSocket) reaches the
// scaffold with a loopback Host and passes the browser-trust fence.
import type { Server } from 'node:http'
import { createServer, request as httpRequest } from 'node:http'
import { AddressInfo } from 'node:net'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, launchWebScaffold, watchConsole, webSnapshotMode,
  WELCOME_NOTICE_COPY,
  type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

const MODE = webSnapshotMode()

/**
 * Terminate HTTP and WebSocket traffic at one port and re-originate it against
 * the loopback scaffold origin with a rewritten Host header.
 * @param targetPort - the scaffold's loopback port.
 * @returns the listening proxy server.
 */
function startHostRewriteProxy(targetPort: number): Promise<Server> {
  const forwardHeaders = (headers: Record<string, string | string[] | undefined>) => ({
    ...headers,
    host: `127.0.0.1:${String(targetPort)}`,
    // The documented pattern rewrites Origin beside Host, keeping the
    // request same-origin from the fence's point of view.
    origin: `http://127.0.0.1:${String(targetPort)}`,
  })
  const server = createServer((req, res) => {
    const upstream = httpRequest({
      hostname: '127.0.0.1',
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req.headers),
    }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
    })
    upstream.on('error', () => { res.writeHead(502); res.end('proxy upstream failure') })
    req.pipe(upstream)
  })
  server.on('upgrade', (req, socket, head) => {
    const upstream = httpRequest({
      hostname: '127.0.0.1',
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req.headers),
    })
    upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      const headerLines = Object.entries(response.headers)
        .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value ?? ''}`)
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headerLines.join('\r\n')}\r\n\r\n`)
      if (upstreamHead.length > 0) socket.write(upstreamHead)
      if (head.length > 0) upstreamSocket.write(head)
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
      const kill = (): void => { socket.destroy(); upstreamSocket.destroy() }
      socket.on('error', kill)
      upstreamSocket.on('error', kill)
    })
    upstream.on('error', () => socket.destroy())
    upstream.end()
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

describe.skipIf(MODE === 'record')('web e2e: remote welcome notice', () => {
  let scaffold: WebScaffold
  let proxy: Server
  let proxyPort: number
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    // Loopback scaffold with an empty trustedHosts list: remote.localhost is
    // not a declared serving authority, so the proxied page keeps the
    // process-local settings mirror.
    scaffold = await launchWebScaffold({ welcomeNoticePending: true })
    proxy = await startHostRewriteProxy(Number(new URL(scaffold.baseUrl).port))
    proxyPort = (proxy.address() as AddressInfo).port
    browser = await chromium.launch()
    page = await browser.newPage({
      viewport: { width: 1440, height: 960 },
      locale: ZH_BROWSER_LOCALE,
    })
    tripwire = watchConsole(page)
    await page.goto(`http://remote.localhost:${String(proxyPort)}/`, { waitUntil: 'load' })
    await page.waitForSelector('#root', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await new Promise<void>(resolve => proxy.close(() => resolve()))
      .catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'remote welcome e2e cleanup failed')
  })

  it('advances process-locally and presents the notice again after reload', async () => {
    const welcome = page.getByRole('dialog', { name: WELCOME_NOTICE_COPY.zh.title })
    await welcome.waitFor({ timeout: 15_000 })
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(true)

    await welcome.getByRole('button', { name: WELCOME_NOTICE_COPY.zh.continueLabel }).click()
    await welcome.waitFor({ state: 'detached', timeout: 15_000 })
    await expect.poll(
      () => page.locator('#root').evaluate(root => (root as HTMLElement).inert),
      { timeout: 15_000 },
    ).toBe(false)

    const reloadWarnings = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, reloadWarnings)
    await welcome.waitFor({ timeout: 15_000 })
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
