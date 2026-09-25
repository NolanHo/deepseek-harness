/** Legacy `settings.yaml` import: partial failures must stay retryable and literal `false`/`true` keys must normalize. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import z from '@deepseek-ai/schemastery'
import Settings from '../src/index.ts'
import { configurationFixture as fixture } from './configuration-fixture.ts'

/** One log record as the exporter receives it. */
interface LogRecord { type: string; args: readonly unknown[] }

/** One log record rendered the way the terminal exporter composes it. */
function logText(message: { args: readonly unknown[] }): string {
  return message.args.map((value) => {
    if (value instanceof Error) return value.message
    if (typeof value === 'string') return value
    return JSON.stringify(value)
  }).join(' ')
}

/** The legacy document at `path`, or undefined when the path holds no document. */
function legacyDocument(path: string): unknown { return existsSync(path) ? parse(readFileSync(path, 'utf8')) : undefined }

/** Whether any object key anywhere is the string "true"/"false" (the literal boolean-key collapse). */
function hasBooleanLevelKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasBooleanLevelKey)
  if (value === null || typeof value !== 'object') return false
  return Object.entries(value).some(([key, child]) => /^(true|false)$/i.test(key) || hasBooleanLevelKey(child))
}

it('imports every section and renames the legacy document only after the last accepted write', async () => {
  const writes: Array<{ ns: string; values: Record<string, unknown>; legacyPresent: boolean }> = []
  const logged: LogRecord[] = []
  let legacy = ''
  class RecordingSettings extends Settings {
    override async update(ns: string, values: object): Promise<void> {
      writes.push({ ns, values: structuredClone(values) as Record<string, unknown>, legacyPresent: existsSync(legacy) })
    }
  }
  const { ctx, home, start } = await fixture({ settings: RecordingSettings, logs: message => logged.push(message), hmr: false })
  await ctx.fiber.dispose()
  legacy = join(home, 'settings.yaml')
  writeFileSync(legacy, 'default-model:\n  model: legacy\nfirst:\n  count: 5\n')
  await start()
  await vi.waitFor(() => { expect(writes.map(write => write.ns)).toEqual(['default-model', 'first']) }, { timeout: 5000 })
  expect(writes.map(write => write.values)).toEqual([{ model: 'legacy' }, { count: 5 }])
  expect(writes.every(write => write.legacyPresent)).toBe(true)
  await vi.waitFor(() => { expect(existsSync(`${legacy}.imported`)).toBe(true) }, { timeout: 5000 })
  expect(existsSync(legacy)).toBe(false)
  expect(parse(readFileSync(`${legacy}.imported`, 'utf8'))).toEqual({ 'default-model': { model: 'legacy' }, first: { count: 5 } })
  expect(logged.filter(message => message.type === 'warn').map(logText).filter(text => text.includes('default-model') || text.includes('first'))).toEqual([])
}, 20_000)

it('retries a rejected section once with boolean-shaped keys mapped back to level names', async () => {
  const calls: Array<{ ns: string; values: Record<string, unknown> }> = []
  const logged: LogRecord[] = []
  class NormalizingSettings extends Settings {
    override async update(ns: string, values: object): Promise<void> {
      calls.push({ ns, values: structuredClone(values) as Record<string, unknown> })
      if (hasBooleanLevelKey(values)) throw new Error('settings/rejected: unknown level key')
    }
  }
  const { ctx, home, start } = await fixture({ settings: NormalizingSettings, logs: message => logged.push(message), hmr: false })
  await ctx.fiber.dispose()
  const path = join(home, 'settings.yaml')
  writeFileSync(path, 'first:\n  levels:\n    false: minimal\n    true: high\n')
  await start()
  await vi.waitFor(() => { expect(calls.filter(call => call.ns === 'first')).toHaveLength(2) }, { timeout: 5000 })
  expect(calls.map(call => call.values)).toEqual([
    { levels: { false: 'minimal', true: 'high' } },
    { levels: { off: 'minimal', on: 'high' } },
  ])
  await vi.waitFor(() => { expect(existsSync(`${path}.imported`)).toBe(true) }, { timeout: 5000 })
  expect(existsSync(path)).toBe(false)
  await vi.waitFor(() => {
    expect(logged.some(message => /normaliz/i.test(logText(message)) && logText(message).includes('first'))).toBe(true)
  }, { timeout: 5000 })
}, 20_000)

