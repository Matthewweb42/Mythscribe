import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Dismissed } from '@shared/memory/dismissed'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetDismissedStore } from '@renderer/features/thisScene/dismissedStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { installFakeMain, suggestionViewFixture, type FakeMain } from '../memoryFixture'
import { resetMemoryStore } from '../memoryStore'
import { SuggestionList } from './SuggestionList'
import {
  acceptAllLabel,
  applyText,
  proofText,
  suggestionCountText,
  suggestionGroups,
  suggestionText
} from './suggestionView'

/**
 * F-16.17 (plan Suggestions.md): the This scene panel's "Suggestions from this scene", and the
 * words every suggestion surface shares.
 */

const ROW: Dismissed = {
  id: 'dis-1',
  kind: 'notRight',
  key: 'k',
  recordId: 'r-mara',
  nodeId: 'sc-1',
  label: 'Mara Vell: Eyes grey',
  quote: "Mara's eyes were grey",
  created: '2026-10-14T12:00:00.000Z'
}

let main: FakeMain

beforeEach(() => {
  resetMemoryStore()
  resetDismissedStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  main = installFakeMain({
    'memory:accept': (input) => ({ claimIds: (input as { claimIds: string[] }).claimIds }),
    'memory:dismiss': () => ({ dismissed: [ROW] }),
    'dismissed:undo': () => null,
    'dismissed:list': () => ({ items: [], count: 0 })
  })
})
afterEach(() => {
  resetMemoryStore()
  resetDismissedStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  setIpcClient(null)
})

describe('Suggestions from this scene (plan Suggestions.md)', () => {
  const two = [
    suggestionViewFixture('a'),
    suggestionViewFixture('b', {
      name: 'Tomas',
      recordId: 'r-tomas',
      line: 'Last seen at: the quay',
      note: 'Mara says'
    })
  ]

  it('accepts one with Undo in a toast', async () => {
    render(<SuggestionList suggestions={two} />)
    const lines = screen.getAllByTestId('suggestion-line')
    expect(lines.map((line) => line.firstChild?.textContent)).toEqual([
      'Mara Vell · Eyes: grey',
      'Tomas · Last seen at: the quay (Mara says)'
    ])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept: Mara Vell · Eyes: grey' }))
    })
    expect(main.sent('memory:accept')).toEqual([{ claimIds: ['a'], undo: false }])
    const toast = useDialogStore.getState().toasts.at(-1)
    expect(toast?.message).toBe('Accepted 1 suggestion.')
    await act(async () => {
      toast?.action?.run()
    })
    expect(main.sent('memory:accept')).toEqual([
      { claimIds: ['a'], undo: false },
      { claimIds: ['a'], undo: true }
    ])
  })

  it('dismisses one to the Dismissed list, and accepts all at once', async () => {
    render(<SuggestionList suggestions={two} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss: Mara Vell · Eyes: grey' }))
    })
    expect(main.sent('memory:dismiss')).toEqual([{ claimIds: ['a'] }])
    const toast = useDialogStore.getState().toasts.at(-1)
    expect(toast?.message).toBe('Dismissed 1 suggestion.')
    await act(async () => {
      toast?.action?.run()
    })
    expect(main.sent('dismissed:undo')).toEqual([{ id: 'dis-1' }])
    await act(async () => {
      fireEvent.click(screen.getByTestId('suggestions-accept-all'))
    })
    expect(main.sent('memory:accept').at(-1)).toEqual({ claimIds: ['a', 'b'], undo: false })
  })
})

describe('the suggestions’ words', () => {
  it('says each line, its proof, the count, the groups and the deck’s buttons', () => {
    expect(suggestionText({ name: '', line: 'Eyes: grey', note: null })).toBe('Eyes: grey')
    expect(proofText('literal')).toBe('Stated word for word')
    expect(proofText('verified')).toBe('Read by the AI and checked')
    expect(suggestionCountText(1)).toBe('1 suggestion')
    expect(suggestionCountText(4)).toBe('4 suggestions')
    const groups = suggestionGroups([
      suggestionViewFixture('a'),
      suggestionViewFixture('b', { recordId: 'r-tomas', name: 'Tomas' }),
      suggestionViewFixture('c')
    ])
    expect(groups.map((group) => [group.id, group.label])).toEqual([
      ['r-mara', 'Mara Vell'],
      ['r-tomas', 'Tomas']
    ])
    expect(acceptAllLabel(3, { id: 'r-mara', label: 'Mara Vell' })).toBe(
      'Accept all for Mara Vell (3)'
    )
    expect(applyText(0, 0)).toBe('Apply')
    expect(applyText(2, 1)).toBe('Apply: accept 2, dismiss 1')
  })
})
