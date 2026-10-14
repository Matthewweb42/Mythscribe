import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Input } from '@shared/ipc/contract'
import type { Dismissed } from '@shared/memory/dismissed'
import { resetActiveEditorStore } from '@renderer/features/editor/activeEditorStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetDismissedStore, useDismissedStore } from '@renderer/features/thisScene/dismissedStore'
import { setIpcClient } from '@renderer/lib/ipc'
import {
  findingSideFixture,
  findingsViewFixture,
  findingViewFixture,
  installFakeMain,
  noteFindingFixture,
  type FakeMain
} from '../memoryFixture'
import { resetMemoryStore, useMemoryStore } from '../memoryStore'
import { Contradictions } from './Contradictions'
import { FindingRow, UnclearFindings } from './FindingRow'

/**
 * F-16.27, F-16.29 (plan P4 §4): a possible contradiction in Needs a look: its rule's words, both
 * quotes with *Go there*, *This one's right* on book sides only (leaving its short line with *Go
 * there* and *Undo*), *Not a problem*, ⓘ with how it was found, judged, confirmed and what it cost;
 * the unclear ones muted behind a collapsed line; the scene's own first.
 */

const row = (id: string, kind: Dismissed['kind'] = 'notProblem'): Dismissed => ({
  id,
  kind,
  key: `finding|${id}`,
  recordId: 'r-mara',
  nodeId: 'sc-1',
  label: id,
  quote: null,
  created: '2026-10-14T10:00:00.000Z'
})

const OPEN = findingViewFixture('f-1', { confirmed: true })
const ELSEWHERE = findingViewFixture('f-2', {
  slot: 'hair',
  slotLabel: 'Hair',
  a: findingSideFixture('dark', '1.4', 'sc-4'),
  b: findingSideFixture('fair', '1.5', 'sc-5')
})

let main: FakeMain

beforeEach(async () => {
  resetMemoryStore()
  resetDismissedStore()
  // A jump one test starts must not land in the next one's editor.
  resetActiveEditorStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
  main = installFakeMain({
    'memory:findings': () =>
      findingsViewFixture({
        open: [OPEN, ELSEWHERE],
        unclear: [findingViewFixture('f-3', { state: 'unclear' })]
      }),
    'memory:findingAction': (input) => {
      const action = input as Input<'memory:findingAction'>
      return {
        dismissed: row(
          `d-${action.findingId}`,
          action.action === 'right' ? 'notRight' : 'notProblem'
        ),
        other: action.action === 'right' ? { nodeId: 'sc-2', ref: '1.2' } : null
      }
    },
    'dismissed:undo': () => ({ restored: true })
  })
  await act(async () => {
    await useMemoryStore.getState().loadFindings()
  })
})
afterEach(() => {
  resetMemoryStore()
  resetDismissedStore()
  resetActiveEditorStore()
  useTreeStore.getState().clear()
  setIpcClient(null)
})

