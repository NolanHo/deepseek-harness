/** Required browser budgets for opening, paging and continuing synthetic long history. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { chromium, type Page, type CDPSession, type Locator } from 'playwright'
import { expect, it } from 'vitest'
import {
  countHistoryPages, launchWebScaffold, mountedHeadKey, seedSession, watchConsole, webSnapshotMode,
} from '../../apps/web/tests/scaffold.ts'
import { newEnglishPage } from '../../apps/web/tests/support.ts'
import { ciTimeBudget, PERFORMANCE_BUDGET_HEADROOM } from '../support/calibration.ts'
import { HISTORY_TURNS, SESSION_ID, FIRST, DONE, DELTAS, PACE_MS, syntheticHistory, syntheticReply } from './synthetic-history.ts'

const SAMPLES = 3
const TAIL = '[data-chat-flow-key^="9:turn-tail"]'
/**
 * Load earlier gestures one run may issue before the benchmark fails loudly.
 * The 240-Turn fixture needs one page per history page plus the resident reveals
 * each window step takes before it pages again, which stays far below this cap.
 */
const MAX_LOAD_EARLIER_GESTURES = 512
/**
 * How long one Load earlier gesture may take to show its effect. A reveal moves
 * the window head in the click's own commit and a page request is issued on the
 * click, so a gesture with work left does not stay quiet this long.
 */
const GESTURE_EFFECT_MS = 10_000
const REFERENCE = { open: 200, page: 260, trajectory: 160, first: 1100, streamTask: 1800, input: 500, streamWall: 1000 }
const EXPECTED_OPEN_CI_MS = 900
const EXPECTED_PAGE_CI_MS = 700
const EXPECTED_TRAJECTORY_CI_MS = 520
const OPEN_BUDGET_MS = Math.ceil(EXPECTED_OPEN_CI_MS * PERFORMANCE_BUDGET_HEADROOM)
const PAGE_BUDGET_MS = Math.ceil(EXPECTED_PAGE_CI_MS * PERFORMANCE_BUDGET_HEADROOM)
const TRAJECTORY_BUDGET_MS = Math.ceil(EXPECTED_TRAJECTORY_CI_MS * PERFORMANCE_BUDGET_HEADROOM)
const REPLAY_DURATION_MS = (DELTAS + 4) * PACE_MS

async function painted(page: Page): Promise<void> {
  // Two rAF callbacks include a rendering opportunity, not a GPU presentation timestamp.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function measure(page: Page, action: () => Promise<void>): Promise<number> {
  const start = performance.now()
  await action()
  await painted(page)
  return performance.now() - start
}

async function taskMs(cdp: CDPSession): Promise<number> {
  const result = await cdp.send('Performance.getMetrics')
  const metric = result.metrics.find(metric => metric.name === 'TaskDuration')
  if (metric === undefined) throw new Error('Chromium TaskDuration missing')
  return metric.value * 1000
}

function median(values: number[]): number {
  return values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!
}

function expectEndpointWithinBudget(value: number, budget: number): void {
  expect(value).toBeLessThanOrEqual(budget)
}

function expectInputOverlap(value: boolean): void {
  expect(value).toBe(true)
}

/**
 * Whether the transcript head is reached: the Load earlier control is gone, so
 * no Session page is left to request and no resident row remains above the
 * mounted window head. A mounted row count cannot state either fact, because the
 * window stops at its row limit however deep the loaded history grows.
 * @param page - the benchmark page.
 * @returns whether no Load earlier gesture remains.
 */
async function historyHeadReached(page: Page): Promise<boolean> {
  return await page.getByRole('button', { name: /^(?:Load earlier|Loading…)$/ }).count() === 0
}

/**
 * Turn of the oldest mounted transcript row, which is the mounted window's head.
 * It falls toward Turn 1 as Load earlier reveals resident rows and pages older
 * ones in, so it reports paging progress where a mounted row count saturates.
 * @param page - the benchmark page.
 * @returns the head row's Turn, or null when no mounted row carries one.
 */
