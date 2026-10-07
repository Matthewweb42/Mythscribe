import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings } from '@shared/aiSettings'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { resetAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { resetProposalStore } from '@renderer/features/ai/proposalStore'
import { resetEntityStore } from '@renderer/features/entities/entityStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { ContextUploadDialog } from './ContextUploadDialog'
import { contextFileFixture, contextReviewFixture } from './libraryFixture'
import { resetLibraryStore, useLibraryStore } from './libraryStore'

let applied: Input<'library:apply'> | null

beforeEach(() => {
  applied = null
  setIpcClient({
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'library:apply') {
        applied = input as Input<'library:apply'>
        return {
          entities: [],
          files: [contextFileFixture({ state: 'processed' })],
          created: 1,
          updated: 1,
          notes: false
        } as Output<C>
      }
      if (channel === 'proposal:settle') return null as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  })
  resetLibraryStore()
  resetEntityStore()
  resetAiSettingsStore()
  resetAiActivityStore()
  resetProposalStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 1 } })
})

describe('ContextUploadDialog (F-9.8)', () => {
  it('shows the estimate before anything is sent, with Cancel', async () => {
    useLibraryStore.setState({
      flow: {
        stage: 'confirm',
        fileIds: ['f1'],
        estimate: {
          files: 2,
          chunks: 3,
          tokensIn: 12_000,
          tokensOut: 4_500,
          costUsd: 0.09,
          priced: true,
          model: 'gpt-5.4'
        }
      }
    })
    render(<ContextUploadDialog />)
    expect(screen.getByTestId('library-estimate')).toHaveTextContent(
      '2 files · 3 requests to gpt-5.4 · ≈ 12,000 tokens in, 4,500 out · about $0.09'
    )
    await userEvent.click(screen.getByTestId('library-cancel'))
    expect(useLibraryStore.getState().flow).toBeNull()
  })

  it('reviews matches, conflicts side by side, tags, details, and notes, and applies the picks', async () => {
    useLibraryStore.setState({ flow: { stage: 'review', review: contextReviewFixture(), busy: false } })
    render(<ContextUploadDialog />)
    expect(screen.getByTestId('library-review-summary')).toHaveTextContent(
      '1 new sheet · 1 sheet to update · 1 conflict · 1 note for Project notes'
    )
    const mara = screen.getAllByTestId('library-item')[0]!
    expect(within(mara).getByTestId('library-matches')).toHaveTextContent(
      'Matched: “Mara” (people.md), “Mara Vell” (people.md) Split'
    )
    const conflict = within(mara).getByTestId('library-conflict')
    expect(within(conflict).getByRole('radio', { name: /Keep the sheet’s\s*34/ })).toBeChecked()
    await userEvent.click(within(conflict).getByRole('radio', { name: /Use the upload’s\s*35/ }))
    await userEvent.click(within(mara).getByRole('checkbox', { name: /Appearance/ }))
    expect(within(mara).getByText('History: ran the ferry.')).toBeInTheDocument()

    const tomas = screen.getAllByTestId('library-item')[1]!
    await userEvent.click(within(tomas).getByRole('checkbox', { name: 'Tag #tomas' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Include Project notes' }))

    await userEvent.click(screen.getByTestId('library-apply'))
    const sent = applied?.review
    expect(sent?.entities[0]?.fields.map((f) => [f.field, f.include, f.choice])).toEqual([
      ['age', true, 'upload'],
      ['appearance', false, 'upload']
    ])
    expect(sent?.entities[1]?.tag).toBe(false)
    expect(sent?.notes.include).toBe(false)
    expect(useLibraryStore.getState().flow).toBeNull()
  })

  it('disables Apply when nothing is included', async () => {
    useLibraryStore.setState({ flow: { stage: 'review', review: contextReviewFixture(), busy: false } })
    render(<ContextUploadDialog />)
    await userEvent.click(screen.getByRole('button', { name: 'Include nothing' }))
    expect(screen.getByTestId('library-apply')).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Include everything' }))
    expect(screen.getByTestId('library-apply')).toBeEnabled()
  })

  it('shows progress with Stop while the pass runs, and a failure with its next step', () => {
    useLibraryStore.setState({
      flow: {
        stage: 'running',
        fileIds: ['f1'],
        requestId: 'lib-1',
        estimate: {
          files: 1,
          chunks: 2,
          tokensIn: 1,
          tokensOut: 1,
          costUsd: 0,
          priced: true,
          model: 'gpt-5.4'
        },
        progress: { done: 1, total: 2, costUsd: 0.01 }
      }
    })
    const { unmount } = render(<ContextUploadDialog />)
    expect(screen.getByTestId('library-progress')).toHaveTextContent('Request 1 of 2 · $0.01 so far')
    expect(screen.getByTestId('library-stop')).toBeInTheDocument()
    unmount()
    useLibraryStore.setState({
      flow: { stage: 'failed', fileIds: ['f1'], message: 'No key.', nextStep: 'Add one.' }
    })
    render(<ContextUploadDialog />)
    expect(screen.getByTestId('library-error')).toHaveTextContent('No key. Add one.')
  })
})
