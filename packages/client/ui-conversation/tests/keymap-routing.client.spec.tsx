// @vitest-environment jsdom
/**
 * Keymap routing at the DOM boundary: synthetic keydowns on the
 * contenteditable reach the registered composer commands (the jsdom lane's
 * gesture entry, below the full component bench).
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import {
  $createParagraphNode, $createTextNode, $getRoot, createEditor, type LexicalEditor,
} from 'lexical'
import { registerPlainText } from '@lexical/plain-text'
import { registerComposerKeymap } from '../src/client/input/editor/keymap.ts'

/**
 * Mount an editor with the plain-text defaults the keymap falls through to.
 * The seeded text and caret give those defaults the RangeSelection they need:
 * jsdom owns no DOM selection of its own.
 * @returns the editor and its contenteditable root.
 */
function mountEditor(): { editor: LexicalEditor; root: HTMLDivElement } {
  const editor = createEditor({ namespace: 'keymap-routing', onError: (e) => { throw e } })
  const root = document.createElement('div')
  root.contentEditable = 'true'
  document.body.appendChild(root)
  editor.setRootElement(root)
  registerPlainText(editor)
  editor.update(() => {
    const paragraph = $createParagraphNode()
    paragraph.append($createTextNode('draft'))
    $getRoot().append(paragraph)
    paragraph.selectEnd()
  }, { discrete: true })
  return { editor, root }
}

describe('keymap keydown routing', () => {
  it('routes only the Cmd/Ctrl chord to the keymap submit handler', () => {
    const { editor, root } = mountEditor()
    const submit = vi.fn()
    registerComposerKeymap(editor, {
      arbitrate: () => 'pass',
      space: () => false,
      dismissPopup: () => {},
      canSubmit: () => true,
      submit,
      intakeFiles: () => {},
      pasteText: () => {},
    })
    fireEvent.keyDown(root, { key: 'Enter' })
    expect(submit).not.toHaveBeenCalled()
    fireEvent.keyDown(root, { key: 'Enter', metaKey: true })
    expect(submit).toHaveBeenCalledWith(true)
    fireEvent.keyDown(root, { key: 'Enter', ctrlKey: true })
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('breaks the line on plain Enter instead of submitting', async () => {
    const { editor, root } = mountEditor()
    const submit = vi.fn()
    registerComposerKeymap(editor, {
      arbitrate: () => 'pass',
      space: () => false,
      dismissPopup: () => {},
      canSubmit: () => true,
      submit,
      intakeFiles: () => {},
      pasteText: () => {},
    })
    fireEvent.keyDown(root, { key: 'Enter' })
    expect(submit).not.toHaveBeenCalled()
    // The plain-text default commits on a deferred update.
    await vi.waitFor(() => {
      expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe('draft\n')
    })
  })

  it('routes Tab through arbitration and passes when unconsumed', () => {
    const { editor, root } = mountEditor()
    const arbitrate = vi.fn<(key: string, composing: boolean) => 'consumed' | 'pick-highlighted' | 'pass'>()
      .mockReturnValueOnce('consumed')
      .mockReturnValueOnce('pick-highlighted')
      .mockReturnValue('pass')
    registerComposerKeymap(editor, {
      arbitrate,
      space: () => false,
      dismissPopup: () => {},
      canSubmit: () => true,
      submit: () => {},
      intakeFiles: () => {},
      pasteText: () => {},
    })
    const consumed = fireEvent.keyDown(root, { key: 'Tab', keyCode: 9 })
    expect(arbitrate).toHaveBeenCalledWith('tab', false)
    expect(consumed).toBe(false) // consumed: preventDefault fired
    const picked = fireEvent.keyDown(root, { key: 'Tab', keyCode: 9 })
    expect(picked).toBe(false) // picked: the completion replaces native traversal
    const passed = fireEvent.keyDown(root, { key: 'Tab', keyCode: 9 })
    expect(passed).toBe(true) // pass: the browser keeps native focus traversal
  })
})
