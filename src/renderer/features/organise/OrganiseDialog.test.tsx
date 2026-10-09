import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings, type AssistantMode } from '@shared/aiSettings'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import type { OrganiseChange } from '@shared/organise'
import { resetAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { resetProposalStore } from '@renderer/features/ai/proposalStore'
import { resetCategoryStore } from '@renderer/features/entities/categoryStore'
import { resetEntityStore } from '@renderer/features/entities/entityStore'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { OrganiseDialog } from './OrganiseDialog'
import { resetOrganiseStore, useOrganiseStore } from './organiseStore'

const CHANGES: OrganiseChange[] = [
  {
    id: 'c1',
    action: {
      kind: 'binder',
      edit: { kind: 'rename', nodeId: 'n', title: 'Untitled', after: 'The mill' }
    },
    reason: 'says where it is',
    requires: []
  },
  {
    id: 'c2',
    action: {
      kind: 'mergeTags',
      target: { id: 'a', name: 'rynna-falsire' },
      sources: [{ id: 'b', name: 'rynna' }]
    },
    reason: '',
    requires: []
  }
]

let calls: Channel[]

beforeEach(() => {
  calls = []
  setIpcClient({
    async invoke<C extends Channel>(channel: C, _input: Input<C>): Promise<Output<C>> {
      calls.push(channel)
      if (channel === 'organise:plan') {
        return {
          ok: true,
          plan: { reply: 'Tidied the binder.', changes: CHANGES, skipped: ['x: no'], chunks: 1 },
          usage: { inputTokens: 900, outputTokens: 80 },
          costUsd: 0.004,
          cached: false,
          model: 'gpt-5.4',
          proposalId: 'p1',
          requestId: 'r'
        } as Output<C>
      }
      if (channel === 'organise:candidates') {
        return { duplicates: [], unusedTags: [], emptySheets: [], notNames: [] } as Output<C>
      }
      if (channel === 'proposal:settle') return null as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  })
  resetOrganiseStore()
  resetTagStore()
  resetEntityStore()
  resetCategoryStore()
  resetAiSettingsStore()
  resetAiActivityStore()
  resetProposalStore()
})

async function open(mode: AssistantMode): Promise<void> {
  useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 1, chatMode: mode } })
  render(<OrganiseDialog />)
  await useOrganiseStore.getState().start({ instruction: 'Tidy up.', scope: [] })
}

describe('OrganiseDialog (F-9.10, one decision at a time)', () => {
  it('shows one change at a time in its group, with the reason, the cost, and what could not be used', async () => {
    await open('ask')
    const dialog = await screen.findByRole('dialog', { name: /Organise/ })
    expect(within(dialog).getByText('You asked: Tidy up.')).toBeTruthy()
    expect(within(dialog).getByText('Tidied the binder.')).toBeTruthy()
    expect(within(dialog).getByText('1 suggestion could not be used')).toBeTruthy()
    const rail = within(dialog).getByRole('navigation', { name: 'Groups' })
    expect(
      within(rail)
        .getAllByTestId('review-group')
        .map((b) => b.textContent)
    ).toEqual(['Merges0/1', 'Binder0/1'])
    // Merges come first: the merge's card, before → after, and no checkbox anywhere.
    expect(within(dialog).getByTestId('review-position').textContent).toBe('Merge 1 of 1')
    const card = within(dialog).getByTestId('review-card')
    expect(within(card).getByText('Merge tags “#rynna” into #rynna-falsire')).toBeTruthy()
    expect(within(card).getByText('#rynna-falsire + #rynna')).toBeTruthy()
    expect(within(dialog).queryAllByRole('checkbox')).toHaveLength(0)
    expect(within(dialog).getByTestId('organise-cost').textContent).toContain('gpt-5.4')
    // S skips it; the binder change is next, with its reason.
    await userEvent.keyboard('s')
    expect(within(dialog).getByText('Rename Untitled to “The mill”')).toBeTruthy()
    expect(within(dialog).getByText('says where it is')).toBeTruthy()
    await userEvent.keyboard('a')
    // Nothing applied by itself: one was skipped. Apply shows the count.
    expect(within(dialog).getByTestId('review-done').textContent).toContain(
      '1 accepted · 1 skipped'
    )
    expect(within(dialog).getByRole('button', { name: 'Apply 1 accepted' })).toBeTruthy()
    expect(calls).not.toContain('tree:rename')
  })

  it('edits a merge before accepting it: another keeper', async () => {
    await open('ask')
    const dialog = await screen.findByRole('dialog', { name: /Organise/ })
    await userEvent.keyboard('e')
    const form = within(dialog).getByTestId('organise-edit')
    await userEvent.click(within(form).getByRole('radio', { name: '#rynna' }))
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }))
    expect(within(dialog).getByText('Merge tags “#rynna-falsire” into #rynna')).toBeTruthy()
    expect(within(dialog).queryByTestId('organise-edit')).toBeNull()
  })

  it('describes only in Plan mode', async () => {
    await open('plan')
    const dialog = await screen.findByRole('dialog', { name: /Organise/ })
    expect(within(dialog).getByText(/Plan mode: this only describes/)).toBeTruthy()
    expect(within(dialog).queryByTestId('review-accept')).toBeNull()
    expect(within(dialog).queryByRole('button', { name: /^Apply/ })).toBeNull()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(calls).toContain('proposal:settle')
  })
})
