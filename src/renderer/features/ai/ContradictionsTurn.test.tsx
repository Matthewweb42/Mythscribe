import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { findingViewFixture } from '@renderer/features/memory/memoryFixture'
import { resetMemoryStore, useMemoryStore } from '@renderer/features/memory/memoryStore'
import { ContradictionsTurn } from './ContradictionsTurn'

/**
 * P4-D23 (story memory v2): the chat's consistency turn, drawn from what it stored: the scene's
 * findings with *Go to* each side, the scoped lines muted (never in the turn's text), and *Check
 * the book…* opening the priced dialog.
 */

beforeEach(() => {
  resetMemoryStore()
  useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
})
afterEach(() => {
  resetMemoryStore()
  useTreeStore.getState().clear()
})

describe('ContradictionsTurn (P4-D23)', () => {
  it('lists the scene’s findings with Go to each side, and opens Check the book', () => {
    render(
      <ContradictionsTurn
        turn={{
          nodeId: 'sc-2',
          on: true,
          scene: { read: true, unread: 0 },
          waiting: 0,
          judging: false,
          findings: [findingViewFixture('f-1')]
        }}
      />
    )
    const turn = screen.getByTestId('contradictions-turn')
    expect(turn).toHaveTextContent('Mara Vell’s eyes: grey (1.1) · brown (1.2)')
    expect(screen.queryByTestId('contradictions-scoped')).toBeNull()
    fireEvent.click(within(turn).getByRole('button', { name: 'Go to 1.1' }))
    expect(useTreeStore.getState().selectedId).toBe('sc-1')
    fireEvent.click(within(turn).getByRole('button', { name: 'Check the book…' }))
    expect(useMemoryStore.getState().checkOpen).toBe('start')
  })

  it('shows the scoped lines muted when none touch the scene', () => {
    render(
      <ContradictionsTurn
        turn={{
          nodeId: 'sc-2',
          on: true,
          scene: { read: true, unread: 2 },
          waiting: 1,
          judging: false,
          findings: []
        }}
      />
    )
    expect(screen.getByTestId('contradictions-scoped')).toHaveTextContent(
      'No possible contradictions found in this scene so far.2 sentences here are not read yet, so not checked.1 pair in the book is not judged yet.'
    )
  })

  it('says the check is off, and claims nothing', () => {
    render(
      <ContradictionsTurn
        turn={{ nodeId: 'sc-2', on: false, scene: null, waiting: 0, judging: false, findings: [] }}
      />
    )
    expect(screen.getByTestId('contradictions-turn')).toHaveTextContent(
      'The Contradiction check is off, so nothing in this scene has been checked.'
    )
    expect(screen.queryByTestId('contradictions-scoped')).toBeNull()
  })
})
