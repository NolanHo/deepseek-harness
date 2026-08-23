// @vitest-environment jsdom
// Turn fold behavior in ChatView: a settled turn's intermediate rows
// collapse behind one summary header; running turns and turns without a
// closing answer keep the fully expanded rendering. Uses the same scripted
// snapshot harness as chat-view.client.spec.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type {
  CompactionSummaryNode, ConversationSnapshot, SessionId, SessionListState, ToolResultNode,
  WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore, EMPTY_CONVERSATION_VIEWS } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatViewSlotProps, SelectionTarget } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { createChatStore } from '../src/client/stores.ts'
import { ChatView } from '../src/client/chat/ChatView.tsx'
import { zh } from '../src/client/locales.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'

afterEach(() => { cleanup() })
// Keyless create() persists under the bare declared key; clear between cases.
beforeEach(() => { localStorage.clear() })

const SID = 's1' as SessionId

function snapshotBase(): ConversationSnapshot {
  return {
    sessionId: SID, views: EMPTY_CONVERSATION_VIEWS, chat: chatSnapshotFixture(), nodes: [],
    turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [],
    pending: [], queue: [], running: false, composerPhase: 'active', removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, blank: false, subagent: null, lastAgentError: null,
  }
}

/** Scripted snapshot source mirroring the chat-view spec's fake. */
function makeSource(init?: Partial<ConversationSnapshot>) {
  const initial = { ...snapshotBase(), ...init }
  let snap: ConversationSnapshot = {
    ...initial,
    chat: init?.chat ?? chatSnapshotFixture(initial),
  }
  const subs = new Set<() => void>()
  return {
    set: (next: Partial<ConversationSnapshot>) => {
      const merged = { ...snap, ...next }
      snap = {
        ...merged,
        chat: Object.hasOwn(next, 'chat') && next.chat !== undefined
          ? next.chat
          : chatSnapshotFixture(merged, snap.chat),
      }
      for (const fn of [...subs]) fn()
    },
    source: {
      getSnapshot: () => snap,
      subscribe: (fn: () => void) => {
        subs.add(fn)
        return () => subs.delete(fn)
      },
    },
  }
}

const user = (seq: number, text: string) => ({
  kind: 'user' as const, seq, time: seq * 1_000,
  content: [{ type: 'text' as const, text }], source: null,
})
const assistant = (seq: number, text: string, turn = 1) => ({
  kind: 'assistant' as const, seq, time: seq * 1_000, turn, step: 1,
  blocks: [{ kind: 'text' as const, text }],
})
// The fixture groups rows into a Turn through a `turn` field, mirroring the
// runtime's event Location assignment; the wire node type itself omits it.
const toolResult = (seq: number, callId: string, turn = 1): ToolResultNode => ({
  kind: 'tool-result', seq, time: seq * 1_000, callId,
  call: { name: 'bash', argsRaw: `{"command":"cmd-${callId}"}` },
  callTime: seq * 1_000 - 500,
  content: [], isError: false, callView: null, resultView: null, subCalls: [],
  turn,
} as ToolResultNode & { turn: number })

function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined })
  return bindSnapshotSelector(store)
}

function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceListState>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  })
  return bindSnapshotSelector(store)
}

