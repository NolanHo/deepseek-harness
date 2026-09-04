// @vitest-environment jsdom
/**
 * Keymap routing at the DOM boundary: synthetic keydowns on the
 * contenteditable reach the registered composer commands (the jsdom lane's
 * gesture entry, below the full component bench).
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { createEditor } from 'lexical'
import { registerPlainText } from '@lexical/plain-text'
import { registerComposerKeymap } from '../src/client/input/editor/keymap.ts'

describe('keymap keydown routing', () => {
  const bench = () => {
    const editor = createEditor({ namespace: 'keymap-routing', onError: (e) => { throw e } })
    const root = document.createElement('div')
    root.contentEditable = 'true'
    document.body.appendChild(root)
    editor.setRootElement(root)
    registerPlainText(editor)
    return { editor, root }
  }

  const handlers = (over?: { submit?: () => void; canSubmit?: () => boolean }) => ({
    arbitrate: () => 'pass' as const,
    space: () => false,
    dismissPopup: () => {},
    canSubmit: over?.canSubmit ?? (() => true),
    submit: over?.submit ?? (() => {}),
    intakeFiles: () => {},
    pasteText: () => {},
  })

  it('routes plain Enter to the native line break and Cmd/Ctrl+Enter to submit', () => {
    const { editor, root } = bench()
    const submit = vi.fn()
    registerComposerKeymap(editor, handlers({ submit }))
    // fireEvent returns true when nothing preventDefaulted: the native
    // newline proceeds through the plain-text default.
    expect(fireEvent.keyDown(root, { key: 'Enter' })).toBe(true)
    expect(fireEvent.keyDown(root, { key: 'Enter', shiftKey: true })).toBe(true)
    expect(submit).not.toHaveBeenCalled()
    // The chord is consumed and submitted, never inverted.
    expect(fireEvent.keyDown(root, { key: 'Enter', metaKey: true })).toBe(false)
    expect(fireEvent.keyDown(root, { key: 'Enter', ctrlKey: true })).toBe(false)
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('menu arbitration consumes Enter before the chord branch', () => {
    const { editor, root } = bench()
    const submit = vi.fn()
    const arbitrate = vi.fn<(key: string, composing: boolean) => 'consumed' | 'pick-highlighted' | 'pass'>()
      .mockReturnValue('consumed')
    registerComposerKeymap(editor, { ...handlers({ submit }), arbitrate })
    expect(fireEvent.keyDown(root, { key: 'Enter' })).toBe(false)
    expect(fireEvent.keyDown(root, { key: 'Enter', metaKey: true })).toBe(false)
    expect(arbitrate).toHaveBeenCalledTimes(2)
    expect(submit).not.toHaveBeenCalled()
  })

  it('the composition guard withholds the chord without preventing the IME', () => {
    const { editor, root } = bench()
    const submit = vi.fn()
    registerComposerKeymap(editor, handlers({ submit }))
    fireEvent.compositionStart(root)
    fireEvent.keyDown(root, { key: 'Enter', metaKey: true })
    fireEvent.compositionEnd(root)
    expect(submit).not.toHaveBeenCalled()
  })

  it('routes Tab through arbitration and passes when unconsumed', () => {
    const { editor, root } = bench()
    const arbitrate = vi.fn<(key: string, composing: boolean) => 'consumed' | 'pick-highlighted' | 'pass'>()
      .mockReturnValueOnce('consumed')
      .mockReturnValueOnce('pick-highlighted')
      .mockReturnValue('pass')
    registerComposerKeymap(editor, { ...handlers(), arbitrate })
    const consumed = fireEvent.keyDown(root, { key: 'Tab', keyCode: 9 })
    expect(arbitrate).toHaveBeenCalledWith('tab', false)
    expect(consumed).toBe(false) // consumed: preventDefault fired
    const picked = fireEvent.keyDown(root, { key: 'Tab', keyCode: 9 })
    expect(picked).toBe(false) // picked: the completion replaces native traversal
    const passed = fireEvent.keyDown(root, { key: 'Tab', keyCode: 9 })
    expect(passed).toBe(true) // pass: the browser keeps native focus traversal
  })
})
