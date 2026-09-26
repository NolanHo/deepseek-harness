// Browser geometry contracts for a long Chat transcript. These scenarios are
// deliberately virtualizer-neutral: they assert semantic-row position,
// bottom ownership, interaction state, and the real outer scroll host rather
// than DOM cardinality or implementation-specific spacer markup.
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { ReplayEntry, ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createChatScrollFixture, type ChatScrollFixture } from './chat-scroll-fixture.ts'
import {
  countHistoryPages,
  expandAllTurnFolds,
  launchWebScaffold,
  loadEarlierStep,
  parseSeedFixture,
  seedSession,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { expandOwningTurnProcess, newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
/**
 * Resident order keys the fork's mounted transcript window holds. Mirrors
 * `MOUNTED_ROW_LIMIT` in
 * `packages/client/ui-chat/src/client/chat/fork/mounted-window.ts`: this lane is
 * a host-plane program and must not reach client source (the same rule that
 * restates `conversationContextKey` in support.ts), so the cap is mirrored.
 */
const MOUNTED_ROW_LIMIT = 50
/**
 * Resident key rows a frozen window may hold beside the live tail stub the same
 * planner mounts while a Turn streams above it.
 */
const MOUNTED_ROW_CEILING = MOUNTED_ROW_LIMIT * 2
const HISTORY_SESSION_ID = 'chat-scroll-history-e2e'
const TOOL_SESSION_ID = 'chat-scroll-tool-e2e'
const RESTORE_SESSION_A_ID = 'chat-scroll-restore-a-e2e'
const RESTORE_SESSION_B_ID = 'chat-scroll-restore-b-e2e'
const REPLAY_CONTEXT_WINDOW = 10_000_000
const STREAM_PACE_MS = 24
const GEOMETRY_TOLERANCE = 2
const RESPONSIVE_REFLOW_TOLERANCE = 32
const LIVE_TEXT_PROMPT = 'CHAT_SCROLL_LIVE_USER Continue this long conversation while I inspect older history.'
const LIVE_TEXT_FIRST = 'CHAT_SCROLL_LIVE_FIRST'
const LIVE_TEXT_DONE = 'CHAT_SCROLL_LIVE_DONE'
const LIVE_TOOL_PROMPT = 'CHAT_SCROLL_TOOL_USER Run the requested diagnostic and then summarize it.'
const LIVE_TOOL_CALL_ID = ToolCallId('chat-scroll-live-tool-call')
const LIVE_TOOL_RESULT = 'CHAT_SCROLL_LIVE_TOOL_RESULT'
const LIVE_TOOL_FIRST = 'CHAT_SCROLL_TOOL_STREAM_FIRST'
const LIVE_TOOL_DONE = 'CHAT_SCROLL_TOOL_STREAM_DONE'
const TOOL_READY_FILE = '.chat-scroll-tool-ready'
const TOOL_RELEASE_FILE = '.chat-scroll-tool-release'
const INPUTS_SESSION_ID = 'chat-scroll-inputs-e2e'
const RAIL_SESSION_ID = 'chat-scroll-rail-e2e'
const FLING_SESSION_ID = 'chat-scroll-fling-e2e'
const LIVE_FLING_PROMPT = 'CHAT_SCROLL_FLING_USER Keep streaming while I fling back through older output.'
const LIVE_FLING_FIRST = 'CHAT_SCROLL_FLING_STREAM_FIRST'
const LIVE_FLING_DONE = 'CHAT_SCROLL_FLING_STREAM_DONE'

const HISTORY_FIXTURE = createChatScrollFixture({
  markerPrefix: 'HISTORY',
  title: 'CHAT_SCROLL_HISTORY long paging session',
})
const TOOL_FIXTURE = createChatScrollFixture({
  markerPrefix: 'TOOL',
  title: 'CHAT_SCROLL_TOOL live tool session',
})
const RESTORE_FIXTURE_A = createChatScrollFixture({
  markerPrefix: 'RESTORE_A',
  title: 'CHAT_SCROLL_RESTORE_A long session',
})
const RESTORE_FIXTURE_B = createChatScrollFixture({
  markerPrefix: 'RESTORE_B',
  title: 'CHAT_SCROLL_RESTORE_B comparison session',
  turns: 32,
})
const INPUTS_FIXTURE = createChatScrollFixture({
  markerPrefix: 'INPUTS',
  title: 'CHAT_SCROLL_INPUTS non-wheel reader input session',
})

interface ScrollGeometry {
  readonly distanceFromBottom: number
  readonly scrollTop: number
}

interface FlowAnchor {
  readonly key: string
  readonly top: number
}

interface ScrollWorld {
  readonly assistantFrames: AssistantStreamFrame[]
  readonly events: SessionEvent[]
  /** Session-history page requests this page issued so far. */
  readonly historyPages: () => number
  readonly page: Page
  readonly replayDir?: string
  readonly scaffold: WebScaffold
  readonly tripwire: ReturnType<typeof watchConsole>
}

interface ScrollWorldOptions {
  readonly failureShot: string
  readonly paceMs?: number
  readonly replay?: ReplayOverrideDoc
  readonly seeds: readonly { fixture: ChatScrollFixture; id: string }[]
}

function textStream(first: string, done: string, deltaCount: number): StreamChunk[] {
  const deltas = Array.from({ length: deltaCount }, (_, index) => {
    if (index === 0) return `${first} `
    if (index === deltaCount - 1) return `${done}.`
    return `stream-chunk-${String(index).padStart(3, '0')} ${'incremental response '.repeat(3)}`
  })
  const response = deltas.join('')
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...deltas.map(text => ({ type: 'text-delta' as const, index: 0, text })),
    { type: 'block-end', index: 0, block: { type: 'text', text: response } },
    {
      type: 'usage',
      usage: { inputTokens: 512, outputTokens: Math.ceil(response.length / 4) },
    },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Hold replay text after the initial deltas until browser setup releases it. */
function holdTextAfter(world: ScrollWorld, initialDeltas: number): () => void {
  const gate = Promise.withResolvers<undefined>()
  const dispose = world.scaffold.ctx.on('llm/stream', async function* (_options, next) {
    let deltas = 0
    for await (const chunk of next()) {
      if (chunk.type === 'text-delta' && deltas++ === initialDeltas) await gate.promise
      yield chunk
    }
  })
  return () => {
    gate.resolve(undefined)
    dispose()
  }
}

function toolStream(): StreamChunk[] {
  const command = [
    `: > ${TOOL_READY_FILE}`,
    `while [ ! -f ${TOOL_RELEASE_FILE} ]; do sleep 0.02; done`,
    'line=1',
    `while [ "$line" -le 64 ]; do printf '${LIVE_TOOL_RESULT} line %02d\\n' "$line"; line=$((line + 1)); done`,
  ].join('; ')
  const args = JSON.stringify({ command, description: LIVE_TOOL_RESULT })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'tool-call-delta',
      index: 0,
      id: LIVE_TOOL_CALL_ID,
      name: 'bash',
      argumentsDelta: args,
    },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: LIVE_TOOL_CALL_ID, name: 'bash', arguments: args },
    },
    { type: 'usage', usage: { inputTokens: 256, outputTokens: 48 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function replayEntry(chunks: StreamChunk[]): ReplayEntry {
  return { kind: 'chunks', chunks }
}

async function launchScrollWorld(options: ScrollWorldOptions): Promise<ScrollWorld> {
  let replayDir: string | undefined
  let scaffold: WebScaffold | undefined
  let page: Page | undefined
  try {
    if (options.replay !== undefined) {
      replayDir = await mkdtemp(join(tmpdir(), 'dsh-chat-scroll-replay-'))
      const replayOverride = join(replayDir, 'replay.override.json')
      await writeFile(replayOverride, JSON.stringify(options.replay))
      scaffold = await launchWebScaffold({
        replayFixture: join(replayDir, 'override-only.jsonl'),
        replayOverride,
        paceMs: options.paceMs ?? STREAM_PACE_MS,
        replayContextWindow: REPLAY_CONTEXT_WINDOW,
      })
    } else {
      scaffold = await launchWebScaffold({})
    }
    for (const seed of options.seeds) await seedSession(scaffold, seed.fixture.log, seed.id)
    const events: SessionEvent[] = []
    const assistantFrames: AssistantStreamFrame[] = []
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { events.push(event) })
    scaffold.ctx.on('agent/assistant-stream', ({ frame }) => { assistantFrames.push(frame) })
    page = await newEnglishPage(browser, 900)
    const historyPages = countHistoryPages(page)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // Session-list bootstrap can replace the controlled search state. Wait
    // for the seeded baseline before openSeed starts the lazy content query
    // (the compact layout dropped group session counts; the Ungrouped bucket
    // row is the barrier).
    await page.getByText('Ungrouped', { exact: true }).waitFor({ timeout: 30_000 })
    return {
      assistantFrames,
      events,
      historyPages,
      page,
      scaffold,
      tripwire,
      ...(replayDir === undefined ? {} : { replayDir }),
    }
  } catch (error) {
    const failures: unknown[] = [error]
    if (page !== undefined) await page.context().close().catch((cleanupError: unknown) => failures.push(cleanupError))
    if (scaffold !== undefined) await scaffold.close().catch((cleanupError: unknown) => failures.push(cleanupError))
    if (replayDir !== undefined) {
      await rm(replayDir, { recursive: true, force: true }).catch((cleanupError: unknown) => failures.push(cleanupError))
    }
    if (failures.length === 1) throw error
    throw new AggregateError(failures, 'chat-scroll browser world setup failed and cleanup was incomplete')
  }
}

async function closeScrollWorld(world: ScrollWorld): Promise<void> {
  const failures: unknown[] = []
  // newEnglishPage/browser.newPage owns an isolated context. Close the whole
  // context so its SSE connection and cache cannot leak into the next world
  // in this file's shared Chromium process.
  await world.page.context().close().catch((error: unknown) => failures.push(error))
  await world.scaffold.close().catch((error: unknown) => failures.push(error))
  if (world.replayDir !== undefined) {
    await rm(world.replayDir, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'chat-scroll browser world cleanup failed')
}

async function withScrollWorld(
  options: ScrollWorldOptions,
  run: (world: ScrollWorld) => Promise<void>,
): Promise<void> {
  const world = await launchScrollWorld(options)
  let runFailure: unknown
  try {
    await run(world)
  } catch (error) {
    runFailure = error
    try {
      await saveFailureShot(world.page, options.failureShot)
    } catch {
      // Best-effort evidence must never prevent cleanup of the owned world.
    }
  }
  let cleanupFailure: unknown
  try {
    await closeScrollWorld(world)
  } catch (error) {
    cleanupFailure = error
  }
  if (runFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError([runFailure, cleanupFailure], 'chat-scroll scenario and cleanup both failed')
  }
  if (runFailure !== undefined) throw runFailure
  if (cleanupFailure !== undefined) throw cleanupFailure
}

async function nextPaint(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>(resolve => requestAnimationFrame(() => {
      requestAnimationFrame(() => { resolve() })
    }))
  })
}

function scrollGeometry(page: Page): Promise<ScrollGeometry> {
  return page.locator('[data-conversation-scroll]').evaluate(host => ({
    distanceFromBottom: host.scrollHeight - host.clientHeight - host.scrollTop,
    scrollTop: host.scrollTop,
  }))
}

/**
 * Resident key rows the mounted transcript window holds. The window's cap counts
 * resident order keys, while `[data-chat-flow-key]` also carries one root row per
 * mounted group, so the group roots are subtracted. The stats strip cannot serve
 * as this probe: its turn/step counts ride the whole-log sessionStats projection
 * and stay fixed across paging by design, while these rows are exactly what the
 * window bounds.
 * @param page - the scenario page.
 * @returns mounted resident key rows, at most MOUNTED_ROW_LIMIT while no Turn streams.
 */
async function mountedKeyRows(page: Page): Promise<number> {
  const [rows, groups] = await Promise.all([
    page.locator('[data-chat-flow-key]').count(),
    page.locator('[data-chat-group-key]').count(),
  ])
  return rows - groups
}

/**
 * Whether the "Load earlier" control is gone for good: no resident row remains
 * above the window and no page is left to request. The control renames itself to
 * its loading label while a page request is in flight, so both labels are read.
 * @param page - the scenario page.
 * @returns whether the transcript head is reached.
 */
async function historyHeadReached(page: Page): Promise<boolean> {
  const controls = page.getByRole('button', { name: /^(?:Load earlier|Loading…)$/ })
  return await controls.count() === 0
}

/** Open the mobile overlay drawer when its floating frame opener is showing. */
async function ensureDrawerOpen(page: Page): Promise<void> {
  const opener = page.getByRole('button', { name: 'Open sidebar', exact: true })
  if (await opener.count() > 0) await opener.click()
}

async function openSeed(
  page: Page,
  fixture: ChatScrollFixture,
  tailMarker?: string,
  options?: { readonly preserveReaderPosition?: boolean },
): Promise<void> {
  // Search collapsed into a header action; expand it before filling.
  const searchButton = page.getByRole('button', { name: 'Search sessions' })
  if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
  const search = page.getByRole('textbox', { name: 'Search session names', exact: true })
  // Cold summaries initially show the temporary workspace basename, so the
  // persisted first-prompt marker is the stable user-facing identity. The
  // query itself triggers lazy content-index reconciliation; no transient
  // empty-state paint is used as a barrier.
  await search.fill(fixture.markers.user(1))
  const results = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
  await expect.poll(() => results.count(), { timeout: 60_000 }).toBe(1)
  // The result row re-renders while lazy history loading reconciles the
  // content index, so a stability-gated click can time out mid-churn; retry
  // briefly instead of waiting out the full default timeout.
  let opened = false
  for (let attempt = 0; attempt < 10 && !opened; attempt += 1) {
    try {
      await results.first().click({ timeout: 2_000 })
      opened = true
    } catch {
      // Row replaced mid-click by index reconciliation; the next attempt
      // resolves the fresh row.
    }
  }
  if (!opened) throw new Error(`search result for ${fixture.markers.user(1)} never stabilized`)
  await page.getByRole('tab', { name: 'Chat', exact: true }).waitFor({ timeout: 30_000 })
  if (tailMarker !== undefined) {
    await page.getByText(tailMarker, { exact: false }).last().waitFor({ timeout: 30_000 })
  }
  // Seeded turns are settled with closing answers, so their intermediate rows
  // render behind folds; these scenarios assert row-level geometry over the
  // full transcript, so expand every fold right after the open. Each header
  // click scrolls the clicked row into view (Playwright auto scroll-into-view),
  // leaving the viewport mid-history; every scenario below starts from the
  // pinned floor, so return there after the expansion. Position-restoration
  // scenarios skip both steps so the remounted view keeps its saved reader
  // spot over the exact layout it was captured on.
  if (options?.preserveReaderPosition !== true) {
    await expandAllTurnFolds(page)
    await page.evaluate(() => {
      const scroller = document.querySelector('[data-conversation-scroll]')
      if (scroller === null || !(scroller instanceof HTMLElement)) throw new Error('conversation scrollport is missing')
      scroller.scrollTop = scroller.scrollHeight
    })
  }
  await nextPaint(page)
}

async function wheelTranscript(page: Page, deltaY: number): Promise<void> {
  const box = await page.locator('[data-conversation-scroll]').boundingBox()
  if (box === null) throw new Error('conversation scrollport has no layout box')
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(140, box.height / 3))
  await page.mouse.wheel(0, deltaY)
  await nextPaint(page)
}