it('lands a normalized section in the profile patch when the updater rejects boolean-shaped keys', async () => {
  const schema = z.object({
    ordinary: z.string().required(),
    levels: z.object({ off: z.string().default('none').volatile(), on: z.string().default('none').volatile() }),
  })
  const logged: LogRecord[] = []
  const { ctx, home, profile, start } = await fixture({ schema, logs: message => logged.push(message), hmr: false })
  await ctx.fiber.dispose()
  const path = join(home, 'settings.yaml')
  writeFileSync(path, 'first:\n  levels:\n    false: minimal\n    true: high\n')
  const restored = await start()
  await vi.waitFor(() => {
    expect(restored.settings.describe().find(row => row.ns === 'first')?.value).toEqual({ levels: { off: 'minimal', on: 'high' } })
  }, { timeout: 5000 })
  const rows = parse(readFileSync(profile.patchPath, 'utf8')) as Array<{ id?: string; config?: Record<string, unknown> }>
  expect(rows.find(row => row.id === 'first')?.config).toMatchObject({ levels: { off: 'minimal', on: 'high' } })
  // The value lands before the document is renamed; wait for the consumed document, not only the value.
  await vi.waitFor(() => { expect(existsSync(path)).toBe(false) }, { timeout: 5000 })
  expect(legacyDocument(`${path}.imported`)).toEqual({ first: { levels: { false: 'minimal', true: 'high' } } })
  await vi.waitFor(() => {
    expect(logged.some(message => /normaliz/i.test(logText(message)) && logText(message).includes('first'))).toBe(true)
  }, { timeout: 5000 })
}, 20_000)

it('leaves a twice-rejected section retryable at the legacy path without re-importing successful sections', async () => {
  const calls: Array<{ ns: string; values: Record<string, unknown> }> = []
  const logged: LogRecord[] = []
  class RejectingSettings extends Settings {
    override async update(ns: string, values: object): Promise<void> {
      calls.push({ ns, values: structuredClone(values) as Record<string, unknown> })
      if (ns === 'first') throw new Error('settings/rejected')
    }
  }
  const { ctx, home, start } = await fixture({ settings: RejectingSettings, logs: message => logged.push(message), hmr: false })
  await ctx.fiber.dispose()
  const path = join(home, 'settings.yaml')
  writeFileSync(path, 'default-model:\n  model: legacy\nfirst:\n  ordinary: rejected\n')
  const restored = await start()
  await vi.waitFor(() => { expect(calls.filter(call => call.ns === 'default-model')).toHaveLength(1) }, { timeout: 5000 })
  await vi.waitFor(() => { expect(calls.some(call => call.ns === 'first')).toBe(true) }, { timeout: 5000 })
  await vi.waitFor(() => { expect(legacyDocument(path)).toEqual({ first: { ordinary: 'rejected' } }) }, { timeout: 5000 })
  expect(existsSync(`${path}.imported`)).toBe(false)
  await vi.waitFor(() => {
    expect(logged.filter(message => message.type === 'warn').map(logText).some(text => text.includes('first'))).toBe(true)
  }, { timeout: 5000 })
  // The next boot retries the rejected section; the imported one is not written twice.
  const attempts = calls.filter(call => call.ns === 'first').length
  await restored.fiber.dispose()
  await start()
  await vi.waitFor(() => { expect(calls.filter(call => call.ns === 'first').length).toBeGreaterThan(attempts) }, { timeout: 5000 })
  expect(calls.filter(call => call.ns === 'default-model')).toHaveLength(1)
  expect(legacyDocument(path)).toEqual({ first: { ordinary: 'rejected' } })
}, 20_000)

