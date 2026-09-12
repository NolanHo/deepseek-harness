// @vitest-environment jsdom
/** Deployment reduced-motion opt-in: stored choice, URL override, root marker. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  REDUCE_MOTION_STORAGE_KEY,
  applyReduceMotion,
  resolveReduceMotion,
} from '../src/fork/reduce-motion.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  globalThis.localStorage?.clear()
})

/** One storage stand-in whose every operation throws. */
function blockedStorage(): Storage {
  const fail = (): never => { throw new Error('storage blocked') }
  return { getItem: fail, setItem: fail, removeItem: fail, clear: fail, key: fail, length: 0 }
}

describe('resolveReduceMotion', () => {
  it('defaults to motion on without a stored choice', () => {
    expect(resolveReduceMotion('')).toBe(false)
  })

  it('stores an enabling query parameter and reapplies it later', () => {
    expect(resolveReduceMotion('?reduce-motion=1')).toBe(true)
    expect(globalThis.localStorage.getItem(REDUCE_MOTION_STORAGE_KEY)).toBe('1')
    expect(resolveReduceMotion('')).toBe(true)
  })

  it('treats a valueless parameter as enabling and clears on an explicit no', () => {
    expect(resolveReduceMotion('?reduce-motion')).toBe(true)
    expect(resolveReduceMotion('?reduce-motion=false')).toBe(false)
    expect(resolveReduceMotion('?reduce-motion=0')).toBe(false)
    expect(globalThis.localStorage.getItem(REDUCE_MOTION_STORAGE_KEY)).toBeNull()
  })

  it('ignores unrelated parameters and keeps the stored choice', () => {
    globalThis.localStorage.setItem(REDUCE_MOTION_STORAGE_KEY, '1')
    expect(resolveReduceMotion('?token=abc&panel=1')).toBe(true)
  })

  it('survives a blocked storage without persistence', () => {
    vi.stubGlobal('localStorage', blockedStorage())
    expect(resolveReduceMotion('')).toBe(false)
    expect(resolveReduceMotion('?reduce-motion=1')).toBe(true)
    expect(resolveReduceMotion('?reduce-motion=0')).toBe(false)
  })
})

describe('applyReduceMotion', () => {
  it('marks the root element only while the choice is on', () => {
    const root = document.createElement('div')
    expect(applyReduceMotion(root, '?reduce-motion=1')).toBe(true)
    expect(root.dataset.reduceMotion).toBe('true')
    expect(applyReduceMotion(root, '?reduce-motion=0')).toBe(false)
    expect(root.dataset.reduceMotion).toBeUndefined()
  })
})