/**
 * Touch-style momentum fling over the transcript. Headless Chromium in the
 * test lane cannot synthesize device scrolling (Input.synthesizeScrollGesture
 * and Input.dispatchTouchEvent both deliver DOM events without moving any
 * scroller, and compositor scrollbars ignore synthetic mouse input), so the
 * fling replays the signature a real pan leaves on the scrollport: per-frame
 * decaying displacements the component never authored, carrying no wheel
 * events. Wheel-sign semantics: positive deltaY reads downward.
 */
async function flingTranscript(page: Page, deltaY: number): Promise<void> {
  await page.locator('[data-conversation-scroll]').evaluate(async (host, delta) => {
    const direction = Math.sign(delta)
    let remaining = Math.abs(delta)
    // Fast launch decaying toward a floor speed, like a released finger. The
    // floor stays above the follow threshold so contended frames (streaming
    // writes racing the fling) still deviate far enough to read as input.
    let velocity = Math.max(120, remaining / 8)
    while (remaining > 0) {
      const step = Math.min(velocity, remaining)
      host.scrollTop += direction * step
      remaining -= step
      velocity = Math.max(48, velocity * 0.9)
      await new Promise<void>(resolve => requestAnimationFrame(() => { resolve() }))
    }
  }, deltaY)
  await nextPaint(page)
}

