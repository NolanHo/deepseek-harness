// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locale.ts'
import { AssistantMarkdown, type AssistantMarkdownProps } from '../src/client/chat/AssistantMarkdown.tsx'

afterEach(() => {
  cleanup()
})

const t = makeTranslate(zh, commonZh)
const renderMessageImages: AssistantMarkdownProps['renderMessageImages'] = () => null

function renderReasoning(text: string, streaming: boolean) {
  return render(
    <AssistantMarkdown
      t={t}
      blocks={[{ kind: 'reasoning', text }]}
      streaming={streaming}
      renderMessageImages={renderMessageImages}
    />,
  )
}

describe('ReasoningRow', () => {
  it('collapsed row carries the reasoning character count instead of its text', () => {
    const text = 'Inspect the session\nNewest reasoning tokens'
    const view = renderReasoning(text, false)

    expect(view.getByText(`${text.length} 字符`)).toBeTruthy()
    expect(view.queryByText('Inspect the session')).toBeNull()
    expect(view.queryByText(/Newest reasoning tokens/)).toBeNull()
  })

  it('groups long counts and follows the streaming length, dropping the running status at settlement', () => {
    const view = renderReasoning('x'.repeat(1_234), true)
    expect(view.getByText('1,234 字符')).toBeTruthy()
    expect(view.getByText('运行中')).toBeTruthy()

    view.rerender(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'x'.repeat(1_234_567) }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.getByText('1,234,567 字符')).toBeTruthy()

    view.rerender(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'x'.repeat(1_234_567) }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.queryByText('运行中')).toBeNull()
  })

  it('expands from either Think or the character count', () => {
    const text = 'Inspect the session\nCheck persistence'
    const view = renderReasoning(text, false)
    const row = view.getByRole('button')

    fireEvent.click(view.getByText(`${text.length} 字符`))
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText(/Check persistence/)).toBeTruthy()

    fireEvent.click(view.getByText('思考'))
    expect(row.getAttribute('aria-expanded')).toBe('false')
  })

  it('expanded Think renders the complete text verbatim, no IN card', () => {
    const text = '**Comparing checkout and merge bases**\nKeep **reviewing**'
    const view = renderReasoning(text, false)

    fireEvent.click(view.getByText('思考'))
    expect(view.getAllByText(/Comparing checkout and merge bases/)).toHaveLength(1)
    expect(view.container.querySelector('[class*="thinkBody"]')?.textContent).toBe(text)
    expect(view.queryByText('IN')).toBeNull()
    expect(view.container.querySelector('[class*="ioCard"]')).toBeNull()
  })
})