describe('FindingRow (F-16.27)', () => {
  it('shows the rule’s words, both quotes with Go there, and ⓘ with how it was found', () => {
    render(
      <ul>
        <FindingRow finding={OPEN} />
      </ul>
    )
    const item = screen.getByTestId('finding')
    expect(item).toHaveTextContent('Mara Vell’s eyes: grey (1.1) · brown (1.2)')
    expect(item).toHaveTextContent("Mara's eyes were grey")
    expect(item).toHaveTextContent("Mara's eyes were brown")
    fireEvent.click(within(item).getByRole('button', { name: 'Go there: 1.2' }))
    expect(useTreeStore.getState().selectedId).toBe('sc-2')
    fireEvent.click(
      within(item).getByRole('button', {
        name: 'How this was found: Mara Vell’s eyes: grey (1.1) · brown (1.2)'
      })
    )
    const info = screen.getByTestId('finding-info')
    expect(info).toHaveTextContent('Found in code: two values for eyes')
    expect(info).toHaveTextContent('judged a contradiction both ways by AI')
    expect(info).toHaveTextContent('confirmed by a stronger AI read')
    expect(info).toHaveTextContent('judging it cost 0.02¢')
  })

  it('offers This one’s right only on book sides, never on a note conflict', () => {
    render(
      <ul>
        <FindingRow finding={OPEN} />
        <FindingRow
          finding={findingViewFixture('f-n', {
            ...noteFindingFixture('f-n'),
            rule: 'C1'
          })}
        />
      </ul>
    )
    const [book, note] = screen.getAllByTestId('finding')
    expect(within(book!).getAllByRole('button', { name: /^This one's right/ })).toHaveLength(2)
    expect(within(note!).queryByRole('button', { name: /^This one's right/ })).toBeNull()
  })

  it('This one’s right closes the finding and leaves a line with Go there and Undo', async () => {
    render(<Contradictions findings={[OPEN]} unclear={[]} sceneId="sc-1" />)
    fireEvent.click(screen.getByRole('button', { name: "This one's right: grey (1.1)" }))
    await waitFor(() => expect(main.sent('memory:findingAction')).toHaveLength(1))
    expect(main.sent('memory:findingAction')).toEqual([
      { findingId: 'f-1', action: 'right', side: 'a' }
    ])
    const mark = await screen.findByTestId('right-mark')
    expect(mark).toHaveTextContent('Marked “brown” (1.2) not right')
    expect(useDismissedStore.getState().items.map((each) => each.id)).toEqual(['d-f-1'])
    fireEvent.click(within(mark).getByRole('button', { name: 'Go there' }))
    expect(useTreeStore.getState().selectedId).toBe('sc-2')
    fireEvent.click(within(mark).getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(main.sent('dismissed:undo')).toEqual([{ id: 'd-f-1' }]))
    await waitFor(() => expect(screen.queryByTestId('right-mark')).toBeNull())
  })

  it('Not a problem goes to Dismissed and takes the finding away at once', async () => {
    render(
      <ul>
        <FindingRow finding={OPEN} />
      </ul>
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Not a problem: Mara Vell’s eyes: grey (1.1) · brown (1.2)'
      })
    )
    await waitFor(() =>
      expect(main.sent('memory:findingAction')).toEqual([
        { findingId: 'f-1', action: 'notProblem' }
      ])
    )
    expect(useMemoryStore.getState().findings?.open).toEqual(['f-2'])
    expect(useDismissedStore.getState().items.map((each) => each.id)).toEqual(['d-f-1'])
  })

  it('lists the scene’s own first, then the rest, and the unclear ones muted and collapsed', () => {
    render(
      <Contradictions
        findings={[ELSEWHERE, OPEN]}
        unclear={[findingViewFixture('f-3', { state: 'unclear' })]}
        sceneId="sc-1"
      />
    )
    const here = screen.getByRole('group', { name: 'In this scene' })
    expect(here).toHaveTextContent('Mara Vell’s eyes')
    expect(screen.getByRole('group', { name: 'Elsewhere in the book' })).toHaveTextContent(
      'Mara Vell’s hair: dark (1.4) · fair (1.5)'
    )
    const unclear = screen.getByTestId('unclear-findings')
    expect(unclear).not.toHaveAttribute('open')
    expect(unclear).toHaveTextContent('Unclear (1)')
    const muted = within(unclear).getByTestId('unclear-finding')
    expect(muted.className).toContain('opacity-70')
    expect(within(muted).queryByRole('button', { name: /^This one's right/ })).toBeNull()
    expect(within(muted).getAllByRole('button', { name: /^Go there/ })).toHaveLength(2)
    expect(within(muted).getByRole('button', { name: /^Not a problem/ })).toBeInTheDocument()
    // ⓘ on an unclear one too: how it was judged and what judging it cost.
    fireEvent.click(within(muted).getByRole('button', { name: /^How this was found/ }))
    const info = within(muted).getByTestId('finding-info')
    expect(info).toHaveTextContent('the stronger check could not settle it')
    expect(info).toHaveTextContent('judging it cost 0.02¢')
  })

  it('draws nothing for no unclear findings', () => {
    const { container } = render(<UnclearFindings findings={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})