async function wheelToHistoryStart(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if ((await scrollGeometry(page)).scrollTop <= 1) break
    await wheelTranscript(page, -2_400)
  }
  await expect.poll(async () => (await scrollGeometry(page)).scrollTop, { timeout: 10_000 })
    .toBeLessThanOrEqual(1)
}

async function wheelUntilMounted(page: Page, selector: string, deltaY: number): Promise<void> {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    if (await page.locator(selector).count() > 0) return
    await wheelTranscript(page, deltaY)
  }
  throw new Error(`selector did not mount during transcript wheel: ${selector}`)
}

async function wheelUntilVisible(page: Page, selector: string, deltaY: number): Promise<void> {
  const target = page.locator(selector)
  for (let attempt = 0; attempt < 32; attempt += 1) {
    if (await target.count() > 0 && await target.evaluate((row) => {
      const host = row.closest<HTMLElement>('[data-conversation-scroll]')
      if (host === null) return false
      const viewport = host.getBoundingClientRect()
      const composer = host.querySelector<HTMLElement>('[data-composer-seat]')
      const visibleBottom = composer?.getBoundingClientRect().top ?? viewport.bottom
      const rect = row.getBoundingClientRect()
      return rect.bottom > viewport.top && rect.top < visibleBottom
    })) return
    await wheelTranscript(page, deltaY)
  }
  throw new Error(`selector did not become visible during transcript wheel: ${selector}`)
}

function visibleFlowAnchor(page: Page): Promise<FlowAnchor> {
  return page.locator('[data-conversation-scroll]').evaluate((host) => {
    const rows = [...host.querySelectorAll<HTMLElement>('[data-chat-anchor-key]:not([hidden])')]
    const viewport = host.getBoundingClientRect()
    const composer = host.querySelector<HTMLElement>('[data-composer-seat]')
    const visibleBottom = composer?.getBoundingClientRect().top ?? viewport.bottom
    const visible = rows.filter((candidate) => {
      const rect = candidate.getBoundingClientRect()
      return rect.bottom > viewport.top && rect.top < visibleBottom
    })
    const row = visible[0]
    if (row?.dataset.chatAnchorKey === undefined) {
      throw new Error(`no visible settled Chat row: ${JSON.stringify({
        composerTop: visibleBottom,
        host: { bottom: viewport.bottom, top: viewport.top },
        rows: rows.slice(0, 4).map(candidate => ({
          callId: candidate.dataset.chatCallId,
          key: candidate.dataset.chatAnchorKey,
          rect: {
            bottom: candidate.getBoundingClientRect().bottom,
            top: candidate.getBoundingClientRect().top,
          },
        })),
        totalRows: rows.length,
      })}`)
    }
    return {
      key: row.dataset.chatAnchorKey,
      top: row.getBoundingClientRect().top - viewport.top,
    }
  })
}

function flowTop(page: Page, key: string): Promise<number> {
  return page.locator('[data-chat-anchor-key]').evaluateAll((rows, anchorKey) => {
    const row = rows.find(candidate => (candidate as HTMLElement).dataset.chatAnchorKey === anchorKey)
    if (!(row instanceof HTMLElement)) throw new Error(`stable Chat anchor ${anchorKey} is not mounted`)
    const host = row.closest('[data-conversation-scroll]')
    if (!(host instanceof HTMLElement)) throw new Error('flow row has no conversation scrollport')
    return row.getBoundingClientRect().top - host.getBoundingClientRect().top
  }, key)
}

async function expectSameFlowTop(
  page: Page,
  anchor: FlowAnchor,
  tolerance = GEOMETRY_TOLERANCE,
): Promise<void> {
  await expect.poll(async () => Math.abs((await flowTop(page, anchor.key)) - anchor.top), {
    timeout: 10_000,
    message: `flow row ${anchor.key} moved relative to the transcript viewport`,
  }).toBeLessThanOrEqual(tolerance)
}

async function expectBottom(page: Page): Promise<void> {
  await expect.poll(async () => Math.abs((await scrollGeometry(page)).distanceFromBottom), {
    timeout: 10_000,
  }).toBeLessThanOrEqual(1)
}

async function expectMarkerAboveComposer(page: Page, marker: string): Promise<void> {
  const geometry = await page.getByText(marker, { exact: false }).last().evaluate((node) => {
    const row = node.closest('[data-chat-flow-key], [data-streaming]')
    const composer = node.closest('[data-conversation-scroll]')?.querySelector('[data-composer-seat]')
    if (!(row instanceof HTMLElement) || !(composer instanceof HTMLElement)) {
      throw new Error('latest marker or composer geometry is unavailable')
    }
    return {
      composerTop: composer.getBoundingClientRect().top,
      rowBottom: row.getBoundingClientRect().bottom,
    }
  })
  expect(geometry.rowBottom).toBeLessThanOrEqual(geometry.composerTop + GEOMETRY_TOLERANCE)
}

