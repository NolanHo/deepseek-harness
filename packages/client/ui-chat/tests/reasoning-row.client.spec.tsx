// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locale.ts'
import { AssistantMarkdown, type AssistantMarkdownProps } from '../src/client/chat/AssistantMarkdown.tsx'
import { useDetailedPresentation } from './presentation-fixture.client.ts'
import { ReasoningRow } from '../src/client/chat/ReasoningRow.tsx'
import { bindDisclosure, useDisclosure } from '../src/client/chat/use-disclosure.ts'

afterEach(() => {
  cleanup()
})

const t = makeTranslate(zh, commonZh)
const renderMessageImages: AssistantMarkdownProps['renderMessageImages'] = () => null

function renderReasoning(text: string, streaming: boolean, reasoningSpans?: AssistantMarkdownProps['reasoningSpans']) {
  return render(
    <AssistantMarkdown
      useDisclosure={useDisclosure}
      usePresentation={useDetailedPresentation}
      t={t}
      blocks={[{ kind: 'reasoning', text }]}
      streaming={streaming}
      reasoningSpans={reasoningSpans}
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

  it('appends the recorded stream duration only once the block stops running', () => {
    const text = 'Inspect the session\nNewest reasoning tokens'
    const view = renderReasoning(text, true, [[5_000, 17_345]])
    expect(view.getByText(`${text.length} 字符`)).toBeTruthy()

    view.rerender(
      <AssistantMarkdown
        useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'reasoning', text }]}
        streaming={false}
        reasoningSpans={[[5_000, 17_345]]}
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.getByText(`${text.length} 字符 · 12.3秒`)).toBeTruthy()
  })

  it('omits the duration when the attempt recorded no reasoning span', () => {
    const view = renderReasoning('x'.repeat(1_234), false)

    expect(view.getByText('1,234 字符')).toBeTruthy()
    expect(view.queryByText(/字符 ·/)).toBeNull()
  })

  it('groups long counts and follows the streaming length, dropping the running status at settlement', () => {
    const view = renderReasoning('x'.repeat(1_234), true)
    expect(view.getByText('1,234 字符')).toBeTruthy()
    expect(view.getByText('运行中')).toBeTruthy()

    view.rerender(
      <AssistantMarkdown
        useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'reasoning', text: 'x'.repeat(1_234_567) }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.getByText('1,234,567 字符')).toBeTruthy()

    view.rerender(
      <AssistantMarkdown
        useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'reasoning', text: 'x'.repeat(1_234_567) }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.queryByText('运行中')).toBeNull()
  })

  it('keeps the collapsed count and expanded Markdown when the enclosing Turn resets disclosures', () => {
    const reset = createSnapshotStore(0)
    const useDisclosure = bindDisclosure(reset)
    const text = 'First line\n\nDetailed body'
    const view = render(<ReasoningRow useDisclosure={useDisclosure} text={text} running={false} t={t} />)
    const root = view.container.querySelector('[data-variant="think"]')!
    const summary = view.getByText(`${text.length} 字符`)
    const toggle = view.getByRole('button')
    expect(root.hasAttribute('data-preview')).toBe(true)
    expect(root.querySelector('[data-markdown-variant]')).toBeNull()

    fireEvent.click(toggle)
    const body = view.getByText('Detailed body')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(root.hasAttribute('data-preview')).toBe(false)

    act(() => { reset.set(1) })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByText('Detailed body')).toBeNull()
    expect(view.getByRole('button')).toBe(toggle)
    expect(view.getByText(`${text.length} 字符`)).toBe(summary)
    expect(body).toBeTruthy()
  })

  it.each([
    { kind: 'text' as const, text: 'Answer' },
    { kind: 'tool-call' as const, callId: 'call-1', name: 'read', argsRaw: '{}' },
  ])('starts collapsed and preserves manual expansion when $kind arrives', (nextBlock) => {
    const reasoning = { kind: 'reasoning' as const, text: 'Inspect the session\nCheck persistence' }
    const view = render(
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t} blocks={[reasoning]} streaming renderMessageImages={renderMessageImages} />,
    )
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(view.getByText('思考'))
    view.rerender(
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t} blocks={[reasoning, nextBlock]} streaming renderMessageImages={renderMessageImages} />,
    )
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('true')
    view.rerender(
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t} blocks={[reasoning, nextBlock]} streaming={false} renderMessageImages={renderMessageImages} />,
    )
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText(/Check persistence/)).toBeTruthy()
    fireEvent.click(view.getByText('思考'))
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })

  it.each([
    {
      label: 'settled',
      text: '**Comparing checkout and merge bases**\nKeep **reviewing**',
      streaming: false,
    },
    {
      label: 'streaming',
      text: 'Inspect the session\n\n**Comparing checkout and merge bases**\n',
      streaming: true,
    },
  ])('keeps the prose out of the $label collapsed count and renders body emphasis', ({ text, streaming }) => {
    const view = render(
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'reasoning', text }]}
        streaming={streaming}
        renderMessageImages={renderMessageImages}
      />,
    )

    expect(view.getByText(`${text.length} 字符`)).toBeTruthy()
    expect(view.queryByText('**Comparing checkout and merge bases**')).toBeNull()

    fireEvent.click(view.getByText('思考'))
    expect(view.getByText('Comparing checkout and merge bases').tagName).toBe('STRONG')
    expect(view.container.querySelector('[class*="thinkBody"]')?.textContent).not.toContain('**')
  })

  it('keeps heading syntax out of the collapsed count and renders compact headings when expanded', () => {
    const text = Array.from({ length: 6 }, (_, index) => `${'#'.repeat(index + 1)} Section ${index + 1}`)
      .join('\n\n') + '\n\nReasoning body.'
    const view = render(
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'reasoning', text }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.getByText(`${text.length} 字符`)).toBeTruthy()
    expect(view.queryByRole('heading')).toBeNull()

    fireEvent.click(view.getByText('思考'))
    const compact = view.container.querySelector('[data-markdown-variant="compact"]')
    expect(compact).not.toBeNull()
    expect(compact?.querySelectorAll('h1, h2, h3, h4, h5, h6')).toHaveLength(6)
    expect(compact?.querySelector('p')?.textContent).toBe('Reasoning body.')

    fireEvent.click(view.getByText('思考'))
    expect(view.getByText(`${text.length} 字符`)).toBeTruthy()
    expect(view.queryByRole('heading')).toBeNull()
  })

  it('keeps completed reasoning blocks mounted while the open streaming tail grows', () => {
    const first = '## Investigation\n\n**Check persistence**\n\n'
    const view = render(
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'reasoning', text: first }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    fireEvent.click(view.getByText('思考'))
    const heading = view.getByRole('heading', { name: 'Investigation' })
    const emphasis = view.getByText('Check persistence')
    const text = first + Array.from({ length: 8 }, (_, index) => `Paragraph ${index}.`).join('\n\n')
    view.rerender(
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'reasoning', text }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.getByRole('heading', { name: 'Investigation' })).toBe(heading)
    expect(view.getByText('Check persistence')).toBe(emphasis)
    expect(view.container.querySelector('[class*="thinkBody"]')?.textContent).not.toContain('##')
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

  it('expanded Think drops the inline summary and renders prose without an IN card', () => {
    const view = render(
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nCheck persistence' }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    fireEvent.click(view.getByText('思考'))
    expect(view.getAllByText(/Inspect the session/)).toHaveLength(1)
    expect(view.queryByText('IN')).toBeNull()
    expect(view.container.querySelector('[class*="ioCard"]')).toBeNull()
    expect(view.container.querySelector('[class*="thinkBody"]')).not.toBeNull()
  })

  it('anchors the sticky-header selector: only an open Think row nests the disclosure row under data-expanded and data-open', () => {
    const view = render(
      <AssistantMarkdown useDisclosure={useDisclosure}
        usePresentation={useDetailedPresentation}
        t={t}
        blocks={[
          { kind: 'reasoning', text: 'Inspect the session\nCheck persistence' },
          { kind: 'text', text: 'Answer' },
        ]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    // Collapsed: no `data-open`, so the sticky rule's gate never matches.
    expect(view.container.querySelector('[data-variant="think"] [data-open]')).toBeNull()
    fireEvent.click(view.getByText('思考'))
    expect(
      view.container.querySelector(
        '[data-variant="think"][data-expanded] [data-open] [data-disclosure-row]',
      ),
    ).not.toBeNull()
  })
})