/** Minimal ChatView harness: only the row dispatcher is stubbed (labels per kind). */
function makeHarness(init?: Partial<ConversationSnapshot>) {
  const { set, source } = makeSource(init)
  const openFile = vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined)
  const loadOlder = vi.fn()
  const inspectCall = vi.fn<(callId: string) => void>()
  let savedScroll: ReturnType<ChatViewSlotProps['chatScroll']['read']> = null
  const chatScroll: ChatViewSlotProps['chatScroll'] = {
    save: (position) => { savedScroll = position },
    read: () => savedScroll,
  }
  const chat = createChatStore().create()
  const t = makeTranslate(zh, commonZh)
  // Row dispatcher: one text label per node, plus tool-call ids, so the
  // specs assert user-visible content and DOM presence, not class names.
  const renderSlot = ((key: string, owner: object, opts?: {
    fallback?: React.ReactNode
    hookContext?: unknown
  }) => {
    if (key !== 'conversation.chat.node') return opts?.fallback ?? null
    const node = (owner as { node: { kind: string; data: unknown } }).node
    switch (node.kind) {
      case 'user':
      case 'steering':
        return <div>{(node.data as { content: { text: string }[] }).content[0]?.text ?? ''}</div>
      case 'assistant-step':
        return <div>{(node.data as { blocks: { text?: string }[] }).blocks[0]?.text ?? ''}</div>
      case 'tool-call':
        return <div data-testid={`tool-${(node.data as { root: { callId: string } }).root.callId}`} />
      case 'turn-tail':
        return <div data-testid="turn-tail" />
      default:
        return <div data-testid={`row-${node.kind}`} />
    }
  }) as unknown as ChatViewSlotProps['renderSlot']
  const SessionProviderStub: ChatViewSlotProps['SessionProvider'] = ({ children }) => <>{children(SID)}</>
  const props: ChatViewSlotProps = {
    sessionId: SID,
    useSession: bindSnapshotSelector(source),
    useSessions: emptySessions(),
    useWorkspaces: emptyWorkspaces(),
    useProjection: (() => undefined),
    useInput: (() => { throw new Error('unused') }),
    inputActions: {
      setDraft: () => {}, addImages: () => true, removeImage: () => {}, pruneImages: () => {}, submit: () => {},
    },
    useStore: bindSnapshotSelector(chat),
    actions: chat.actions,
    renderSlot,
    SessionProvider: SessionProviderStub,
    openDetails: vi.fn<(target: SelectionTarget) => void>(),
    openFile,
    loadOlder,
    loadImage: vi.fn(() => Promise.reject(new Error('not used'))),
    inspectCall,
    chatScroll,
    forkAt: vi.fn(),
    fileMentions: () => undefined,
    t,
  }
  return { set, ChatView, props }
}