it('performs no writes and reports no import when no legacy document exists', async () => {
  const calls: string[] = []
  const logged: LogRecord[] = []
  class RecordingSettings extends Settings {
    override async update(ns: string): Promise<void> { calls.push(ns) }
  }
  const { home } = await fixture({ settings: RecordingSettings, logs: message => logged.push(message), hmr: false })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(calls).toEqual([])
  expect(existsSync(join(home, 'settings.yaml'))).toBe(false)
  expect(existsSync(join(home, 'settings.yaml.imported'))).toBe(false)
  expect(logged.map(logText).filter(text => /import|settings\.yaml/i.test(text))).toEqual([])
}, 20_000)

it.each([
  ['a scalar', 'just a string\n'],
  ['a sequence', '- one\n- two\n'],
] as const)('leaves %s document untouched instead of atomizing it into sections', async (_kind, document) => {
  const logged: LogRecord[] = []
  const { ctx, home, start } = await fixture({ logs: message => logged.push(message), hmr: false })
  await ctx.fiber.dispose()
  const path = join(home, 'settings.yaml')
  writeFileSync(path, document)
  const restored = await start()
  await vi.waitFor(() => {
    expect(logged.some(message => message.type === 'warn' && logText(message).includes('settings.yaml'))).toBe(true)
  }, { timeout: 5000 })
  expect(readFileSync(path, 'utf8')).toBe(document)
  expect(existsSync(`${path}.imported`)).toBe(false)
  expect(existsSync(`${path}.imported-sections`)).toBe(false)
  expect(existsSync(`${path}.tmp`)).toBe(false)
  // Nothing from the damaged document reached the profile.
  expect(restored.agentDefaultModel.currentSelection().model).toBe('original')
}, 20_000)

it('moves a consumed document to a free imported path instead of overwriting an earlier copy', async () => {
  const logged: LogRecord[] = []
  const { ctx, home, start } = await fixture({ logs: message => logged.push(message), hmr: false })
  await ctx.fiber.dispose()
  const path = join(home, 'settings.yaml')
  writeFileSync(`${path}.imported`, 'earlier: copy\n')
  writeFileSync(path, 'default-model:\n  model: legacy\n')
  const restored = await start()
  await vi.waitFor(() => { expect(existsSync(`${path}.imported.1`)).toBe(true) }, { timeout: 5000 })
  expect(existsSync(path)).toBe(false)
  expect(readFileSync(`${path}.imported`, 'utf8')).toBe('earlier: copy\n')
  expect(parse(readFileSync(`${path}.imported.1`, 'utf8'))).toEqual({ 'default-model': { model: 'legacy' } })
  expect(restored.agentDefaultModel.currentSelection().model).toBe('legacy')
  await vi.waitFor(() => {
    expect(logged.some(message => message.type === 'info' && logText(message).includes('.imported.1'))).toBe(true)
  }, { timeout: 5000 })
  // The import sidecar only guards a rename that has not happened; it must not survive a consumed document.
  await vi.waitFor(() => { expect(existsSync(`${path}.imported-sections`)).toBe(false) }, { timeout: 5000 })
}, 20_000)

it('does not re-import a section stored by an earlier boot while the legacy rename keeps failing', async () => {
  const logged: LogRecord[] = []
  const { ctx, home, start } = await fixture({ logs: message => logged.push(message), hmr: false })
  await ctx.fiber.dispose()
  const path = join(home, 'settings.yaml')
  writeFileSync(path, 'default-model:\n  model: legacy\n')
  // A directory at the rename target fails every boot, so the consumed document stays at the legacy path.
  mkdirSync(`${path}.imported`, { recursive: true })
  const first = await start()
  await vi.waitFor(() => { expect(existsSync(`${path}.imported-sections`)).toBe(true) }, { timeout: 5000 })
  expect(first.agentDefaultModel.currentSelection().model).toBe('legacy')
  // A form edit after the import must survive the next boot's retry of the failed rename.
  await first.settings.update('default-model', { model: 'edited' })
  await first.fiber.dispose()
  const renames = (): number => logged.filter(message => message.type === 'warn' && logText(message).includes('rename')).length
  const before = renames()
  const second = await start()
  await vi.waitFor(() => { expect(renames()).toBeGreaterThan(before) }, { timeout: 5000 })
  expect(second.agentDefaultModel.currentSelection().model).toBe('edited')
  expect(existsSync(path)).toBe(true)
}, 20_000)

