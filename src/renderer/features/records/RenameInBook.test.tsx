import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import type { RenamePreview } from '@shared/memory/rename'
import { resetActiveEditorStore } from '@renderer/features/editor/activeEditorStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { recordFixture, withPages } from './recordFixture'
import { RenameInBook } from './RenameInBook'
import { resetRenameStore } from './renameStore'

/**
 * F-16.13, the sheet's form: the preview's places with samples, the places that stay and why, the
 * other drafts only when ticked (no snapshot holds them), and a shared name marked as such.
 */

const MARA = recordFixture('r-mara', 'character', [
  'Mara Vell',
  'Mara',
  { text: 'Vell', shared: true }
])

const PREVIEW: RenamePreview = {
  from: 'Mara',
  to: 'Mira',
  scenes: [
    {
      nodeId: 'sc-1',
      title: 'Harbour',
      count: 1,
      samples: [
        {
          before: { text: 'Later Mara sat down.', range: [6, 10] },
          after: { text: 'Later Mira sat down.', range: [6, 10] }
        }
      ]
    }
  ],
  total: 1,
  kept: { notMention: 1, unsure: 0, other: 2 },
  otherDrafts: { matches: 3, scenes: 2 }
}

let calls: [Channel, unknown][]

beforeEach(() => {
  resetRenameStore()
  resetActiveEditorStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  calls = []
  setIpcClient({
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      if (channel === 'rename:preview') return PREVIEW as Output<C>
      if (channel === 'rename:apply') {
        return {
          record: withPages(MARA),
          written: [],
          drafts: 3,
          openId: null,
          openEdits: []
        } as Output<C>
      }
      if (channel === 'tree:list') return [] as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  })
})
afterEach(() => {
  resetRenameStore()
})

describe('RenameInBook (F-16.13)', () => {
  it('shows the places with samples and what stays, and sends the other drafts only when ticked', async () => {
    render(<RenameInBook record={MARA} busy={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Rename in book…' }))
    const pick = screen.getByLabelText('Rename')
    expect([...pick.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      'Mara Vell',
      'Mara',
      'Vell (shared)'
    ])
    fireEvent.change(pick, { target: { value: 'r-mara-a1' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'New name' }), {
      target: { value: 'Mira' }
    })
    const preview = await screen.findByTestId('rename-preview')
    expect(preview).toHaveTextContent('1 match in 1 scene (+3 in other drafts)')
    expect(preview).toHaveTextContent('Harbour · 1')
    expect(preview).toHaveTextContent('Later MaraMira sat down.')
    expect(preview).toHaveTextContent(
      "Left as they are: 1 marked Not a mention · 2 other uses of “Mara” (a longer name, another record's, or a sentence start)."
    )
    expect(preview).toHaveTextContent('A snapshot of the book is taken first.')
    const drafts = screen.getByRole('checkbox', { name: /Also rename in other drafts \(\+3\)/ })
    expect(drafts).not.toBeChecked()
    fireEvent.click(drafts)
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(calls.some(([channel]) => channel === 'rename:apply')).toBe(true))
    expect(calls.find(([channel]) => channel === 'rename:apply')?.[1]).toEqual({
      recordId: 'r-mara',
      aliasId: 'r-mara-a1',
      to: 'Mira',
      openId: null,
      otherDrafts: true
    })
  })
})