describe('ChatView turn fold', () => {
  it('collapses a settled turn\'s intermediate rows behind one summary header', () => {
    const h = makeHarness({
      nodes: [
        user(1, 'do the thing'),
        toolResult(2, 'a'),
        toolResult(3, 'b'),
        assistant(4, 'mid narration'),
        assistant(5, 'final answer'),
      ],
      turnTimings: new Map([[1, { startTime: 1_000, endTime: 4_000 }]]),
      turnEnds: new Map([[1, 6]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    // Summary row: 2 tool calls, 1 intermediate reply, 3s duration.
    expect(view.getByRole('button', { name: '展开或折叠本轮过程' }).textContent)
      .toBe('已折叠 2 次工具调用 · 1 条中间回复 · 3秒')
    // Kept rows: user, closing answer, turn-tail.
    expect(view.getByText('do the thing')).toBeTruthy()
    expect(view.getByText('final answer')).toBeTruthy()
    expect(view.getByTestId('turn-tail')).toBeTruthy()
    // Folded rows are absent from the DOM entirely.
    expect(view.queryByTestId('tool-a')).toBeNull()
    expect(view.queryByTestId('tool-b')).toBeNull()
    expect(view.queryByText('mid narration')).toBeNull()
    // The header carries the first hidden row's anchor identity.
    const header = view.getByRole('button', { name: '展开或折叠本轮过程' })
    expect(header.closest('[data-chat-anchor-key]')?.getAttribute('data-chat-anchor-key'))
      .toBe('fixture:tool:a')
  })

  it('expands on header click and re-collapses on the next click', () => {
    const h = makeHarness({
      nodes: [user(1, 'go'), toolResult(2, 'a'), assistant(3, 'final answer')],
      turnTimings: new Map([[1, { startTime: 1_000, endTime: 2_000 }]]),
      turnEnds: new Map([[1, 4]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    const header = view.getByRole('button', { name: '展开或折叠本轮过程' })
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(header.textContent).toBe('已折叠 1 次工具调用 · 1秒')
    act(() => { fireEvent.click(header) })
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByTestId('tool-a')).toBeTruthy()
    act(() => { fireEvent.click(header) })
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByTestId('tool-a')).toBeNull()
    expect(screen.queryByTestId('tool-a')).toBeNull()
  })

  it('keeps a running turn fully expanded with no fold header', () => {
    const h = makeHarness({
      running: true,
      nodes: [user(1, 'go'), toolResult(2, 'a'), assistant(3, 'narration')],
      turnTimings: new Map([[1, { startTime: 1_000 }]]),
      turnEnds: new Map(),
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.queryByRole('button', { name: '展开或折叠本轮过程' })).toBeNull()
    expect(view.getByTestId('tool-a')).toBeTruthy()
    expect(view.getByText('narration')).toBeTruthy()
  })

  it('leaves a settled turn without a closing answer unchanged', () => {
    // turn-error terminal: closing stays null, so every row renders.
    const h = makeHarness({
      nodes: [
        user(1, 'go'),
        toolResult(2, 'a'),
        { kind: 'turn-error', seq: 3, time: 3_000, turn: 1, step: 0, message: 'boom' },
      ],
      turnTimings: new Map([[1, { startTime: 1_000, endTime: 3_000 }]]),
      turnEnds: new Map([[1, 3]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.queryByRole('button', { name: '展开或折叠本轮过程' })).toBeNull()
    expect(view.getByTestId('tool-a')).toBeTruthy()
    expect(view.getByText('go')).toBeTruthy()
  })

  it('renders every row of a settled turn that has nothing foldable', () => {
    // Only the user row and the closing answer: no fold header, no hidden rows.
    const h = makeHarness({
      nodes: [user(1, 'go'), assistant(3, 'final answer')],
      turnTimings: new Map([[1, { startTime: 1_000, endTime: 2_000 }]]),
      turnEnds: new Map([[1, 4]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.queryByRole('button', { name: '展开或折叠本轮过程' })).toBeNull()
    expect(view.getByText('go')).toBeTruthy()
    expect(view.getByText('final answer')).toBeTruthy()
    expect(view.getByTestId('turn-tail')).toBeTruthy()
  })

  it('falls back to the generic label when only uncounted kinds are folded', () => {
    const h = makeHarness({
      nodes: [
        user(1, 'go'),
        { kind: 'compaction', seq: 2, time: 2_000, summary: 's', summaryEventSeq: 2, shadowedItemCount: 1, shadowedTokenCount: 1, turn: 1 } as CompactionSummaryNode & { turn: number },
        assistant(3, 'final answer'),
      ],
      turnTimings: new Map([[1, { startTime: 1_000, endTime: 2_000 }]]),
      turnEnds: new Map([[1, 4]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByRole('button', { name: '展开或折叠本轮过程' }).textContent).toBe('已折叠 1 条过程')
  })

  it('withholds the fold duration when a turn boundary is outside the window', () => {
    const h = makeHarness({
      nodes: [user(1, 'go'), toolResult(2, 'a'), assistant(3, 'final answer')],
      turnEnds: new Map([[1, 4]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByRole('button', { name: '展开或折叠本轮过程' }).textContent).toBe('已折叠 1 次工具调用')
  })

  it('folds the turn automatically once it settles', () => {
    const h = makeHarness({
      running: true,
      nodes: [user(1, 'go'), toolResult(2, 'a'), assistant(3, 'final answer')],
      turnTimings: new Map([[1, { startTime: 1_000 }]]),
      turnEnds: new Map(),
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByTestId('tool-a')).toBeTruthy()
    act(() => {
      h.set({ running: false, turnTimings: new Map([[1, { startTime: 1_000, endTime: 2_000 }]]), turnEnds: new Map([[1, 4]]) })
    })
    expect(view.queryByTestId('tool-a')).toBeNull()
    expect(view.getByText(/已折叠 1 次工具调用/)).toBeTruthy()
  })
})