function oldestMountedTurn(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    for (const row of document.querySelectorAll<HTMLElement>('[data-chat-flow-key]')) {
      const turn = row.dataset.chatTurn
      if (turn !== undefined) return Number(turn)
    }
    return null
  })
}

/** Wait for one Turn's turn-tail row to be mounted in the transcript. */
async function waitForTurnTailRow(page: Page, turn: number): Promise<void> {
  await page.locator(`${TAIL}[data-chat-turn="${String(turn)}"]`).waitFor({ state: 'attached' })
}

/** One settled Load earlier gesture. */
interface LoadEarlierGesture {
  /** Whether the gesture issued a `/api/session/page` request. */
  readonly paged: boolean
  /** Whether the mounted window head moved to an older resident row. */
  readonly revealed: boolean
  /** Milliseconds from the click to the settled effect and a paint. */
  readonly elapsedMs: number
}

/**
 * Poll an observed condition until it settles true.
 * @param settled - condition answered from the live page.
 * @param timeoutMs - how long the condition may take.
 * @returns whether the condition settled true within the timeout.
 */
async function waitUntil(settled: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    if (await settled()) return true
    if (performance.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/**
 * Issue one Load earlier gesture and wait for its effect. The mounted window
 * reveals resident rows before it pages the Session, so a gesture either moves
 * the window head in the click's own commit or requests a page, which the
 * control carries under its loading label until the page lands. Only a gesture
 * that requested a page reports a page latency.
 * @param page - the benchmark page.
 * @param requested - Session-history request count reader from `countHistoryPages`.
 * @returns the gesture's effect, timed from its click.
 */
async function loadEarlierGesture(page: Page, requested: () => number): Promise<LoadEarlierGesture> {
  const more = page.getByRole('button', { name: 'Load earlier', exact: true })
  const loading = page.getByRole('button', { name: 'Loading…', exact: true })
  // A page request renames the control to its loading label, so a gesture starts
  // once the previous page has landed.
  await expect.poll(async () => await loading.count() === 0, { timeout: 30_000 }).toBe(true)
  if (await more.count() === 0) return { paged: false, revealed: false, elapsedMs: 0 }
  const pages = requested()
  const head = await mountedHeadKey(page)
  const started = performance.now()
  await more.first().click()
  await waitUntil(async () => requested() > pages || await mountedHeadKey(page) !== head
    || await more.count() === 0, GESTURE_EFFECT_MS)
  const paged = requested() > pages
  if (paged) await expect.poll(async () => await loading.count() === 0, { timeout: 30_000 }).toBe(true)
  await painted(page)
  return { paged, revealed: await mountedHeadKey(page) !== head, elapsedMs: performance.now() - started }
}

async function waitForReplyMarker(page: Page, marker: string, timeout = 30000) {
  return page.waitForFunction(({ marker, first, done }) => {
    const reply = Array.from(document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')).at(-1)
    if (!reply) return false
    const text = document.createTreeWalker(reply, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = text.nextNode())) {
      if (!node.textContent?.includes(marker) || !node.parentElement?.checkVisibility({ checkVisibilityCSS: true })) continue
      const composer = Array.from(document.querySelectorAll('[data-composer-input][contenteditable="true"]')).at(-1)
      const transcript = reply.textContent ?? ''
      return { atMs: window.performance.now(), focused: document.activeElement === composer, first: transcript.includes(first), done: transcript.includes(done) }
    }
    return false
  }, { marker, first: FIRST, done: DONE }, { polling: 'raf', timeout })
}

async function watchInputOverlap(composer: Locator): Promise<void> {
  await composer.evaluate((element, markers) => {
    element.removeAttribute('data-benchmark-input-witness')
    element.removeAttribute('data-benchmark-input-overlap')
    element.removeAttribute('data-benchmark-input-timing')
    element.addEventListener('input', (event) => {
      const transcript = Array.from(document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')).at(-1)?.textContent ?? ''
      element.setAttribute('data-benchmark-input-overlap', String(event.isTrusted && transcript.includes(markers.first) && !transcript.includes(markers.done)))
      element.setAttribute('data-benchmark-input-witness', JSON.stringify({ trusted: event.isTrusted, first: transcript.includes(markers.first), done: transcript.includes(markers.done) }))
      element.setAttribute('data-benchmark-input-timing', JSON.stringify({ atMs: window.performance.now(), eventAtMs: event.timeStamp, focused: document.activeElement === element }))
    }, { once: true })
  }, { first: FIRST, done: DONE })
}

it('accepts recorded hosted open samples and rejects slower endpoints', () => {
  for (const value of [681.276514, 541.051233]) {
    expect(() => expectEndpointWithinBudget(value, ciTimeBudget(REFERENCE.open))).toThrow()
    expectEndpointWithinBudget(value, OPEN_BUDGET_MS)
  }
  const repeatedMedian = median([875.306861, 1083.683529, 814.700998])
  expect(repeatedMedian).toBe(875.306861)
  expect(() => expectEndpointWithinBudget(repeatedMedian, ciTimeBudget(REFERENCE.open))).toThrow()
  expect(() => expectEndpointWithinBudget(repeatedMedian, 875)).toThrow()
  expectEndpointWithinBudget(repeatedMedian, OPEN_BUDGET_MS)
  expect(OPEN_BUDGET_MS).toBe(1125)
  expect(() => expectEndpointWithinBudget(OPEN_BUDGET_MS + 1, OPEN_BUDGET_MS)).toThrow()
  expect(() => expectEndpointWithinBudget(2000, OPEN_BUDGET_MS)).toThrow()
})

it('accepts recorded hosted paging and Trajectory medians and rejects slower endpoints', () => {
  const endpoints = [
    { samples: [843.941625, 672.834329, 684.461818], reference: REFERENCE.page, budget: PAGE_BUDGET_MS, expectedBudget: 875 },
    { samples: [605.788061, 367.754027, 485.931656], reference: REFERENCE.trajectory, budget: TRAJECTORY_BUDGET_MS, expectedBudget: 650 },
    { samples: [630.843184, 418.578099, 635.550009], reference: REFERENCE.trajectory, budget: TRAJECTORY_BUDGET_MS, expectedBudget: 650 },
  ]
  for (const { samples, reference, budget, expectedBudget } of endpoints) {
    const value = median(samples)
    expect(() => expectEndpointWithinBudget(value, ciTimeBudget(reference))).toThrow()
    expectEndpointWithinBudget(value, budget)
    expect(budget).toBe(expectedBudget)
    expect(() => expectEndpointWithinBudget(budget + 1, budget)).toThrow()
  }
})

it('waits for visible marker text in the latest Assistant step', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`<div data-chat-flow-kind="assistant-step">${FIRST}</div><div data-chat-flow-kind="assistant-step"><span style="visibility:hidden">${FIRST}</span></div>`)
    await expect(waitForReplyMarker(page, FIRST, 100)).rejects.toThrow('Timeout')
    await page.locator('span').evaluate(element => { element.style.visibility = 'visible' })
    const observation = await waitForReplyMarker(page, FIRST)
    expect(await observation.jsonValue()).toMatchObject({ first: true, done: false })
    await observation.dispose()
    await expect(waitForReplyMarker(page, DONE, 100)).rejects.toThrow('Timeout')
  } finally {
    await browser.close()
  }
})

