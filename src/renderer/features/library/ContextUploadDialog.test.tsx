import { act, render, screen, within } from '@testing-library/react'
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
import { ContextUploadDialog, UploadReviewPanel } from './ContextUploadDialog'
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

  it('reviews one card at a time: conflicts side by side, finer picks on E, and applies what was accepted', async () => {
    useLibraryStore.setState({
      flow: { stage: 'review', review: contextReviewFixture(), busy: false, decisions: {} },
      shown: true
    })
    render(<UploadReviewPanel />)
    expect(screen.getByTestId('library-review-summary')).toHaveTextContent(
      '1 new sheet · 1 sheet to update · 1 conflict · 1 note for Project notes'
    )
    // New sheets come first: Tomas. E shows its finer picks; the tag is left out.
    expect(screen.getByTestId('review-position')).toHaveTextContent('New sheet 1 of 1')
    expect(screen.getAllByTestId('library-item')).toHaveLength(1)
    expect(screen.queryByRole('checkbox', { name: 'Tag #tomas' })).toBeNull()
    await userEvent.keyboard('e')
    await userEvent.click(screen.getByRole('checkbox', { name: 'Tag #tomas' }))
    await userEvent.keyboard('a')

    // Then the conflict: Mara, both values side by side.
    expect(screen.getByTestId('review-position')).toHaveTextContent('Conflict 1 of 1')
    const mara = screen.getByTestId('library-item')
    expect(within(mara).getByTestId('library-matches')).toHaveTextContent(
      'Matched: “Mara” (people.md), “Mara Vell” (people.md) Split'
    )
    const conflict = within(mara).getByTestId('library-conflict')
    expect(within(conflict).getByRole('radio', { name: /Keep the sheet’s\s*34/ })).toBeChecked()
    await userEvent.click(within(conflict).getByRole('radio', { name: /Use the upload’s\s*35/ }))
    await userEvent.keyboard('e')
    await userEvent.click(within(mara).getByRole('checkbox', { name: /Appearance/ }))
    expect(within(mara).getByText('History: ran the ferry.')).toBeInTheDocument()
    await userEvent.keyboard('a')

    // Project notes are skipped: nothing applies by itself, and Apply shows the count.
    expect(screen.getByTestId('library-notes')).toBeInTheDocument()
    await userEvent.keyboard('s')
    expect(screen.getByTestId('review-done')).toHaveTextContent('2 accepted · 1 skipped')
    expect(applied).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Apply 2 accepted' }))
    const sent = applied?.review
    expect(sent?.entities.map((e) => [e.id, e.include])).toEqual([
      ['e1', true],
      ['e2', true]
    ])
    expect(sent?.entities[0]?.fields.map((f) => [f.field, f.include, f.choice])).toEqual([
      ['age', true, 'upload'],
      ['appearance', false, 'upload']
    ])
    expect(sent?.entities[1]?.tag).toBe(false)
    expect(sent?.notes.include).toBe(false)
    expect(useLibraryStore.getState().flow).toBeNull()
  })

  it('runs and waits for review beside the editor: no dialog, and the panel only once shown (2026-10-10)', async () => {
    useLibraryStore.setState({
      flow: { stage: 'review', review: contextReviewFixture(), busy: false, decisions: {} }
    })
    render(
      <>
        <ContextUploadDialog />
        <UploadReviewPanel />
      </>
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByTestId('library-panel')).toBeNull()
    act(() => useLibraryStore.getState().show())
    const panel = screen.getByTestId('library-panel')
    expect(within(panel).getByTestId('review-card')).toBeInTheDocument()
    // Back to the conversation keeps the review; Escape (like Cancel) drops it.
    await userEvent.click(within(panel).getByTestId('side-work-hide'))
    expect(screen.queryByTestId('library-panel')).toBeNull()
    expect(useLibraryStore.getState().flow?.stage).toBe('review')
    act(() => useLibraryStore.getState().show())
    await userEvent.keyboard('{Escape}')
    expect(useLibraryStore.getState().flow).toBeNull()
    expect(screen.queryByTestId('library-panel')).toBeNull()
  })

  it('applies nothing the author did not accept', async () => {
    useLibraryStore.setState({
      flow: { stage: 'review', review: contextReviewFixture(), busy: false, decisions: {} },
      shown: true
    })
    render(<UploadReviewPanel />)
    expect(screen.getByTestId('review-apply')).toBeDisabled()
    await userEvent.keyboard('a')
    expect(screen.getByTestId('review-apply')).toBeEnabled()
    expect(screen.getByTestId('review-apply')).toHaveTextContent('Apply 1 accepted')
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
      },
      shown: true
    })
    const { unmount } = render(<UploadReviewPanel />)
    expect(screen.getByTestId('library-progress')).toHaveTextContent(
      'Request 1 of 2 · $0.01 so far'
    )
    expect(screen.getByTestId('library-stop')).toBeInTheDocument()
    unmount()
    useLibraryStore.setState({
      flow: { stage: 'failed', fileIds: ['f1'], message: 'No key.', nextStep: 'Add one.' }
    })
    render(<UploadReviewPanel />)
    expect(screen.getByTestId('library-error')).toHaveTextContent('No key. Add one.')
  })

  it('changes the review from the chat: the reply, each change, the card marked, and Undo (F-9.9)', async () => {
    setIpcClient({
      async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
        if (channel === 'library:reviewChat') {
          const { requestId } = input as Input<'library:reviewChat'>
          return {
            ok: true,
            ops: [
              { op: 'aliases', item: 'e2', aliases: ['Tom', 'the Younger'] },
              { op: 'rename', item: 'e1', name: 'Mara' }
            ],
            reply: 'Tomas also goes by Tom.',
            dropped: 0,
            usage: { inputTokens: 700, outputTokens: 40 },
            costUsd: 0.003,
            cached: false,
            model: 'gpt-5.4',
            proposalId: 'p-chat',
            requestId
          } as Output<C>
        }
        if (channel === 'proposal:settle') return null as Output<C>
        throw new Error(`unexpected ${channel}`)
      },
      on: () => () => {}
    })
    useLibraryStore.setState({
      flow: { stage: 'review', review: contextReviewFixture(), busy: false, decisions: {} },
      shown: true
    })
    render(<UploadReviewPanel />)
    expect(screen.getByTestId('library-item')).toHaveAttribute('data-item-name', 'Tomas')
    expect(screen.getByTestId('review-chat-send')).toBeDisabled()
    await userEvent.type(screen.getByTestId('review-chat-input'), 'Tomas is also Tom{Enter}')

    const entries = await screen.findAllByTestId('review-chat-entry')
    expect(entries.map((e) => e.dataset.role)).toEqual(['user', 'assistant'])
    expect(entries[1]).toHaveTextContent('AI: Tomas also goes by Tom.')
    const changes = screen.getAllByTestId('review-chat-change')
    expect(changes.map((c) => [c.textContent, c.dataset.skipped])).toEqual([
      ['“Tomas” is also called “Tom”, “the Younger”.', undefined],
      ['Rename skipped: “Mara Vell” is an existing sheet; rename it in the story bible.', 'true']
    ])
    const tomas = screen.getByTestId('library-item')
    expect(tomas.dataset.changed).toBe('true')
    expect(within(tomas).getByTestId('library-item-changed')).toBeInTheDocument()
    expect(within(tomas).getByTestId('library-item-aliases')).toHaveTextContent(
      'Also called: Tom, the Younger'
    )
    expect(screen.getByTestId('review-chat-input')).toHaveValue('')
    // The next card, Mara, was not touched.
    await userEvent.click(screen.getByTestId('review-next'))
    const mara = screen.getByTestId('library-item')
    expect(mara).toHaveTextContent('Also called: Mara')
    expect(mara.dataset.changed).toBeUndefined()
    await userEvent.click(screen.getByTestId('review-prev'))

    await userEvent.click(screen.getByTestId('review-chat-undo'))
    expect(screen.queryByTestId('library-item-changed')).toBeNull()
    expect(screen.queryByText('Also called: Tom, the Younger')).toBeNull()
    expect(screen.getAllByTestId('review-chat-entry').at(-1)).toHaveTextContent(
      'Undid the last change.'
    )
  })
})