async function loadEarlierWithAnchor(world: ScrollWorld): Promise<void> {
  const page = world.page
  await wheelToHistoryStart(page)
  const older = page.getByRole('button', { name: 'Load earlier', exact: true })
  // A page from the previous gesture may still be in flight: the control returns
  // to its idle label when it lands, and stays gone when it reached the head.
  await expect.poll(async () => await older.count() > 0 || await historyHeadReached(page), { timeout: 30_000 })
    .toBe(true)
  if (await historyHeadReached(page)) return
  const anchor = await visibleFlowAnchor(page)
  await loadEarlierStep(page, world.historyPages)
  await nextPaint(page)
  // The mounted window holds at most its cap of resident rows however deep the
  // loaded log grows; a live Turn's resident tail stub may sit beside it.
  expect(await mountedKeyRows(page)).toBeLessThanOrEqual(MOUNTED_ROW_CEILING)
  if (await historyHeadReached(page)) {
    expect(await page.locator('[data-turn-process][aria-expanded="false"]').count()).toBeGreaterThan(0)
    return
  }
  await expectSameFlowTop(page, anchor)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function eventCarries(event: SessionEvent, marker: string): boolean {
  return JSON.stringify(event).includes(marker)
}

function assertClean(world: ScrollWorld): void {
  expect(world.tripwire.pageErrors).toEqual([])
  expect(world.tripwire.warnings).toEqual([])
}

it('generates a current-format scroll seed with a protected system head and intact references', () => {
  const { header, events } = parseSeedFixture(HISTORY_FIXTURE.log)
  expect(header.version).toBe(SESSION_FORMAT_VERSION)
  expect(events.slice(0, 5).map(event => event.type)).toEqual([
    'turn/start', 'step/start', 'system/message', 'user/message', 'session/title',
  ])
  expect(events.filter(event => event.type === 'system/message')).toHaveLength(1)
  const firstUser = events.find(event => event.type === 'user/message')!
  const title = events.find(event => event.type === 'session/title')!
  expect(title.data.messageSeqs).toEqual([firstUser.seq])
  const calls = events.filter(event => event.type === 'tool/call')
  const results = events.filter(event => event.type === 'tool/result')
  expect(calls).toHaveLength(22)
  expect(results).toHaveLength(calls.length)
  for (const result of results) {
    const call = calls.find(event => event.data.callId === result.data.message.source.callId)!
    expect(result.sourceEventSeqs).toEqual([call.seq])
    expect(call.seq).toBeLessThan(result.seq)
  }
  expect(events.filter(event => event.type === 'turn/end')).toHaveLength(HISTORY_FIXTURE.turns)
  expect(events.at(-1)?.type).toBe('turn/end')
})

let browser: Browser

describe('web e2e: long Chat scroll contract', () => {
  beforeAll(async () => {
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser?.close()
  })

  it.skipIf(MODE === 'record')('keeps floating controls anchored outside the clipped transcript', async () => {
    await withScrollWorld({
      failureShot: 'web-e2e-chat-floating-controls',
      seeds: [{ fixture: HISTORY_FIXTURE, id: HISTORY_SESSION_ID }],
    }, async (world) => {
      await openSeed(world.page, HISTORY_FIXTURE, HISTORY_FIXTURE.markers.assistant(HISTORY_FIXTURE.turns))
      const host = world.page.locator('[data-conversation-scroll]')
      const backToBottom = world.page.getByRole('button', { name: 'Back to bottom', exact: true })
      const expectControls = async (): Promise<void> => {
        await expect.poll(() => host.evaluate((element) => {
          const rail = element.querySelector('nav[aria-label="Turn navigation"]')
          const button = element.querySelector('button[aria-label="Back to bottom"]')
          const composer = element.querySelector('[data-composer-seat]')
          if (rail === null || button === null || composer === null) return Infinity
          const viewport = element.getBoundingClientRect()
          const railBox = rail.getBoundingClientRect()
          const buttonBox = button.getBoundingClientRect()
          const composerBox = composer.getBoundingClientRect()
          const top = viewport.top + element.clientTop
          return Math.max(
            Math.abs((railBox.top + railBox.bottom) / 2 - (top + composerBox.top) / 2),
            Math.abs(viewport.left + element.clientLeft + element.clientWidth - railBox.right - 12),
            Math.abs(composerBox.top - buttonBox.bottom - 16),
          )
        }), { timeout: 10_000 }).toBeLessThanOrEqual(GEOMETRY_TOLERANCE)
      }

      await wheelTranscript(world.page, -1_200)
      await backToBottom.waitFor({ timeout: 10_000 })
      await expectControls()
      await wheelTranscript(world.page, -1_200)
      await expectControls()

      const seat = world.page.locator('[data-composer-seat]')
      const initialHeight = await seat.evaluate(element => element.getBoundingClientRect().height)
      const composer = world.page.locator('[data-composer-input][contenteditable="true"]').last()
      await composer.fill(Array.from({ length: 8 }, (_, index) => `draft line ${index}`).join('\n'))
      await expect.poll(() => seat.evaluate(element => element.getBoundingClientRect().height))
        .toBeGreaterThan(initialHeight + 40)
      await expectControls()
      await composer.fill('')
      await expectControls()

      const rail = world.page.getByRole('navigation', { name: 'Turn navigation', includeHidden: true })
      const frame = rail.locator('../..')
      const originalStyle = await frame.getAttribute('style')
      try {
        for (const clearance of [16, 8]) {
          for (const contentWidth of [901, 900, 899, 901]) {
            await frame.evaluate((element, { clearance, contentWidth }) => {
              element.style.width = `${contentWidth + 2 * (clearance + 16)}px`
              element.style.setProperty('--dsh-composer-side-clearance', `${clearance}px`)
            }, { clearance, contentWidth })
            await expect.poll(() => rail.isVisible()).toBe(contentWidth > 900)
          }
        }
      } finally {
        await frame.evaluate((element, style) => {
          if (style === null) element.removeAttribute('style')
          else element.setAttribute('style', style)
        }, originalStyle)
      }
      await expectControls()
      await backToBottom.click()
      await expectBottom(world.page)
      assertClean(world)
    })
  })

  it.skipIf(MODE === 'record')('preserves the reader anchor when history and streaming arrive concurrently', async () => {
    await withScrollWorld({
      failureShot: 'web-e2e-chat-scroll-history-stream',
      replay: [replayEntry(textStream(LIVE_TEXT_FIRST, LIVE_TEXT_DONE, 120))],
      seeds: [{ fixture: HISTORY_FIXTURE, id: HISTORY_SESSION_ID }],
    }, async (world) => {
      await openSeed(
        world.page,
        HISTORY_FIXTURE,
        HISTORY_FIXTURE.markers.assistant(HISTORY_FIXTURE.turns),
      )
      await expectBottom(world.page)

      let releaseHistory = (): void => {}
      let held = false
      let releaseGate: (() => void) | undefined
      const gate = new Promise<void>((resolve) => { releaseGate = resolve })
      releaseHistory = () => { releaseGate?.() }
      await world.page.route('**/api/session/page', async (route) => {
        const request = route.request().postDataJSON() as {
          method?: string
          payload?: { args?: { request?: { beforeSeq?: number } } }
        }
        if (!held && request.method === 'session/page'
          && request.payload?.args?.request?.beforeSeq !== undefined) {
          held = true
          await gate
        }
        await route.continue()
      })

      const settled = world.scaffold.whenTurnSettled(60_000)
      const releaseText = holdTextAfter(world, 1)
      try {
        const composer = world.page.locator('[data-composer-input][contenteditable="true"]').last()
        await composer.fill(LIVE_TEXT_PROMPT)
        await world.page.getByRole('button', { name: 'Send message', exact: true }).click()
        await world.page.getByText(LIVE_TEXT_FIRST, { exact: false }).last().waitFor({ timeout: 15_000 })
        await wheelToHistoryStart(world.page)
        // The mounted window reveals resident rows before it requests a page, so
        // the held server page takes gestures until one of them asks for it; the
        // request counter is what proves the gated page is finally in flight.
        const pagesBeforeGate = world.historyPages()
        for (let gesture = 0; gesture < 12 && world.historyPages() === pagesBeforeGate; gesture += 1) {
          if (await historyHeadReached(world.page)) break
          await loadEarlierStep(world.page, world.historyPages)
        }
        expect(world.historyPages()).toBeGreaterThan(pagesBeforeGate)
        await expect.poll(() => held, { timeout: 10_000 }).toBe(true)

        await wheelTranscript(world.page, 420)
        const readerAnchor = await visibleFlowAnchor(world.page)
        // The frozen window keeps the resident tail stub mounted while the Turn
        // streams, so the live row stays reachable above the reader's window.
        expect(await world.page.locator('[data-streaming="true"]').count()).toBeGreaterThan(0)
        const chunksAfterAnchor = world.assistantFrames.filter(frame => frame.type === 'chunk').length
        releaseText()
        await expect.poll(
          () => world.assistantFrames.filter(frame => frame.type === 'chunk').length,
          { timeout: 10_000 },
        ).toBeGreaterThan(chunksAfterAnchor + 5)

        releaseHistory()
        // The held page lands when the control leaves its loading label; the
        // reader's frozen window keeps its head row while the page prepends rows
        // above it, and the window never grows past its cap.
        await expect.poll(
          () => world.page.getByRole('button', { name: 'Loading…', exact: true }).count(),
          { timeout: 30_000 },
        ).toBe(0)
        await nextPaint(world.page)
        expect(await mountedKeyRows(world.page)).toBeLessThanOrEqual(MOUNTED_ROW_CEILING)
        await expectSameFlowTop(world.page, readerAnchor)
      } finally {
        releaseText()
        releaseHistory()
      }

      await settled
      await expect.poll(() => world.page.locator('[data-streaming="true"]').count(), { timeout: 15_000 }).toBe(0)
      await world.page.getByText(LIVE_TEXT_DONE, { exact: false }).last().waitFor({ timeout: 15_000 })
      await world.page.unroute('**/api/session/page')

      let additionalGestures = 0
      // The cap covers the session's full depth at the current 8-message page
      // size plus the resident reveals each page needs before it pages; the
      // Load-earlier disappearance still breaks the loop once the head is reached.
      while (additionalGestures < 96) {
        await wheelToHistoryStart(world.page)
        if (await historyHeadReached(world.page)) break
        await loadEarlierWithAnchor(world)
        additionalGestures += 1
      }
      expect(additionalGestures).toBeGreaterThan(0)
      // The whole log is resident and the window sits at its head: turn 1's
      // unique marker renders in the transcript (scoped: the sidebar search row
      // also carries it), no page remains, and the mounted rows stay capped.
      expect(await historyHeadReached(world.page)).toBe(true)
      expect(await mountedKeyRows(world.page)).toBeLessThanOrEqual(MOUNTED_ROW_LIMIT)
      expect(await world.page.locator('[data-conversation-scroll]')
        .getByText(HISTORY_FIXTURE.markers.user(1), { exact: false }).count()).toBe(1)
      assertClean(world)
    })
  }, 180_000)

  it.skipIf(MODE === 'record')('follows a growing process group independently of the outer transcript', async () => {
    const parts = [
      'GROUP_SCROLL_START\n\n',
      ...Array.from({ length: 4 }, (_, batch) => Array.from({ length: 20 }, (_, row) =>
        `Group batch ${batch} paragraph ${row}: inspect the next recorded operation.\n\n`).join('')),
      'GROUP_SCROLL_END\n\n',
    ]
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      ...parts.map((text): StreamChunk => ({ type: 'reasoning-delta', index: 0, text })),
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: parts.join('') } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'GROUP_SCROLL_DONE' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'GROUP_SCROLL_DONE' } },
      { type: 'usage', usage: { inputTokens: 256, outputTokens: 512 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    await withScrollWorld({
      failureShot: 'web-e2e-chat-process-follow',
      replay: [replayEntry(chunks)],
      seeds: [{ fixture: HISTORY_FIXTURE, id: HISTORY_SESSION_ID }],
    }, async (world) => {
      await world.page.emulateMedia({ reducedMotion: 'no-preference' })
      await openSeed(world.page, HISTORY_FIXTURE, HISTORY_FIXTURE.markers.assistant(HISTORY_FIXTURE.turns))
      const gates = parts.slice(1).map(() => Promise.withResolvers<undefined>())
      const dispose = world.scaffold.ctx.on('llm/stream', async function* (_options, next) {
        let index = -1
        for await (const chunk of next()) {
          if (chunk.type === 'reasoning-delta') await gates[index++]?.promise
          yield chunk
        }
      })
      const settled = world.scaffold.whenTurnSettled(60_000)
      try {
        await world.page.locator('[data-composer-input][contenteditable="true"]').last().fill(
          'Inspect the recorded operations while I scroll the conversation.',
        )
        await world.page.getByRole('button', { name: 'Send message', exact: true }).click()
        const group = world.page.locator('[data-step-process]:has([data-variant="think"][data-state="running"])')
        await group.locator('[data-process-activity]').click()
        await group.locator('[data-disclosure-row]').click()
        const body = group.locator('[data-step-process-body]')
        await nextPaint(world.page)
        expect(await body.evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true)
        const height = () => body.evaluate(element => element.scrollHeight)
        const top = () => body.evaluate(element => element.scrollTop)
        const expectGroupBottom = async (): Promise<void> => {
          await expect.poll(() => body.evaluate(element =>
            element.scrollHeight - element.clientHeight - element.scrollTop))
            .toBeLessThanOrEqual(GEOMETRY_TOLERANCE)
        }
        const grow = async (index: number): Promise<void> => {
          const before = await height()
          gates[index]!.resolve(undefined)
          await expect.poll(height).toBeGreaterThan(before + 200)
        }

        // Outer following is a precondition independent of opening the inner disclosure.
        const backToBottom = world.page.getByRole('button', { name: 'Back to bottom', exact: true })
        await wheelTranscript(world.page, -400)
        await backToBottom.click()
        await expectBottom(world.page)
        await grow(0)
        await expectGroupBottom()
        await expectBottom(world.page)
        // Per-frame growth exercises the real observer and native animation
        // independently of transport batching while the next model chunk waits.
        const content = group.locator('[data-step-process-content]')
        const heightStyle = await content.evaluate(element => element.style.height)
        const beforeGrowth = await top()
        try {
          const duringGrowth = await body.evaluate(async (scroller) => {
            const content = scroller.querySelector<HTMLElement>('[data-step-process-content]')!
            const initialHeight = content.getBoundingClientRect().height
            let halfway = scroller.scrollTop
            for (let frame = 1; frame <= 60; frame++) {
              content.style.height = `${initialHeight + frame * 20}px`
              await new Promise<void>(resolve => requestAnimationFrame(() => { resolve() }))
              if (frame === 30) halfway = scroller.scrollTop
            }
            return halfway
          })
          expect(duringGrowth).toBeGreaterThan(beforeGrowth + 20)
          await expectGroupBottom()
        } finally {
          await content.evaluate((element, previous) => { element.style.height = previous }, heightStyle)
        }
        await expectGroupBottom()
        await wheelTranscript(world.page, -800)
        await backToBottom.waitFor()
        const outerTop = (await scrollGeometry(world.page)).scrollTop
        await grow(1)
        await expectGroupBottom()
        expect(Math.abs((await scrollGeometry(world.page)).scrollTop - outerTop)).toBeLessThanOrEqual(GEOMETRY_TOLERANCE)

        await backToBottom.click()
        await expectBottom(world.page)
        const pinnedTop = await top()
        await body.hover()
        await world.page.mouse.wheel(0, -160)
        await expect.poll(top).toBeLessThan(pinnedTop - 100)
        await nextPaint(world.page)
        const readerTop = await top()
        await grow(2)
        expect(Math.abs(await top() - readerTop)).toBeLessThanOrEqual(GEOMETRY_TOLERANCE)
        await expectBottom(world.page)

        await group.locator('[data-process-activity]').click()
        await group.locator('[data-process-activity]').click()
        await expectGroupBottom()

        await body.hover()
        await world.page.mouse.wheel(0, 10_000)
        await expectGroupBottom()
        await grow(3)
        await expectGroupBottom()
        assertClean(world)
      } finally {
        for (const gate of gates) gate.resolve(undefined)
        dispose()
        await settled
      }
    })
  })

  it.skipIf(MODE === 'record')('virtualizes the outline rail and jumps to an unloaded turn', async () => {
    await withScrollWorld({
      failureShot: 'web-e2e-turn-rail-jump',
      seeds: [{ fixture: HISTORY_FIXTURE, id: RAIL_SESSION_ID }],
    }, async (world) => {
      await openSeed(world.page, HISTORY_FIXTURE, HISTORY_FIXTURE.markers.assistant(HISTORY_FIXTURE.turns))
      await expectBottom(world.page)

      const rail = world.page.getByRole('navigation', { name: 'Turn navigation' })
      const latest = rail.getByRole('button', { name: `Jump to turn ${String(HISTORY_FIXTURE.turns)}`, exact: true })
      await expect.poll(() => latest.getAttribute('aria-current'), { timeout: 15_000 }).toBe('true')
      expect(await rail.getByRole('button').count()).toBeLessThan(HISTORY_FIXTURE.turns)
      const firstUnloaded = rail.getByRole('button', { name: 'Load and jump to turn 1', exact: true })
      expect(await firstUnloaded.count()).toBe(0)
      const railScroller = rail.locator('[class*="scroller"]')
      await expect.poll(() => railScroller.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
      await expect.poll(() => rail.locator('[class*="fadeTop"]').count(), { timeout: 15_000 }).toBe(1)
      const bodyBeforeRailScroll = await scrollGeometry(world.page)
      await railScroller.hover()
      await world.page.mouse.wheel(0, -HISTORY_FIXTURE.turns * 10)
      await expect.poll(() => railScroller.evaluate(element => element.scrollTop)).toBe(0)
      await firstUnloaded.waitFor({ state: 'visible' })
      expect((await scrollGeometry(world.page)).scrollTop).toBe(bodyBeforeRailScroll.scrollTop)

      // The mounted window holds its cap before the jump pages the rest in.
      expect(await mountedKeyRows(world.page)).toBeLessThanOrEqual(MOUNTED_ROW_LIMIT)
      await firstUnloaded.focus()
      const tooltip = world.page.getByRole('tooltip')
      await expect.poll(() => tooltip.count(), { timeout: 15_000 }).toBe(1)
      await expect.poll(() => tooltip.textContent(), { timeout: 5_000 }).toContain(HISTORY_FIXTURE.markers.user(1))
      expect(await tooltip.textContent()).toContain(HISTORY_FIXTURE.markers.assistant(1))
      const previewId = await tooltip.getAttribute('id')
      const hoveredMark = () => rail.evaluate(element => element.querySelector<HTMLButtonElement>('button:hover')?.dataset.index ?? null)
      await expect.poll(hoveredMark).not.toBeNull()
      const hoveredBefore = await hoveredMark()
      await world.page.mouse.wheel(0, 80)
      await expect.poll(() => railScroller.evaluate(element => element.scrollTop)).toBe(80)
      await expect.poll(hoveredMark).toBe(String(Number(hoveredBefore) + 8))
      await nextPaint(world.page)
      expect(await firstUnloaded.evaluate(element => document.activeElement === element)).toBe(true)
      expect(await firstUnloaded.getAttribute('aria-describedby')).toBe(previewId)
      expect(await tooltip.textContent()).toContain(HISTORY_FIXTURE.markers.user(1))
      await world.page.mouse.wheel(0, -80)
      await expect.poll(() => railScroller.evaluate(element => element.scrollTop)).toBe(0)
      const transcriptLayers = await tooltip.evaluate((preview) => {
        const railSlot = preview.closest('nav')?.parentElement
        const codeBanner = document.querySelector<HTMLElement>('.md-code-block > :first-child')
        if (!(railSlot instanceof HTMLElement) || codeBanner === null) {
          throw new Error('turn preview or code-block banner stacking context is unavailable')
        }
        return {
          codeBanner: Number(getComputedStyle(codeBanner).zIndex),
          rail: Number(getComputedStyle(railSlot).zIndex),
        }
      })
      expect(transcriptLayers.rail).toBeGreaterThan(transcriptLayers.codeBanner)
      await world.page.keyboard.press('Enter')

      // The jump pages history in and lands on turn 1: its mark flips to the
      // loaded label and becomes current, the window holds the target's row, and
      // the mounted rows stay at their cap while the loaded log grows.
      const firstLoaded = rail.getByRole('button', { name: 'Jump to turn 1', exact: true })
      await expect.poll(() => firstLoaded.count(), { timeout: 60_000 }).toBe(1)
      await expect.poll(() => firstLoaded.getAttribute('aria-current'), { timeout: 15_000 }).toBe('true')
      expect(await mountedKeyRows(world.page)).toBeLessThanOrEqual(MOUNTED_ROW_LIMIT)
      // Drop mark focus so its hover/focus preview (which echoes the prompt
      // marker) leaves the DOM before the transcript count below.
      await firstLoaded.evaluate((el) => { (el as HTMLElement).blur() })
      await expect.poll(() => world.page.getByRole('tooltip').count(), { timeout: 15_000 }).toBe(0)
      await nextPaint(world.page)
      const marker = world.page.locator('[data-conversation-scroll]')
        .getByText(HISTORY_FIXTURE.markers.user(1), { exact: false })
      expect(await marker.count()).toBe(1)
      const scrollport = await world.page.locator('[data-conversation-scroll]').boundingBox()
      const row = await marker.boundingBox()
      if (scrollport === null || row === null) throw new Error('turn-1 row or scrollport has no layout box')
      expect(row.y - scrollport.y).toBeGreaterThanOrEqual(0)
      expect(row.y - scrollport.y).toBeLessThanOrEqual(160)
      // The rail followed the landing to the ladder top, so the fade now
      // marks the other (downward) end.
      await expect.poll(() => rail.locator('[class*="fadeBottom"]').count(), { timeout: 15_000 }).toBe(1)
      assertClean(world)
    })
  }, 180_000)

  it.skipIf(MODE === 'record')('keeps streaming ownership and tool disclosure state across a long scroll-away cycle', async () => {
    await withScrollWorld({
      failureShot: 'web-e2e-chat-scroll-live-tool',
      replay: [
        replayEntry(toolStream()),
        replayEntry(textStream(LIVE_TOOL_FIRST, LIVE_TOOL_DONE, 84)),
      ],
      seeds: [{ fixture: TOOL_FIXTURE, id: TOOL_SESSION_ID }],
    }, async (world) => {
      const readyPath = join(world.scaffold.workspaceCwd, TOOL_READY_FILE)
      const releasePath = join(world.scaffold.workspaceCwd, TOOL_RELEASE_FILE)
      await openSeed(world.page, TOOL_FIXTURE, TOOL_FIXTURE.markers.assistant(TOOL_FIXTURE.turns))
      const settled = world.scaffold.whenTurnSettled(60_000)
      let released = false
      try {
        const composer = world.page.locator('[data-composer-input][contenteditable="true"]').last()
        await composer.fill(LIVE_TOOL_PROMPT)
        await world.page.getByRole('button', { name: 'Send message', exact: true }).click()
        await expect.poll(() => fileExists(readyPath), { timeout: 15_000 }).toBe(true)
        const liveRow = world.page.locator(`[data-chat-call-id="${LIVE_TOOL_CALL_ID}"] [data-sample="bash"]`)
        await expandOwningTurnProcess(world.page, liveRow)
        await liveRow.waitFor({ timeout: 15_000 })
        expect(await liveRow.getAttribute('data-state')).toBe('running')
        await expectBottom(world.page)
        expect(await world.page.getByRole('button', { name: 'Back to bottom', exact: true }).count()).toBe(0)

        await wheelTranscript(world.page, -1_200)
        await world.page.getByRole('button', { name: 'Back to bottom', exact: true }).waitFor({ timeout: 10_000 })
        const awayAnchor = await visibleFlowAnchor(world.page)
        const chunksBeforeRelease = world.assistantFrames.filter(frame => frame.type === 'chunk').length
        await writeFile(releasePath, 'release\n')
        released = true
        await expect.poll(
          () => world.assistantFrames.filter(frame => frame.type === 'chunk').length,
          { timeout: 15_000 },
        ).toBeGreaterThan(chunksBeforeRelease + 5)
        await nextPaint(world.page)
        // The loop appends tool/result before starting the next model request;
        // these synchronous Host listeners therefore observe it before later chunks.
        expect(world.events.some(event => event.type === 'tool/result')).toBe(true)
        expect(Math.abs((await flowTop(world.page, awayAnchor.key)) - awayAnchor.top))
          .toBeLessThanOrEqual(GEOMETRY_TOLERANCE)

        const chunksAtRepin = world.assistantFrames.filter(frame => frame.type === 'chunk').length
        await world.page.getByRole('button', { name: 'Back to bottom', exact: true }).click()
        await expect.poll(
          () => world.assistantFrames.filter(frame => frame.type === 'chunk').length,
          { timeout: 15_000 },
        ).toBeGreaterThan(chunksAtRepin + 5)
        await nextPaint(world.page)
        expect(Math.abs((await scrollGeometry(world.page)).distanceFromBottom)).toBeLessThanOrEqual(1)
      } finally {
        if (!released) await writeFile(releasePath, 'release\n').catch(() => {})
      }

      await settled
      expect(world.events.some(event => eventCarries(event, LIVE_TOOL_FIRST))).toBe(true)
      await expect.poll(() => world.page.locator('[data-streaming="true"]').count(), { timeout: 15_000 }).toBe(0)
      await world.page.getByText(LIVE_TOOL_DONE, { exact: false }).last().waitFor({ timeout: 15_000 })
      await expectBottom(world.page)
      await expectMarkerAboveComposer(world.page, LIVE_TOOL_DONE)

      const liveRowSelector = `[data-chat-call-id="${LIVE_TOOL_CALL_ID}"] [data-sample="bash"]`
      const liveRow = world.page.locator(liveRowSelector)
      await expandOwningTurnProcess(world.page, liveRow)
      await wheelUntilVisible(world.page, liveRowSelector, -300)
      const toolAnchor = await liveRow.evaluate((row) => {
        const flow = row.closest<HTMLElement>('[data-chat-anchor-key]')
        const host = row.closest<HTMLElement>('[data-conversation-scroll]')
        if (flow?.dataset.chatAnchorKey === undefined || host === null) {
          throw new Error('live tool row has no settled flow identity')
        }
        return {
          key: flow.dataset.chatAnchorKey,
          top: flow.getBoundingClientRect().top - host.getBoundingClientRect().top,
        }
      })
      await liveRow.click()
      await expect.poll(() => liveRow.getAttribute('aria-expanded'), { timeout: 10_000 }).toBe('true')
      await expectSameFlowTop(world.page, toolAnchor)
      await wheelToHistoryStart(world.page)
      await world.page.getByRole('button', { name: 'Back to bottom', exact: true }).click()
      await expectBottom(world.page)
      await wheelUntilMounted(world.page, liveRowSelector, -1_100)
      const restoredRow = world.page.locator(liveRowSelector)
      await restoredRow.waitFor({ timeout: 10_000 })
      expect(await restoredRow.getAttribute('aria-expanded')).toBe('true')
      expect(await world.page.getByText(LIVE_TOOL_RESULT, { exact: false }).count()).toBeGreaterThan(0)
      assertClean(world)
    })
  }, 180_000)

  it.skipIf(MODE === 'record')('keeps composer resizing on the correct scroll owner across reopened Sessions', async () => {
    await withScrollWorld({
      failureShot: 'web-e2e-chat-scroll-restore-composer',
      seeds: [
        { fixture: RESTORE_FIXTURE_A, id: RESTORE_SESSION_A_ID },
        { fixture: RESTORE_FIXTURE_B, id: RESTORE_SESSION_B_ID },
      ],
    }, async (world) => {
      await openSeed(
        world.page,
        RESTORE_FIXTURE_A,
        RESTORE_FIXTURE_A.markers.assistant(RESTORE_FIXTURE_A.turns),
      )
      await loadEarlierWithAnchor(world)
      await loadEarlierWithAnchor(world)
      await wheelToHistoryStart(world.page)
      await wheelTranscript(world.page, 1_300)
      const sessionAnchor = await visibleFlowAnchor(world.page)

      await world.page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
      await world.page.getByLabel('Trajectory timeline').waitFor({ timeout: 30_000 })
      await world.page.setViewportSize({ width: 700, height: 900 })
      // 700px lands in the mobile regime (<768px): the sidebar is the overlay
      // drawer and the drawer's scrim would swallow a tab click while open.
      // Return to Chat first, then drive the cross-session flow through the
      // drawer (each session selection closes it; the opener button returns).
      await world.page.getByRole('tab', { name: 'Chat', exact: true }).click()
      await nextPaint(world.page)
      await expectSameFlowTop(world.page, sessionAnchor, RESPONSIVE_REFLOW_TOLERANCE)

      await ensureDrawerOpen(world.page)
      await openSeed(
        world.page,
        RESTORE_FIXTURE_B,
        RESTORE_FIXTURE_B.markers.assistant(RESTORE_FIXTURE_B.turns),
      )
      await ensureDrawerOpen(world.page)
      await openSeed(
        world.page,
        RESTORE_FIXTURE_A,
        RESTORE_FIXTURE_A.markers.assistant(RESTORE_FIXTURE_A.turns),
        { preserveReaderPosition: true },
      )

      const backToBottom = world.page.getByRole('button', { name: 'Back to bottom', exact: true })
      await backToBottom.waitFor({ timeout: 15_000 })
      await backToBottom.evaluate((button) => {
        if (!(button instanceof HTMLElement)) throw new Error('Back-to-bottom control is not an HTML element')
        button.click()
        const trajectory = [...document.querySelectorAll<HTMLElement>('[role="tab"]')]
          .find(tab => tab.textContent?.trim() === 'Trajectory')
        if (!(trajectory instanceof HTMLElement)) {
          throw new Error('Trajectory tab is unavailable during pinned remount')
        }
        trajectory.click()
      })
      await world.page.getByLabel('Trajectory timeline').waitFor({ timeout: 30_000 })
      await world.page.getByRole('tab', { name: 'Chat', exact: true }).click()
      await expectBottom(world.page)
      // Mobile regime: the only sidebar opener is the frame's floating button,
      // and the drawer auto-closed on the previous session selection.
      await ensureDrawerOpen(world.page)
      await openSeed(
        world.page,
        RESTORE_FIXTURE_B,
        RESTORE_FIXTURE_B.markers.assistant(RESTORE_FIXTURE_B.turns),
      )
      await ensureDrawerOpen(world.page)
      await openSeed(
        world.page,
        RESTORE_FIXTURE_A,
        RESTORE_FIXTURE_A.markers.assistant(RESTORE_FIXTURE_A.turns),
      )
      await expectBottom(world.page)
      const composer = world.page.locator('[data-composer-input][contenteditable="true"]').last()
      const longDraft = Array.from(
        { length: 18 },
        (_, index) => `composer resize line ${String(index + 1).padStart(2, '0')}`,
      ).join('\n')
      await composer.fill(longDraft)
      await nextPaint(world.page)
      await expectBottom(world.page)
      await expectMarkerAboveComposer(
        world.page,
        RESTORE_FIXTURE_A.markers.assistant(RESTORE_FIXTURE_A.turns),
      )

      await composer.fill('short draft')
      await nextPaint(world.page)
      await wheelTranscript(world.page, -900)
      const resizeAnchor = await visibleFlowAnchor(world.page)
      await composer.fill(longDraft)
      await nextPaint(world.page)
      await expectSameFlowTop(world.page, resizeAnchor)
      await composer.fill('short draft')
      await nextPaint(world.page)
      await expectSameFlowTop(world.page, resizeAnchor)

      const beforeChain = await scrollGeometry(world.page)
      await composer.hover()
      await world.page.mouse.wheel(0, -320)
      await expect.poll(async () => (await scrollGeometry(world.page)).scrollTop, { timeout: 10_000 })
        .toBeLessThan(beforeChain.scrollTop)
      assertClean(world)
    })
  }, 180_000)

  // Keyboard is the only non-wheel device this lane's Chromium can drive for
  // real (see flingTranscript for the probe results on touch and scrollbars),
  // so it stands in for the whole hardware input pipeline here.
  it.skipIf(MODE === 'record')('keyboard paging owns bottom-follow without wheel input', async () => {
    await withScrollWorld({
      failureShot: 'web-e2e-chat-scroll-keyboard',
      seeds: [{ fixture: INPUTS_FIXTURE, id: INPUTS_SESSION_ID }],
    }, async (world) => {
      await openSeed(
        world.page,
        INPUTS_FIXTURE,
        INPUTS_FIXTURE.markers.assistant(INPUTS_FIXTURE.turns),
      )
      await expectBottom(world.page)
      const backToBottom = world.page.getByRole('button', { name: 'Back to bottom', exact: true })

      // Focus rides the last seeded tool row (a tabbable button whose keydown
      // handler passes scrolling keys through). End first normalizes the
      // focus-driven scrollIntoView back to the floor.
      const lastToolRow = world.page.locator(
        `[data-chat-call-id="chat-scroll-${String(INPUTS_FIXTURE.turns).padStart(3, '0')}-1"] [data-sample="bash"]`,
      )
      await expandOwningTurnProcess(world.page, lastToolRow)
      await lastToolRow.focus()
      await world.page.keyboard.press('End')
      await expectBottom(world.page)
      await expect.poll(() => backToBottom.count(), { timeout: 10_000 }).toBe(0)
      for (let press = 0; press < 3; press += 1) {
        await world.page.keyboard.press('PageUp')
        await nextPaint(world.page)
      }
      await backToBottom.waitFor({ timeout: 10_000 })
      await expect.poll(async () => (await scrollGeometry(world.page)).distanceFromBottom, { timeout: 10_000 })
        .toBeGreaterThan(100)
      await world.page.keyboard.press('End')
      await expectBottom(world.page)
      await expect.poll(() => backToBottom.count(), { timeout: 10_000 }).toBe(0)
      assertClean(world)
    })
  }, 180_000)

  it.skipIf(MODE === 'record')('touch-style fling scrolling owns streaming bottom-follow without wheel input', async () => {
    await withScrollWorld({
      failureShot: 'web-e2e-chat-scroll-fling-stream',
      paceMs: 0,
      replay: [
        replayEntry(toolStream()),
        replayEntry(textStream(LIVE_FLING_FIRST, LIVE_FLING_DONE, 240)),
      ],
      seeds: [{ fixture: INPUTS_FIXTURE, id: FLING_SESSION_ID }],
    }, async (world) => {
      const readyPath = join(world.scaffold.workspaceCwd, TOOL_READY_FILE)
      const releasePath = join(world.scaffold.workspaceCwd, TOOL_RELEASE_FILE)
      await openSeed(world.page, INPUTS_FIXTURE, INPUTS_FIXTURE.markers.assistant(INPUTS_FIXTURE.turns))
      const backToBottom = world.page.getByRole('button', { name: 'Back to bottom', exact: true })
      const settled = world.scaffold.whenTurnSettled(60_000)
      const releaseText = holdTextAfter(world, 16)
      let released = false
      try {
        const composer = world.page.locator('[data-composer-input][contenteditable="true"]').last()
        await composer.fill(LIVE_FLING_PROMPT)
        await world.page.getByRole('button', { name: 'Send message', exact: true }).click()
        await expect.poll(() => fileExists(readyPath), { timeout: 15_000 }).toBe(true)
        await expectBottom(world.page)

        // Fling away while the turn is mid-flight: the scroll burst alone must
        // release bottom ownership, exactly like a wheel scroll would, even
        // while streaming keeps re-asserting the floor between frames.
        await flingTranscript(world.page, -900)
        await backToBottom.waitFor({ timeout: 10_000 })
        const awayAnchor = await visibleFlowAnchor(world.page)
        const chunksBeforeRelease = world.assistantFrames.filter(frame => frame.type === 'chunk').length
        await writeFile(releasePath, 'release\n')
        released = true
        await expect.poll(
          () => world.events.some(event => event.type === 'tool/result'),
          { timeout: 15_000 },
        ).toBe(true)
        await expect.poll(
          () => world.assistantFrames.filter(frame => frame.type === 'chunk').length,
          { timeout: 15_000 },
        ).toBeGreaterThan(chunksBeforeRelease + 5)
        await expectSameFlowTop(world.page, awayAnchor)

        // Fling back to the floor: re-pin must come from the reader's scroll
        // itself, and follow must then own the still-streaming tail. The
        // retry loop chases the floor that streaming keeps pushing down.
        for (let attempt = 0; attempt < 8; attempt += 1) {
          if ((await scrollGeometry(world.page)).distanceFromBottom <= 1) break
          await flingTranscript(world.page, 1_600)
        }
        await expectBottom(world.page)
        await expect.poll(() => backToBottom.count(), { timeout: 10_000 }).toBe(0)
        const chunksAtRepin = world.assistantFrames.filter(frame => frame.type === 'chunk').length
        releaseText()
        await expect.poll(
          () => world.assistantFrames.filter(frame => frame.type === 'chunk').length,
          { timeout: 15_000 },
        ).toBeGreaterThan(chunksAtRepin + 5)
        await expectBottom(world.page)
      } finally {
        releaseText()
        if (!released) await writeFile(releasePath, 'release\n').catch(() => {})
      }

      await settled
      await expect.poll(() => world.page.locator('[data-streaming="true"]').count(), { timeout: 15_000 }).toBe(0)
      await world.page.getByText(LIVE_FLING_DONE, { exact: false }).last().waitFor({ timeout: 15_000 })
      await expectBottom(world.page)
      assertClean(world)
    })
  }, 180_000)

  it.skipIf(MODE === 'record')('walks resident history on consecutive upward gestures from the tail', async () => {
    await withScrollWorld({
      failureShot: 'web-e2e-chat-scroll-continuous',
      seeds: [{ fixture: HISTORY_FIXTURE, id: HISTORY_SESSION_ID }],
    }, async (world) => {
      const page = world.page
      await openSeed(page, HISTORY_FIXTURE, HISTORY_FIXTURE.markers.assistant(HISTORY_FIXTURE.turns))
      await expectBottom(page)

      // The traversal needs resident rows above the mounted window: with the whole
      // resident order inside it, the window head is already the resident head and
      // only the explicit control can page older history in. The fork pages eight
      // messages at a time and a click that only reveals the resident rows asks the
      // server for nothing, so the world clicks until six pages have landed.
      const pages = world.historyPages
      for (let gesture = 0; gesture < 40 && pages() < 6; gesture += 1) {
        if (await historyHeadReached(page)) break
        await loadEarlierStep(page, pages)
      }
      expect(pages()).toBeGreaterThanOrEqual(6)
      expect(await mountedKeyRows(page)).toBeGreaterThanOrEqual(MOUNTED_ROW_LIMIT)

      // Hand the live tail back through the view's own control, so the reader owns
      // the tail and the mounted window is the tail slice they start on.
      const backToBottom = page.getByRole('button', { name: 'Back to bottom', exact: true })
      if (await backToBottom.count() > 0) await backToBottom.first().click()
      await expectBottom(page)

      // Record every scrollport position the app itself writes: the reader's own
      // gestures are native scrolling, so a write is the view re-calculating where
      // the reader stands.
      await page.evaluate(() => {
        const scroller = document.querySelector('[data-conversation-scroll]')
        if (!(scroller instanceof HTMLElement)) throw new Error('conversation scrollport is missing')
        const ledger = window as unknown as { __scrollWrites: number[] }
        ledger.__scrollWrites = []
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
        if (descriptor?.set === undefined || descriptor.get === undefined) {
          throw new Error('Element.prototype.scrollTop has no accessor to observe')
        }
        Object.defineProperty(Element.prototype, 'scrollTop', {
          configurable: true,
          get(this: Element): number { return descriptor.get!.call(this) as number },
          set(this: Element, value: number): void {
            if (this === scroller) ledger.__scrollWrites.push(value)
            descriptor.set!.call(this, value)
          },
        })
      })

      interface TraversalStep {
        readonly headKey: string | null
        readonly headTurn: number | null
        readonly rows: number
        readonly top: number
        readonly writes: readonly number[]
      }
      const step = (): Promise<TraversalStep> => page.evaluate(() => {
        const scroller = document.querySelector('[data-conversation-scroll]')
        if (!(scroller instanceof HTMLElement)) throw new Error('conversation scrollport is missing')
        const rows = [...scroller.querySelectorAll<HTMLElement>('[data-chat-flow-key]')]
        const head = rows[0]
        const turn = head?.dataset.chatTurn
        const ledger = window as unknown as { __scrollWrites: number[] }
        return {
          headKey: head?.dataset.chatAnchorKey ?? null,
          headTurn: turn === undefined ? null : Number(turn),
          rows: rows.length - scroller.querySelectorAll('[data-chat-group-key]').length,
          top: scroller.scrollTop,
          writes: [...ledger.__scrollWrites],
        }
      })

      const box = await page.locator('[data-conversation-scroll]').boundingBox()
      if (box === null) throw new Error('conversation scrollport has no layout box')
      await page.mouse.move(box.x + box.width / 2, box.y + Math.min(140, box.height / 3))
      const trace: TraversalStep[] = [await step()]
      for (let gesture = 0; gesture < 56; gesture += 1) {
        await page.mouse.wheel(0, -220)
        // Continuous reader input: the gap stays well inside the reading policy's
        // 500 ms sample interval, so no settled sample can gate the traversal.
        await page.waitForTimeout(120)
        trace.push(await step())
      }
      const evidence = JSON.stringify(trace)

      // The reader's own upward gestures never move the position back down.
      const increases = trace.slice(1)
        .filter((entry, index) => entry.top > (trace[index] as TraversalStep).top + 0.5)
      expect(increases, `scrollTop rose during an upward gesture: ${evidence}`).toEqual([])

      // The oldest mounted row walks toward the transcript head: its Turn number
      // steps strictly downward over the traversal.
      const turns = trace.map(entry => entry.headTurn)
        .filter((turn): turn is number => turn !== null && Number.isSafeInteger(turn))
      const walked = turns.slice(1).filter((turn, index) => turn < (turns[index] as number)).length
      expect(walked, `the mounted head never walked back: ${evidence}`).toBeGreaterThanOrEqual(3)
      expect((turns[0] as number) - (turns.at(-1) as number),
        `the mounted head did not reach older Turns: ${evidence}`).toBeGreaterThanOrEqual(10)

      // The mount stays bounded however far the reader walks.
      expect(Math.max(...trace.map(entry => entry.rows))).toBeLessThanOrEqual(MOUNTED_ROW_CEILING)

      // Every write the view made during the traversal moved the reader up or left
      // them where they were: a write that sets an offset above the one the reader
      // held is the re-calculated position that pushed them back down the flow.
      const downWrites = trace.slice(1).flatMap((entry, index) => {
        const previous = trace[index] as TraversalStep
        return entry.writes.slice(previous.writes.length)
          .filter(value => value > previous.top + 0.5)
      })
      expect(downWrites, `the view re-positioned the scrollport downward: ${evidence}`).toEqual([])

      // A pause mid-traversal settles the reading policy without moving the reader:
      // the row at their reading line holds the geometry it had while they scrolled.
      const readingLine = await visibleFlowAnchor(page)
      await page.waitForTimeout(900)
      await expectSameFlowTop(page, readingLine)
      assertClean(world)
    })
  }, 300_000)
})
