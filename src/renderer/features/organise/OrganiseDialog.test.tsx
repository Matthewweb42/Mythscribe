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

describe('OrganiseDialog (F-9.10)', () => {
  it('lists the plan by group with reasons, the cost, and a checkbox per change in Ask', async () => {
    await open('ask')
    const dialog = await screen.findByRole('dialog', { name: /Organise/ })
    expect(within(dialog).getByText('You asked: Tidy up.')).toBeTruthy()
    expect(within(dialog).getByText('Tidied the binder.')).toBeTruthy()
    expect(within(dialog).getByRole('region', { name: 'Tags' })).toBeTruthy()
    expect(within(dialog).getByRole('region', { name: 'Binder' })).toBeTruthy()
    expect(within(dialog).getByText('says where it is')).toBeTruthy()
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(2)
    expect(within(dialog).getByText('1 suggestion could not be used')).toBeTruthy()
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: 'Rename Untitled to “The mill”' })
    )
    expect(within(dialog).getByRole('button', { name: 'Apply 1 of 2' })).toBeTruthy()
  })

  it('describes only in Plan mode', async () => {
    await open('plan')
    const dialog = await screen.findByRole('dialog', { name: /Organise/ })
    expect(within(dialog).getByText(/Plan mode: this only describes/)).toBeTruthy()
    expect(within(dialog).queryAllByRole('checkbox')).toHaveLength(0)
    expect(within(dialog).queryByRole('button', { name: /^Apply/ })).toBeNull()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(calls).toContain('proposal:settle')
  })
})