it('keeps an unrelated boolean-keyed map while normalizing the level map of the same section', async () => {
  const schema = z.object({
    ordinary: z.string().required(),
    flags: z.dict(z.object({ enabled: z.boolean() })).volatile(),
    levels: z.object({ off: z.string().default('none').volatile(), on: z.string().default('none').volatile() }),
  })
  const { ctx, home, profile, start } = await fixture({ schema, hmr: false })
  await ctx.fiber.dispose()
  const path = join(home, 'settings.yaml')
  writeFileSync(path, 'first:\n  flags:\n    true:\n      enabled: true\n    false:\n      enabled: false\n  levels:\n    false: minimal\n    true: high\n')
  const restored = await start()
  await vi.waitFor(() => {
    expect(restored.settings.describe().find(row => row.ns === 'first')?.value).toMatchObject({
      flags: { true: { enabled: true }, false: { enabled: false } },
      levels: { off: 'minimal', on: 'high' },
    })
  }, { timeout: 5000 })
  const rows = parse(readFileSync(profile.patchPath, 'utf8')) as Array<{ id?: string; config?: Record<string, unknown> }>
  expect(rows.find(row => row.id === 'first')?.config).toMatchObject({ flags: { true: { enabled: true }, false: { enabled: false } } })
}, 20_000)

it.each([
  ['the level name last', 'first:\n  levels:\n    false: minimal\n    off: explicit\n'],
  ['the level name first', 'first:\n  levels:\n    off: explicit\n    false: minimal\n'],
] as const)('keeps the declared level value when a section holds both spellings (%s)', async (_order, document) => {
  const schema = z.object({
    ordinary: z.string().required(),
    levels: z.object({ off: z.string().default('none').volatile(), on: z.string().default('none').volatile() }),
  })
  const logged: LogRecord[] = []
  const { ctx, home, start } = await fixture({ schema, logs: message => logged.push(message), hmr: false })
  await ctx.fiber.dispose()
  const path = join(home, 'settings.yaml')
  writeFileSync(path, document)
  const restored = await start()
  await vi.waitFor(() => {
    expect(restored.settings.describe().find(row => row.ns === 'first')?.value).toMatchObject({ levels: { off: 'explicit' } })
  }, { timeout: 5000 })
  await vi.waitFor(() => {
    expect(logged.some(message => message.type === 'warn' && logText(message).includes('first') && logText(message).includes('false') && logText(message).includes('off'))).toBe(true)
  }, { timeout: 5000 })
}, 20_000)

it('normalizes a literal boolean key only where the schema keys a dictionary by level names', async () => {
  const levels = z.dict(z.union([z.string(), z.const(null)]), z.union(['off', 'low', 'high']))
  const schema = z.object({
    ordinary: z.string().required(),
    providers: z.dict(z.object({ reasoningEfforts: z.union([z.const(false), levels]) })).volatile(),
  })
  const { ctx, home, start } = await fixture({ schema, hmr: false })
  await ctx.fiber.dispose()
  const path = join(home, 'settings.yaml')
  writeFileSync(path, 'first:\n  providers:\n    route:\n      reasoningEfforts:\n        false: null\n        high: high\n')
  const restored = await start()
  await vi.waitFor(() => {
    expect(restored.settings.describe().find(row => row.ns === 'first')?.value).toEqual({
      providers: { route: { reasoningEfforts: { off: null, high: 'high' } } },
    })
  }, { timeout: 5000 })
  await vi.waitFor(() => { expect(existsSync(path)).toBe(false) }, { timeout: 5000 })
}, 20_000)
