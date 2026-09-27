import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EntityImportPlan } from '@shared/entityExchange'
import type { Channel, Entity, Input, Output } from '@shared/ipc/contract'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { EntityImportDialog } from './EntityImportDialog'
import { entityFixture } from './entityFixture'
import { resetEntityStore, useEntityStore } from './entityStore'

type Handler = (input: unknown) => unknown

const mara = entityFixture[1]!

const PLAN: EntityImportPlan = {
  source: { name: 'library.json', format: 'json' },
  duplicates: 1,
  items: [
    {
      id: 'r1',
      record: {
        kind: 'character',
        name: 'Ilse',
        template: 'structured',
        fields: { age: '30', goals: 'Find the ship.' },
        body: null
      },
      existingId: null,
      action: 'add'
    },
    {
      id: 'r2',
      record: {
        kind: 'character',
        name: 'mara',
        template: 'structured',
        fields: { background: 'Born at sea.' },
        body: null
      },
      existingId: 'e-mara',
      action: 'merge'
    }
  ]
}

function install(overrides: Partial<Record<Channel, Handler>> = {}): [Channel, unknown][] {
  const calls: [Channel, unknown][] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      const override = overrides[channel]
      if (override) return override(input) as Output<C>
      if (channel === 'entity:list') return entityFixture as Output<C>
      if (channel === 'entity:importOpen') return PLAN as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
  return calls
}

const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)
const rows = (): HTMLElement[] => screen.getAllByTestId('entity-import-item')
const actionOf = (name: string): HTMLElement =>
  screen.getByRole('combobox', { name: `Action for ${name}` })

async function openPlan(overrides: Partial<Record<Channel, Handler>> = {}): Promise<
  [Channel, unknown][]
> {
  const calls = install(overrides)
  await act(async () => {
    await useEntityStore.getState().load()
    await useEntityStore.getState().openImport('character')
  })
  render(<EntityImportDialog />)
  return calls
}

describe('EntityImportDialog (F-9.5)', () => {
  beforeEach(() => {
    resetEntityStore()
    useDialogStore.setState({ modals: [], toasts: [] })
  })
  afterEach(cleanup)

  it('renders nothing while no plan is under review', () => {
    install()
    render(<EntityImportDialog />)
    expect(screen.queryByTestId('entity-import-dialog')).toBeNull()
  })

  it('lists one row per record with the file name, the counts, and the match', async () => {
    await openPlan()
    expect(screen.getByRole('dialog')).toHaveTextContent('Import “library.json”')
    expect(screen.getByTestId('entity-import-summary')).toHaveTextContent(
      '2 entities · 1 to add · 1 to update · 1 duplicate in the file dropped'
    )
    expect(rows().map((row) => row.dataset.importId)).toEqual(['r1', 'r2'])
    const [ilse, matched] = rows()
    expect(ilse).toHaveTextContent('Ilse')
    expect(ilse).toHaveTextContent('character')
    // The excerpt is of the incoming values, in template order.
    expect(ilse).toHaveTextContent('30')
    expect(matched).toHaveTextContent(`Existing: ${mara.name}`)
    expect(actionOf('Ilse')).toHaveValue('add')
    expect(actionOf('mara')).toHaveValue('merge')
  })

  it('offers only the actions a row can take', async () => {
    await openPlan()
    const options = (name: string): string[] =>
      within(actionOf(name))
        .getAllByRole('option')
        .map((option) => option.textContent ?? '')
    expect(options('Ilse')).toEqual(['Add', 'Skip'])
    expect(options('mara')).toEqual(['Fill in blanks', 'Replace values', 'Skip'])
  })

  it('an action follows into the plan and the summary', async () => {
    const user = userEvent.setup()
    await openPlan()
    await user.selectOptions(actionOf('mara'), 'replace')
    expect(useEntityStore.getState().importPlan?.items[1]?.action).toBe('replace')
    expect(screen.getByTestId('entity-import-summary')).toHaveTextContent('1 to add · 1 to update')
    await user.selectOptions(actionOf('Ilse'), 'skip')
    expect(screen.getByTestId('entity-import-summary')).toHaveTextContent(
      '0 to add · 1 to update · 1 skipped'
    )
  })

  it('Import writes the reviewed rows, toasts what was done, and closes', async () => {
    const user = userEvent.setup()
    const ilse: Entity = { ...mara, id: 'e-ilse', name: 'Ilse' }
    const calls = await openPlan({
      'entity:importCommit': () => ({ entities: [ilse, mara], added: 1, merged: 1, replaced: 0 })
    })
    await user.click(screen.getByTestId('entity-import-commit'))
    expect(calls.at(-1)).toEqual(['entity:importCommit', { items: PLAN.items }])
    expect(toasts()).toEqual(['Imported 2 entities (1 added, 1 merged, 0 replaced)'])
    expect(screen.queryByTestId('entity-import-dialog')).toBeNull()
    expect(useEntityStore.getState().byId['e-ilse']).toEqual(ilse)
  })

  it('Import is refused while every row is skipped', async () => {
    const user = userEvent.setup()
    await openPlan()
    await user.selectOptions(actionOf('Ilse'), 'skip')
    await user.selectOptions(actionOf('mara'), 'skip')
    expect(screen.getByTestId('entity-import-commit')).toBeDisabled()
  })

  it('a refused commit toasts the cause and keeps the plan open', async () => {
    const user = userEvent.setup()
    await openPlan({
      'entity:importCommit': (): never => {
        throw new IpcRequestError({
          code: 'ALREADY_EXISTS',
          message: 'A character named "Ilse" already exists'
        })
      }
    })
    await user.click(screen.getByTestId('entity-import-commit'))
    expect(toasts()).toEqual(['A character named "Ilse" already exists'])
    expect(screen.getByTestId('entity-import-dialog')).toBeInTheDocument()
  })

  it('Cancel and Escape drop the plan and write nothing', async () => {
    const user = userEvent.setup()
    const calls = await openPlan()
    await user.click(screen.getByTestId('entity-import-cancel'))
    expect(useEntityStore.getState().importPlan).toBeNull()
    expect(calls.filter(([channel]) => channel === 'entity:importCommit')).toHaveLength(0)

    await act(async () => {
      await useEntityStore.getState().openImport('character')
    })
    await user.keyboard('{Escape}')
    expect(useEntityStore.getState().importPlan).toBeNull()
  })
})
