import { render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SearchMisses as SearchMissesData } from '@shared/scribe'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetViewStore, useViewStore } from '@renderer/features/shell/viewStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { installFakeMain, type FakeMain } from './memoryFixture'
import { SEARCH_MISSES_SHOWN, SearchMisses } from './SearchMisses'

/**
 * F-16.25 (P3-D15): Settings › AI › Story memory › Details: how many passages Ms Scribe found only
 * by reading a whole chapter, and the newest ones with the question, the passage and the words
 * searched. Local; read through `scribe:searchMisses`.
 */

const MISSES: SearchMissesData = {
  count: 3,
  recent: [
    {
      id: 'm-2',
      created: '2026-10-13T11:00:00.000Z',
      question: 'What happens in chapter 1?',
      terms: ['happens', 'chapter'],
      nodeId: 'sc-1',
      para: 0,
      quote: 'Mara watched the quay',
      promptVersion: 'agent.v9'
    },
    {
      id: 'm-1',
      created: '2026-10-13T10:00:00.000Z',
      question: 'Where did the ledger go?',
      terms: [],
      nodeId: 'gone',
      para: 3,
      quote: 'The ledger sank',
      promptVersion: 'agent.v9'
    }
  ]
}

let main: FakeMain
let answer: () => SearchMissesData

beforeEach(() => {
  resetViewStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  useTreeStore.setState(buildIndex(treeFixture))
  answer = () => MISSES
  main = installFakeMain({ 'scribe:searchMisses': () => answer() })
})
afterEach(() => {
  resetViewStore()
  useTreeStore.getState().clear()
  setIpcClient(null)
})

describe('SearchMisses (F-16.25)', () => {
  it('counts the misses and lists the newest with the question, the passage and the words', async () => {
    useViewStore.setState({ assistantName: 'Quill' })
    render(<SearchMisses />)
    expect(await screen.findByTestId('search-misses-count')).toHaveTextContent('Search misses: 3')
    expect(screen.getByTestId('search-misses')).toHaveTextContent(
      'Passages Quill found only by reading a whole chapter'
    )
    expect(main.sent('scribe:searchMisses')).toEqual([{ limit: SEARCH_MISSES_SHOWN }])
    const [first, second] = screen.getAllByTestId('search-miss')
    expect(first).toHaveTextContent('“What happens in chapter 1?”')
    expect(first).toHaveTextContent('Found in Scene 1 ¶1: Mara watched the quay')
    expect(first).toHaveTextContent('Searched for: happens, chapter')
    expect(within(second!).getByText(/a scene since deleted ¶4/)).toBeInTheDocument()
    expect(second).toHaveTextContent('No words were searched.')
  })

  it('says none when nothing was missed, and toasts a refused read', async () => {
    answer = () => ({ count: 0, recent: [] })
    const { unmount } = render(<SearchMisses />)
    expect(await screen.findByTestId('search-misses-count')).toHaveTextContent('Search misses: 0')
    expect(screen.queryAllByTestId('search-miss')).toHaveLength(0)
    unmount()
    answer = () => {
      throw new Error('The database is locked')
    }
    render(<SearchMisses />)
    await waitFor(() =>
      expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual([
        'The database is locked'
      ])
    )
  })
})
