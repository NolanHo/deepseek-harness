// @vitest-environment jsdom
//
// Fold-anchor invariant for the fork-owned transcript window.
//
// A folded Turn is a closed Turn rendered with `foldCompletedTurns` on, no
// interleaved input, and no open disclosure; its control key `c` is its
// resident `turn-process` row and its hidden set `H` is the Turn's
// non-independent resident rows from `processStartSeq` to `answerAnchorSeq`
// (or to the Turn's end when no finalized answer exists).
//
// Property P: for every plan `p` and every folded Turn `(c, H)`,
//   (H ∩ keys(p) ≠ ∅)  ⟹  c ∈ keys(p)  ∧  mount(c) ∈ entries(p).
//
// `keys(p)` is exactly the set of resident keys the mounted entries may
// render, so a hidden key inside it is a mounted row the fold keeps hidden;
// without the control in the same plan that row is unreachable and the
// transcript can render no content at all. This suite states P, sweeps every
// window state, and pins each fork-side bound that could break it.

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { GroupKey, NodeKey, RenderEntry } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  AssistantMessageNode, ChatSnapshot, ConversationNode, ProcessGroupData,
  SteeringMessageNode, ToolResultNode, UserMessageNode,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ChatNode } from '../src/client/contract/chat-nodes.ts'
import { TURN_PROCESS_INDEPENDENT_KINDS, turnProcessAlwaysOpen } from '../src/client/contract/turn-process.ts'
import {
  planMountedWindow, useMountedWindow,
  type MountedWindowPlan, type MountWindow,
} from '../src/client/chat/fork/mounted-window.ts'
import { ChatSnapshotBuilder } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'
import { ProcessState } from '../src/client/conversation-nodes/process-groups.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'
import { ConversationGroupStore } from '../../ui-conversation/src/client/conversation/group-store.ts'

afterEach(cleanup)

const node = (key: string): RenderEntry => ({ kind: 'node', key: key as NodeKey })
const group = (key: string): RenderEntry => ({ kind: 'group', key: key as GroupKey })