it('opens, pages, navigates and streams into a 240-turn browser history', async () => {
  if (webSnapshotMode() !== 'replay') throw new Error('browser benchmarks require keyless replay mode')
  const samples: { open: number; page: number; trajectory: number; first: number; streamTask: number; streamWall: number; input: number; inputOverlapped: boolean; heapMb: number; nodes: number }[] = []
  for (let sample = 0; sample < SAMPLES; sample++) {
    const failures: unknown[] = []
    const root = await mkdtemp(join(tmpdir(), 'dsh-browser-benchmark-'))
    try {
      const replayOverride = join(root, 'reply.json')
      await writeFile(replayOverride, JSON.stringify([{ kind: 'chunks', chunks: syntheticReply() }]))
      const scaffold = await launchWebScaffold({ replayFixture: join(root, 'override-only.jsonl'), replayOverride, paceMs: PACE_MS, replayContextWindow: 10000000 })
      try {
        const history = syntheticHistory()
        await seedSession(scaffold, history, SESSION_ID)
        console.log(JSON.stringify({ benchmark: 'long-session-browser/fixture', bytes: Buffer.byteLength(history) }))
        const browser = await chromium.launch({ headless: true })
        try {
          const page = await newEnglishPage(browser)
          const consoleWatch = watchConsole(page)
          page.setDefaultTimeout(30000)
          await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
          expect(new URL(page.url()).origin).toBe(scaffold.baseUrl)
          console.log(JSON.stringify({ benchmark: 'long-session-browser/server', url: scaffold.baseUrl, browser: browser.version(), sample }))
          await page.waitForSelector('[class*="frame"]')
          await page.getByRole('treeitem').first().click()
          const result = page.getByRole('treeitem').nth(1)
          await result.waitFor()
          const open = await measure(page, async () => {
            await result.click()
            await page.locator(TAIL).last().waitFor()
            await page.locator('[data-composer-input][contenteditable="true"]').last().waitFor()
          })
          const pages: number[] = []
          // Turn-tail rows the mounted window holds at open. The fork mounts at
          // most MOUNTED_ROW_LIMIT (50) resident rows
          // (`packages/client/ui-chat/src/client/chat/fork/mounted-window.ts`), so
          // this reports the window's rows, not the loaded Turn count.
          const initialTurns = await page.locator(TAIL).count()
          expect(initialTurns).toBeGreaterThan(0)
          expect(initialTurns).toBeLessThan(HISTORY_TURNS)
          // Page the whole history in. Progress is the mounted window head
          // reaching the transcript head plus the `/api/session/page` count: a
          // gesture either reveals resident rows (the head Turn falls toward
          // Turn 1) or requests a server page. Neither signal saturates the way a
          // mounted row count does, and the gesture cap fails loudly rather than
          // hanging when history stops advancing.
          const requested = countHistoryPages(page)
          let gestures = 0
          let reveals = 0
          while (!await historyHeadReached(page)) {
            if (gestures >= MAX_LOAD_EARLIER_GESTURES) {
              throw new Error('Load earlier never reached the transcript head: '
                + `${MAX_LOAD_EARLIER_GESTURES} gestures and ${pages.length} page requests left the mounted head at Turn `
                + `${String(await oldestMountedTurn(page))} of ${HISTORY_TURNS}`)
            }
            const gesture = await loadEarlierGesture(page, requested)
            gestures += 1
            if (gesture.paged) pages.push(gesture.elapsedMs)
            else if (gesture.revealed) reveals += 1
            // Neither effect: no page was left to request and no reveal moved the
            // head, so a control that still renders is inert.
            else if (!await historyHeadReached(page)) {
              throw new Error('Load earlier stopped progressing before the transcript head')
            }
          }
          // The run reached the end of history. The persistent signal is the
          // Load earlier control being gone: no Session page is left to request
          // and no resident row remains above the window head. A mounted Turn-row
          // count cannot state this, because the window holds at most its limit.
          expect(await historyHeadReached(page)).toBe(true)
          expect(pages.length).toBeGreaterThan(0)
          const trajectory = await measure(page, async () => {
            await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
            await page.getByRole('searchbox', { name: 'Search trajectory', exact: true }).waitFor()
            await page.getByRole('row').last().waitFor()
          })
          await page.getByRole('tab', { name: 'Chat', exact: true }).click()
          // The paging target's row is mounted again after the tab round trip:
          // Turn 1's turn-tail row, which the window holds once its head reached
          // the transcript head. Completeness is this row's reachability, because
          // the mounted window holds at most its row limit of Turn rows.
          await waitForTurnTailRow(page, 1)
          const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
          await composer.fill('Continue the synthetic review and summarize the validation. '.repeat(30))
          const cdp = await page.context().newCDPSession(page)
          await cdp.send('Performance.enable')
          const beforeTask = await taskMs(cdp)
          const settled = scaffold.whenTurnSettled(60000).then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          )
          await watchInputOverlap(composer)
          const started = performance.now()
          await page.keyboard.press('Enter')
          const firstMarker = await waitForReplyMarker(page, FIRST)
          const first = performance.now() - started
          // Keep focus across submission; mouse actionability must not delay the input probe.
          const input = await measure(page, async () => {
            await page.keyboard.type('next synthetic question')
            await expect.poll(() => composer.textContent()).toBe('next synthetic question')
          })
          const inputOverlapped = await composer.getAttribute('data-benchmark-input-overlap') === 'true'
          const firstObservation = await firstMarker.jsonValue()
          await firstMarker.dispose()
          console.log(JSON.stringify({ benchmark: 'long-session-browser/input', sample, first, input, firstObservation, witness: await composer.getAttribute('data-benchmark-input-witness'), inputTiming: await composer.getAttribute('data-benchmark-input-timing') }))
          expectInputOverlap(inputOverlapped)
          await (await waitForReplyMarker(page, DONE)).dispose()
          const settlement = await settled
          if (!settlement.ok) throw settlement.error
          // Completion is the new Turn's own turn-tail row being mounted at the
          // tail, not a count of HISTORY_TURNS + 1 mounted Turn rows.
          await waitForTurnTailRow(page, HISTORY_TURNS + 1)
          await painted(page)
          const streamWall = performance.now() - started
          const streamTask = await taskMs(cdp) - beforeTask
          await cdp.send('HeapProfiler.collectGarbage')
          const metrics = (await cdp.send('Performance.getMetrics')).metrics
          const heap = metrics.find(metric => metric.name === 'JSHeapUsedSize')
          if (heap === undefined) throw new Error('Chromium heap metric missing')
          samples.push({ open, page: Math.max(...pages), trajectory, first, streamTask, streamWall, input, inputOverlapped, heapMb: heap.value / 1048576, nodes: await page.locator('*').count() })
          console.log(JSON.stringify({ benchmark: 'long-session-browser/sample', sample, initialTurns, gestures, reveals, pages, ...samples.at(-1) }))
          await watchInputOverlap(composer)
          await composer.click()
          await page.keyboard.type('!')
          const lateInputOverlapped = await composer.getAttribute('data-benchmark-input-overlap') === 'true'
          expect(await composer.getAttribute('data-benchmark-input-witness')).toBe(JSON.stringify({ trusted: true, first: true, done: true }))
          expect(() => expectInputOverlap(lateInputOverlapped)).toThrow()
          expect(consoleWatch.pageErrors).toEqual([])
          expect(consoleWatch.warnings).toEqual([])
        } catch (error) { failures.push(error) } finally {
          await browser.close().catch((error: unknown) => failures.push(error))
        }
      } catch (error) { failures.push(error) } finally {
        await scaffold.close().catch((error: unknown) => failures.push(error))
      }
    } catch (error) { failures.push(error) } finally {
      await rm(root, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    }
    if (failures.length > 0) throw new AggregateError(failures, 'browser benchmark failed')
  }
  const aggregate = Object.fromEntries(Object.keys(REFERENCE).map(key => [key, median(samples.map(sample => sample[key as keyof typeof REFERENCE]))]))
  const budgets: Record<string, number> = {
    ...Object.fromEntries(Object.entries(REFERENCE).map(([key, value]) => [key, ciTimeBudget(value) + (key === 'streamWall' ? REPLAY_DURATION_MS : 0)])),
    open: OPEN_BUDGET_MS, page: PAGE_BUDGET_MS, trajectory: TRAJECTORY_BUDGET_MS,
  }
  console.log(JSON.stringify({ benchmark: 'long-session-browser/median', turns: HISTORY_TURNS, deltas: DELTAS, paceMs: PACE_MS, samples, aggregate, referenceMs: REFERENCE, expectedOpenCiMs: EXPECTED_OPEN_CI_MS, expectedPageCiMs: EXPECTED_PAGE_CI_MS, expectedTrajectoryCiMs: EXPECTED_TRAJECTORY_CI_MS, budgets }))
  for (const [key, value] of Object.entries(aggregate)) expectEndpointWithinBudget(value, budgets[key]!)
})
