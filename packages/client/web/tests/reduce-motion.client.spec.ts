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
  it('defaults to motion off without a stored choice', () => {
    expect(resolveReduceMotion('')).toBe(true)
  })

  it('keeps a clean default page motionless across reloads', () => {
    expect(resolveReduceMotion('')).toBe(true)
    expect(globalThis.localStorage.getItem(REDUCE_MOTION_STORAGE_KEY)).toBeNull()
    expect(resolveReduceMotion('?token=abc')).toBe(true)
  })

  it('stores an explicit opt-out and reapplies it later', () => {
    expect(resolveReduceMotion('?reduce-motion=0')).toBe(false)
    expect(globalThis.localStorage.getItem(REDUCE_MOTION_STORAGE_KEY)).toBe('0')
    expect(resolveReduceMotion('')).toBe(false)
    expect(resolveReduceMotion('?reduce-motion=false')).toBe(false)
  })

  it('clears the opt-out on an enabling parameter', () => {
    globalThis.localStorage.setItem(REDUCE_MOTION_STORAGE_KEY, '0')
    expect(resolveReduceMotion('?reduce-motion=1')).toBe(true)
    expect(globalThis.localStorage.getItem(REDUCE_MOTION_STORAGE_KEY)).toBeNull()
    expect(resolveReduceMotion('?reduce-motion')).toBe(true)
  })

  it('survives a blocked storage with the deployment default', () => {
    vi.stubGlobal('localStorage', blockedStorage())
    expect(resolveReduceMotion('')).toBe(true)
    expect(resolveReduceMotion('?reduce-motion=0')).toBe(false)
    expect(resolveReduceMotion('?reduce-motion=1')).toBe(true)
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
