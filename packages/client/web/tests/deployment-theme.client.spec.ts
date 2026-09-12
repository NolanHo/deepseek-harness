// @vitest-environment jsdom
/** Deployment theme: stored choice, URL override, root marker. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  THEME_MARKER,
  THEME_STORAGE_KEY,
  applyTheme,
  resolveTheme,
} from '../src/fork/deployment-theme.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  globalThis.localStorage?.clear()
})

/** One storage stand-in whose every operation throws. */
function blockedStorage(): Storage {
  const fail = (): never => { throw new Error('storage blocked') }
  return { getItem: fail, setItem: fail, removeItem: fail, clear: fail, key: fail, length: 0 }
}

describe('resolveTheme', () => {
  it('defaults to the deployment palette without a stored choice', () => {
    expect(resolveTheme('')).toBe(THEME_MARKER)
  })

  it('keeps a clean default page on the palette across reloads', () => {
    expect(resolveTheme('')).toBe(THEME_MARKER)
    expect(globalThis.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
    expect(resolveTheme('?token=abc')).toBe(THEME_MARKER)
  })

  it('stores an explicit opt-out and reapplies it later', () => {
    expect(resolveTheme('?theme=default')).toBe('default')
    expect(globalThis.localStorage.getItem(THEME_STORAGE_KEY)).toBe('default')
    expect(resolveTheme('')).toBe('default')
    expect(resolveTheme('?theme=false')).toBe('default')
  })

  it('clears the opt-out on a palette parameter', () => {
    globalThis.localStorage.setItem(THEME_STORAGE_KEY, 'default')
    expect(resolveTheme('?theme=harbor')).toBe(THEME_MARKER)
    expect(globalThis.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
    expect(resolveTheme('?theme')).toBe(THEME_MARKER)
  })

  it('survives a blocked storage with the deployment default', () => {
    vi.stubGlobal('localStorage', blockedStorage())
    expect(resolveTheme('')).toBe(THEME_MARKER)
    expect(resolveTheme('?theme=default')).toBe('default')
    expect(resolveTheme('?theme=harbor')).toBe(THEME_MARKER)
  })
})

describe('applyTheme', () => {
  it('marks the root element only while the palette is on', () => {
    const root = document.createElement('div')
    expect(applyTheme(root, '?theme=harbor')).toBe(THEME_MARKER)
    expect(root.dataset.dshTheme).toBe(THEME_MARKER)
    expect(applyTheme(root, '?theme=default')).toBe('default')
    expect(root.dataset.dshTheme).toBeUndefined()
  })
})
