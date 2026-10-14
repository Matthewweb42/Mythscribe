import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FindingView } from '@shared/memory/findings'
import type { UnderlineView } from '@shared/memory/underlines'
import {
  findingViewFixture,
  installFakeMain,
  noteFindingFixture,
  sceneMemoryFixture,
  type FakeMain
} from '@renderer/features/memory/memoryFixture'
import { resetMemoryStore, useMemoryStore } from '@renderer/features/memory/memoryStore'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'
import { resetDismissedStore } from '@renderer/features/thisScene/dismissedStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { ContradictionCard } from './ContradictionCard'
import { resetContradictionCardStore, useContradictionCardStore } from './contradictionMarks'

/**
 * The hover card of a contradiction underline (F-16.28, plan P4 §5.2): the other quote with where
 * it is, or the note's sentence; *Go there*, *This one's right* (book against book only) and *Not a
 * problem*; on a note conflict *Update my note* only when offered, handing the proposal to Needs a
 * look; Escape closes it and gives the focus back.
 */

let main: FakeMain
const returnFocus = vi.fn()

function open(finding: FindingView, side: 'a' | 'b', keyboard = false): UnderlineView {
  const underline: UnderlineView = {
    findingId: finding.id,
    side,
    para: finding[side].para ?? 0,
    quote: finding[side].quote,
    finding
  }
  useContradictionCardStore.getState().open({
    underline,
    nodeId: finding[side].nodeId ?? 'sc-2',
    x: 40,
    y: 60,
    pinned: keyboard,
    keyboard,
    returnFocus
  })
  return underline
}

beforeEach(() => {
  resetMemoryStore()
  resetDismissedStore()
  resetContradictionCardStore()
  returnFocus.mockReset()
  main = installFakeMain({
    'memory:findingAction': () => ({ dismissed: null, other: null }),
    'memory:notePatch': () => ({
      findingId: 'f-6',
      owner: { kind: 'record', id: 'r-orrin', name: 'Orrin' },
      page: 'pinned',
      index: 0,
      before: 'Born: 1790',
      after: 'Born: 1792',
      sentence: 'Born: 1790',
      value: '1792'
    })
  })
})

afterEach(() => {
  resetContradictionCardStore()
  resetMemoryStore()
  setIpcClient(null)
})

describe('ContradictionCard (F-16.28)', () => {
  it('shows the other quote with its scene and the three answers', () => {
    open(findingViewFixture('f-1'), 'b')
    render(<ContradictionCard />)
    const card = screen.getByRole('dialog', { name: 'Mara Vell’s eyes: grey (1.1) · brown (1.2)' })
    expect(card).toBeInTheDocument()
    expect(screen.getByTestId('contradiction-other')).toHaveTextContent(
      '1.1: “Mara\'s eyes were grey”'
    )
    expect(screen.getByRole('button', { name: 'Go there' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: "This one's right: brown (1.2)" })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Not a problem' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Update my note' })).toBeNull()
  })

  it('This one’s right says the underlined side is right, closes the card and takes the underlines off', async () => {
    useMemoryStore.setState({
      scenes: {
        'sc-2': {
          ...sceneMemoryFixture('sc-2'),
          claimIds: [],
          underlines: [
            {
              findingId: 'f-1',
              side: 'b',
              para: 0,
              quote: "Mara's eyes were brown",
              finding: findingViewFixture('f-1')
            }
          ]
        }
      }
    })
    open(findingViewFixture('f-1'), 'b')
    render(<ContradictionCard />)
    fireEvent.click(screen.getByRole('button', { name: "This one's right: brown (1.2)" }))
    await waitFor(() => expect(useContradictionCardStore.getState().card).toBeNull())
    expect(main.sent('memory:findingAction')).toEqual([
      { findingId: 'f-1', action: 'right', side: 'b' }
    ])
    expect(useMemoryStore.getState().scenes['sc-2']?.underlines).toEqual([])
  })

  it('Not a problem goes through the finding’s answer and closes the card', async () => {
    open(findingViewFixture('f-1'), 'a')
    render(<ContradictionCard />)
    fireEvent.click(screen.getByRole('button', { name: 'Not a problem' }))
    await waitFor(() => expect(useContradictionCardStore.getState().card).toBeNull())
    expect(main.sent('memory:findingAction')).toEqual([{ findingId: 'f-1', action: 'notProblem' }])
  })

  it('shows a note’s sentence and Update my note (only when offered), never This one’s right', async () => {
    // The This scene panel is open already (opening it would write the layout).
    const { layout } = useLayoutStore.getState()
    useLayoutStore.setState({ layout: { ...layout, tags: { ...layout.tags, open: true } } })
    open(noteFindingFixture('f-6'), 'a')
    const { unmount } = render(<ContradictionCard />)
    expect(screen.getByTestId('contradiction-other')).toHaveTextContent(
      'Your note on Orrin: “Born: 1790”'
    )
    expect(screen.queryByRole('button', { name: /This one's right/u })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Update my note' }))
    await waitFor(() =>
      expect(useMemoryStore.getState().noteEdit).toMatchObject({
        findingId: 'f-6',
        patch: { after: 'Born: 1792' }
      })
    )
    expect(useContradictionCardStore.getState().card).toBeNull()
    unmount()
    // Not offered (the book side is speech, a memory …): no Update my note.
    open(
      noteFindingFixture('f-7', {
        actions: { right: { a: false, b: false }, updateNote: false, notFlashback: null }
      }),
      'a'
    )
    render(<ContradictionCard />)
    expect(screen.queryByRole('button', { name: 'Update my note' })).toBeNull()
  })

  it('takes the focus when opened from the keyboard; Escape closes it and gives the focus back', () => {
    open(findingViewFixture('f-1'), 'b', true)
    render(<ContradictionCard />)
    expect(screen.getByRole('button', { name: 'Go there' })).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useContradictionCardStore.getState().card).toBeNull()
    expect(returnFocus).toHaveBeenCalled()
  })

  it('closes when its finding is no longer underlined in its scene', async () => {
    const underline = open(findingViewFixture('f-1'), 'b')
    useMemoryStore.setState({
      scenes: {
        'sc-2': { ...sceneMemoryFixture('sc-2'), claimIds: [], underlines: [underline] }
      }
    })
    render(<ContradictionCard />)
    expect(screen.getByTestId('contradiction-card')).toBeInTheDocument()
    useMemoryStore.setState({
      scenes: { 'sc-2': { ...sceneMemoryFixture('sc-2'), claimIds: [], underlines: [] } }
    })
    await waitFor(() => expect(useContradictionCardStore.getState().card).toBeNull())
  })
})