/** Resident keys `prefix0`…`prefix{count-1}`. */
function keys(count: number, prefix = 'k'): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`)
}

/**
 * One folded Turn: its control key and the resident keys the fold hides. A
 * hidden key that a plan carries must come with the control in the same plan.
 */
interface FoldedTurn {
  readonly control: string
  readonly hidden: readonly string[]
}

/**
 * Property: every hidden member row a plan can render has its Turn's control
 * mounted in the same plan. The control renders as its own node entry, so a
 * control key in `plan.keys` is that entry mounted; both facts are asserted.
 * @param plan - planned window.
 * @param folds - folded Turns of the tested session.
 * @returns human-readable violations, empty when the invariant holds.
 */
function anchorViolations(plan: MountedWindowPlan, folds: readonly FoldedTurn[]): string[] {
  const violations: string[] = []
  for (const fold of folds) {
    if (!fold.hidden.some(key => plan.keys.has(key))) continue
    if (!plan.keys.has(fold.control)) violations.push(`${fold.control}: hidden members mount without the control key`)
    if (!plan.entries.some(entry => entry.kind === 'node' && entry.key === fold.control)) {
      violations.push(`${fold.control}: control entry is not mounted`)
    }
  }
  return violations
}

/**
 * A Turn's run starts at its control, so the resident keys after the control up
 * to the next control are exactly the keys its fold hides.
 * @param order - resident keys.
 * @param controls - resident indices of the controls.
 * @returns one folded Turn per control.
 */
function contiguousFolds(order: readonly string[], controls: readonly number[]): FoldedTurn[] {
  return controls.map((control, at) => {
    const end = controls[at + 1] ?? order.length
    return { control: order[control] as string, hidden: order.slice(control + 1, end) }
  })
}

/** Control layouts a sweep tests for one order length. */
function controlLayouts(length: number): number[][] {
  const layouts: number[][] = [[]]
  if (length > 0) layouts.push([0])
  if (length > 1) layouts.push([0, 1])
  if (length > 3) layouts.push([0, Math.floor(length / 2)])
  if (length > 4) layouts.push([Math.max(0, length - 3)])
  if (length > 9) layouts.push([2, 5, Math.min(8, length - 1)])
  return layouts
}

/** Every window state over one order: the tail plus a frozen head at each key. */
function windowStates(order: readonly string[]): MountWindow[] {
  return [{ kind: 'tail' }, ...order.map(key => ({ kind: 'frozen' as const, head: key }))]
}

describe('fold-anchor invariant', () => {
  it('holds across every order length, head, control layout, stub state, and reader row', () => {
    let exercised = 0
    for (const length of [0, 1, 2, 7, 49, 50, 51, 60, 121]) {
      const order = keys(length)
      const entries = order.map(node)
      for (const controls of controlLayouts(length)) {
        const folds = contiguousFolds(order, controls)
        for (const window of windowStates(order)) {
          for (const stub of [false, true]) {
            const plan = planMountedWindow(entries, order, window, stub, controls)
            expect(anchorViolations(plan, folds), `length=${length} controls=[${controls.join(',')}] stub=${stub}`).toEqual([])
            if (folds.some(fold => fold.hidden.some(key => plan.keys.has(key)))) exercised += 1
          }
        }
      }
    }
    // Guard against a sweep that proves nothing: some plan must actually carry
    // folded member rows for the invariant to have content.
    expect(exercised).toBeGreaterThan(0)
    // Reader rows: the hook derives a frozen head from a row at every index, so
    // the clamp's own window selection is inside the sweep too.
    const order = keys(130)
    const controls = [0, 60]
    const folds = contiguousFolds(order, controls)
    const { result, rerender } = renderHook(
      (props: Parameters<typeof useMountedWindow>[0]) => useMountedWindow(props),
      {
        initialProps: {
          entries: order.map(node), order, controls,
          followingTail: false, anchorKey: order[0] as string, running: false,
        },
      },
    )
    for (let index = 0; index < order.length; index++) {
      rerender({
        entries: order.map(node), order, controls,
        followingTail: false, anchorKey: order[index] as string, running: false,
      })
      expect(anchorViolations(result.current, folds), `reader row k${index}`).toEqual([])
    }
  })

  it('holds for group entries whose member run crosses every window head', () => {
    // One folded Turn of 90 members rendered as a single group block, with a
    // visible answer after it: the block mounts whole while any member is in the
    // window, and the group seat filters members by the plan's key set.
    const order = keys(92)
    const entries = [node('k0'), group('g'), node('k91')]
    const folds: FoldedTurn[] = [{ control: 'k0', hidden: order.slice(1, 91) }]
    let exercised = 0
    for (const window of windowStates(order)) {
      for (const stub of [false, true]) {
        const plan = planMountedWindow(entries, order, window, stub, [0])
        expect(anchorViolations(plan, folds), `head=${String(plan.headKey)} stub=${stub}`).toEqual([])
        if (folds[0]!.hidden.some(key => plan.keys.has(key))) exercised += 1
      }
    }
    expect(exercised).toBeGreaterThan(0)
  })
})

describe('fork-side bound: MOUNTED_ROW_LIMIT slice', () => {
  it('mounts the fold control when the tail slice starts inside its Turn', () => {
    const order = keys(120)
    const plan = planMountedWindow(order.map(node), order, { kind: 'tail' }, false, [0])
    expect(plan.headKey).toBe('k70')
    expect(plan.keys.has('k0')).toBe(true)
    expect(plan.entries.some(entry => entry.kind === 'node' && entry.key === 'k0')).toBe(true)
    expect(anchorViolations(plan, contiguousFolds(order, [0]))).toEqual([])
  })

  it('mounts the control beside the hidden rows and the visible answer', () => {
    // The dirty Turn's control is k0; its hidden rows k1..k99 and its visible
    // answer k100 all sit in the tail slice. The control still mounts above it.
    const order = keys(130)
    const folds: FoldedTurn[] = [{ control: 'k0', hidden: keys(130).slice(1, 100) }]
    const plan = planMountedWindow(order.map(node), order, { kind: 'tail' }, false, [0])
    expect(plan.keys.has('k0')).toBe(true)
    expect(plan.keys.has('k100')).toBe(true)
    expect(anchorViolations(plan, folds)).toEqual([])
  })
})

describe('fork-side bound: tail versus frozen windows', () => {
  it('mounts each head Turn control with the frozen window it governs', () => {
    const order = keys(121)
    const folds = contiguousFolds(order, [0, 60])
    for (const window of windowStates(order)) {
      const plan = planMountedWindow(order.map(node), order, window, false, [0, 60])
      expect(anchorViolations(plan, folds), `head=${String(plan.headKey)}`).toEqual([])
    }
  })

  it('keeps a resident head control that sits above the frozen slice', () => {
    const order = keys(121)
    // The frozen window starts at k65, inside the second Turn whose control k60
    // sits five keys above the head.
    const plan = planMountedWindow(order.map(node), order, { kind: 'frozen', head: 'k65' }, false, [0, 60])
    expect(plan.headKey).toBe('k65')
    expect(plan.keys.has('k60')).toBe(true)
    expect(anchorViolations(plan, contiguousFolds(order, [0, 60]))).toEqual([])
  })
})

describe('fork-side bound: tail stub', () => {
  it('mounts the control of the Turn the newest slice holds', () => {
    // A frozen reader sits in Turn Z (k0 control, k1..k60 rows). Turn A is a
    // folded Turn of 80 members whose control k61 is above the newest slice
    // (tail head k103), and Turn B is the live Turn at the tail. The stub's
    // slice carries A's members, so A's control must mount beside them.
    const order = keys(153)
    const plan = planMountedWindow(order.map(node), order, { kind: 'frozen', head: 'k1' }, true, [0, 61, 142])
    expect(plan.keys.has('k103')).toBe(true)
    expect(plan.keys.has('k61')).toBe(true)
    expect(plan.entries.some(entry => entry.kind === 'node' && entry.key === 'k61')).toBe(true)
  })

  it('holds the invariant in every stub state a fold reaches', () => {
    const order = keys(153)
    const folds = contiguousFolds(order, [0, 61, 142])
    for (const head of ['k0', 'k1', 'k30', 'k61', 'k104', 'k152']) {
      const plan = planMountedWindow(order.map(node), order, { kind: 'frozen', head }, true, [0, 61, 142])
      expect(anchorViolations(plan, folds), `head=${head}`).toEqual([])
    }
  })
})

describe('fork-side bound: group seats and collapsed cards', () => {
  it('mounts the control for group-filtered member rows', () => {
    const order = keys(92)
    const entries = [node('k0'), group('g'), node('k91')]
    const plan = planMountedWindow(entries, order, { kind: 'tail' }, false, [0])
    // The group block mounts while any member is in the window; its rendered
    // rows are the member keys the plan carries.
    expect(plan.entries.some(entry => entry.kind === 'group' && entry.key === 'g')).toBe(true)
    expect(anchorViolations(plan, [{ control: 'k0', hidden: order.slice(1, 91) }])).toEqual([])
  })

  it('mounts the control over the group block tailBlocks carries into the stub slice', () => {
    // The frozen reader sits at k1 and the newest slice starts at k103, inside
    // a single 80-member group block headed from k61: the tail walk mounts the
    // block while the control k61 sits above the slice.
    const order = keys(153)
    const entries = [node('k0'), node('k61'), group('g'), node('k142')]
    const plan = planMountedWindow(entries, order, { kind: 'frozen', head: 'k1' }, true, [0, 61, 142])
    expect(plan.entries.some(entry => entry.kind === 'group' && entry.key === 'g')).toBe(true)
    expect(plan.keys.has('k61')).toBe(true)
  })

  it('mounts the control for a tool-card row inside a frozen window', () => {
    const order = ['control', ...keys(80, 'tool'), 'answer']
    const plan = planMountedWindow(order.map(node), order, { kind: 'frozen', head: 'tool40' }, false, [0])
    expect(plan.keys.has('control')).toBe(true)
    expect(anchorViolations(plan, [{ control: 'control', hidden: keys(80, 'tool') }])).toEqual([])
  })
})

describe('fork-side bound: reader row clamp and reveal path', () => {
  function hookInput(anchorKey: string | null): Parameters<typeof useMountedWindow>[0] {
    const order = keys(130)
    return {
      entries: order.map(node), order, controls: [0, 60],
      followingTail: anchorKey === null, anchorKey, running: false,
    }
  }

  it('holds along the reveal path while the reader row stays mounted', () => {
    const order = keys(130)
    const folds = contiguousFolds(order, [0, 60])
    const { result } = renderHook(
      (props: Parameters<typeof useMountedWindow>[0]) => useMountedWindow(props),
      { initialProps: hookInput(order[70] as string) },
    )
    expect(result.current.keys.has('k70')).toBe(true)
    expect(result.current.headKey).toBe('k45')
    let steps = 0
    for (let guard = 0; guard < order.length; guard++) {
      let moved = false
      act(() => { moved = result.current.reveal() })
      if (!moved) break
      steps += 1
      const plan = result.current
      expect(anchorViolations(plan, folds), `step=${steps} head=${String(plan.headKey)}`).toEqual([])
    }
    // The reader's own row clamps the head, so the reveal path is bounded.
    expect(steps).toBe(1)
    expect(result.current.revealable).toBe(false)
  })

  it('holds for a mid-Turn hold below the control', () => {
    const order = keys(130)
    const folds = contiguousFolds(order, [0])
    const { result } = renderHook(
      (props: Parameters<typeof useMountedWindow>[0]) => useMountedWindow(props),
      { initialProps: hookInput(null) },
    )
    expect(result.current.atTail).toBe(true)
    act(() => { expect(result.current.hold('k40')).toBe(true) })
    const plan = result.current
    expect(plan.headKey).toBe('k15')
    expect(plan.keys.has('k0')).toBe(true)
    expect(anchorViolations(plan, folds)).toEqual([])
  })
})

/** The fixture's stable key for a settled node. */
function fixtureKey(kind: string, id: string | number): string {
  return `fixture:${kind}:${String(id)}`
}

/**
 * Assemble one fixture session through the real grouping assembler and return
 * the order, the grouped entries, and the resident control indices ChatView
 * feeds the planner.
 * @param input - fixture nodes and turn ends.
 * @returns assembled snapshot, order, entries, controls, and the fold model
 *   the seats apply with the completed-Turn fold on and no open disclosure.
 */
function assembleSession(input: {
  readonly nodes: readonly ConversationNode[]
  readonly turnEnds: ReadonlyMap<number, number>
}): {
  snapshot: ChatSnapshot
  order: readonly string[]
  entries: readonly RenderEntry[]
  controls: number[]
  folds: FoldedTurn[]
} {
  const builder = new ChatSnapshotBuilder()
  const state = new ProcessState()
  const groups = new ConversationGroupStore<ProcessGroupData>()
  const source = chatSnapshotFixture({ nodes: input.nodes, turnEnds: input.turnEnds })
  const snapshot = builder.replace({ nodes: source.nodes.values(), timeline: source.timeline })
  const groupInput = builder.groupInput()
  state.accept(groupInput)
  const update = state.output()
  if (update !== null) groups.prepareAndInstall(update, groupInput.readNode)
  builder.publish()
  groups.publish()
  const order = snapshot.order
  const controls = order.flatMap((key, index) => snapshot.nodes.get(key)?.kind === 'turn-process' ? [index] : [])
  return { snapshot, order, entries: groups.entries, controls, folds: assembledFolds(snapshot, order) }
}

/**
 * The seats' hidden set for one assembled snapshot, with the completed-Turn
 * fold on and no stored open disclosure: every non-independent resident row of
 * a closed, non-interleaved Turn from its process start up to its finalized
 * answer (or to the Turn's end when no answer exists). Mirrors `ChatNodeSeat.processHidden` and
 * `ChatGroupSeat.outerHidden` over the complete Turn, which is the state the
 * mounted window must satisfy.
 * @param snapshot - assembled Chat snapshot.
 * @param order - resident keys in transcript order.
 * @returns one folded Turn per resident control.
 */
function assembledFolds(snapshot: ChatSnapshot, order: readonly string[]): FoldedTurn[] {
  const folds: FoldedTurn[] = []
  for (const control of order) {
    const controlNode = snapshot.nodes.get(control) as ChatNode | undefined
    if (controlNode?.kind !== 'turn-process') continue
    const presentation = snapshot.nodes.processSource(control).getSnapshot()
    if (presentation === undefined || !presentation.turnClosed) continue
    if (presentation.hasInterleavedInput || turnProcessAlwaysOpen(controlNode)) continue
    const spec = controlNode.data
    const hidden: string[] = []
    for (const candidate of order) {
      const other = snapshot.nodes.get(candidate) as ChatNode | undefined
      const location = other?.location
      if (other === undefined || (location?.kind !== 'turn' && location?.kind !== 'step')) continue
      if (location.turn.turn !== spec.turn) continue
      if (TURN_PROCESS_INDEPENDENT_KINDS.has(other.kind)) continue
      if (other.anchorSeq < spec.processStartSeq) continue
      if (spec.answerAnchorSeq !== null && other.anchorSeq >= spec.answerAnchorSeq) continue
      hidden.push(candidate)
    }
    folds.push({ control, hidden })
  }
  return folds
}

describe('assembled fold states', () => {
  it('mounts the control for a dirty closed Turn whose tool run outruns the window', () => {
    const tools = Array.from({ length: 59 }, (_, index) => toolInTurn(2 + index, `tool-${index}`))
    const session = assembleSession({
      nodes: [userInTurn(1, 'question', 1), ...tools],
      turnEnds: new Map([[1, 100]]),
    })
    // The Turn folds: its tool rows are the hidden set, and no answer row exists.
    expect(session.folds).toHaveLength(1)
    expect(session.folds[0]!.hidden.length).toBe(59)
    const plan = planMountedWindow(session.entries, session.order, { kind: 'tail' }, false, session.controls)
    expect(plan.keys.has(session.folds[0]!.control)).toBe(true)
    expect(anchorViolations(plan, session.folds)).toEqual([])
    // The head sits inside the folded run: the control is above the window.
    expect(session.order.indexOf(session.folds[0]!.control)).toBeLessThan(session.order.indexOf(plan.headKey as string))
  })

  it('holds for the assembled session at every frozen head and stub state', () => {
    const steps: ConversationNode[] = Array.from({ length: 70 },
      (_, index) => assistant(2 + index, `row ${index}`, 1, index + 1))
    steps.push(reasoningAssistant(72, 'thinking only', 1, 71))
    const session = assembleSession({
      nodes: [userInTurn(1, 'question', 1), ...steps],
      turnEnds: new Map([[1, 100]]),
    })
    expect(session.folds).toHaveLength(1)
    for (const window of windowStates(session.order)) {
      for (const stub of [false, true]) {
        const plan = planMountedWindow(session.entries, session.order, window, stub, session.controls)
        expect(anchorViolations(plan, session.folds), `head=${String(plan.headKey)} stub=${stub}`).toEqual([])
      }
    }
  })

  it('keeps a finalized answer visible while the pre-answer rows stay folded', () => {
    const members = Array.from({ length: 60 }, (_, index) => toolInTurn(2 + index, `member-${index}`, 'read'))
    const answer = assistant(100, 'final answer', 1, 60)
    const session = assembleSession({
      nodes: [userInTurn(1, 'question', 1), ...members, answer],
      turnEnds: new Map([[1, 101]]),
    })
    expect(session.folds).toHaveLength(1)
    const fold = session.folds[0]!
    expect(fold.hidden.length).toBe(60)
    expect(fold.hidden).not.toContain(fixtureKey('assistant', 100))
    const plan = planMountedWindow(session.entries, session.order, { kind: 'tail' }, false, session.controls)
    expect(anchorViolations(plan, session.folds)).toEqual([])
  })

  it('leaves an interleaved-input Turn unfolded so no control is required', () => {
    const tools = Array.from({ length: 20 }, (_, index) => toolInTurn(2 + index, `tool-${index}`))
    const session = assembleSession({
      nodes: [userInTurn(1, 'question', 1), ...tools, steeringInTurn(50, 'stop', 1)],
      turnEnds: new Map([[1, 100]]),
    })
    // A visible input after process output keeps the Turn open: no row hides,
    // so even a plan whose head sits above the control carries no hidden rows.
    expect(session.folds).toEqual([])
    const plan = planMountedWindow(session.entries, session.order, { kind: 'frozen', head: fixtureKey('tool', 'tool-10') }, false, session.controls)
    expect(anchorViolations(plan, session.folds)).toEqual([])
  })

  it('folds subagent tool rows behind the same control as other process rows', () => {
    const calls = ['subagent', 'subagent_fork', 'bash'].map((name, index) => toolInTurn(2 + index, `call-${index}`, name))
    const session = assembleSession({
      nodes: [userInTurn(1, 'question', 1), ...calls],
      turnEnds: new Map([[1, 100]]),
    })
    const spec = (session.snapshot.nodes.get(session.folds[0]!.control) as ChatNode<'turn-process'>).data
    expect(spec.subagentCount).toBe(2)
    expect(session.folds[0]!.hidden).toHaveLength(3)
    const plan = planMountedWindow(session.entries, session.order, { kind: 'frozen', head: fixtureKey('tool', 'call-2') }, false, session.controls)
    expect(anchorViolations(plan, session.folds)).toEqual([])
  })

  it('leaves an open Turn unfolded while its control has no finalized answer', () => {
    const calls = Array.from({ length: 20 }, (_, index) => toolInTurn(2 + index, `open-${index}`))
    // No turn end: the Turn is open, so the fold never hides its rows.
    const session = assembleSession({
      nodes: [userInTurn(1, 'question', 1), ...calls],
      turnEnds: new Map(),
    })
    expect(session.folds).toEqual([])
    const plan = planMountedWindow(session.entries, session.order, { kind: 'frozen', head: fixtureKey('tool', 'open-10') }, false, session.controls)
    expect(anchorViolations(plan, session.folds)).toEqual([])
  })
})

const user = (seq: number, text: string): UserMessageNode => ({
  kind: 'user', seq, time: seq * 1_000,
  content: [{ type: 'text', text }] as never, source: null,
})
const userInTurn = (seq: number, text: string, turn: number): ConversationNode => ({
  ...user(seq, text), turn,
} as unknown as ConversationNode)
const steeringInTurn = (seq: number, text: string, turn: number): ConversationNode => ({
  kind: 'steering', messageId: `steering-${String(seq)}` as SteeringMessageNode['messageId'],
  seq, time: seq * 1_000, turn,
  content: [{ type: 'text', text }] as never, source: null,
} as unknown as ConversationNode)
const assistant = (seq: number, text: string, turn = 1, step = 1): AssistantMessageNode => ({
  kind: 'assistant', seq, time: seq * 1_000, turn, step, blocks: [{ kind: 'text', text }],
})
const reasoningAssistant = (seq: number, text: string, turn = 1, step = 1): AssistantMessageNode => ({
  kind: 'assistant', seq, time: seq * 1_000, turn, step, blocks: [{ kind: 'reasoning', text }],
})
const toolResult = (seq: number, callId: string, name = 'bash'): ToolResultNode => ({
  kind: 'tool-result', seq, time: seq * 1_000, callId,
  call: { name, argsRaw: `{"command":"cmd-${callId}"}` },
  callTime: seq * 1_000 - 500,
  content: [], isError: false, subCalls: [],
})
const toolInTurn = (seq: number, callId: string, name = 'bash'): ConversationNode => ({
  ...toolResult(seq, callId, name), turn: 1,
} as unknown as ConversationNode)
