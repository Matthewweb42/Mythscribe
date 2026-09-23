import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Entity, Input, Output } from '@shared/ipc/contract'
import type { EntityKind } from '@shared/entities'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { EntityTab } from './EntityTab'
import { entityFixture } from './entityFixture'
import { resetEntityStore, useEntityStore } from './entityStore'

type Handler = (input: unknown) => unknown

/** Records every call; mutations answer like main does (trimmed name, merged patch). */
function install(overrides: Partial<Record<Channel, Handler>> = {}): [Channel, unknown][] {
  const calls: [Channel, unknown][] = []
  let counter = 0
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      const override = overrides[channel]
      if (override) return override(input) as Output<C>
      if (channel === 'entity:list') return entityFixture as Output<C>
      if (channel === 'entity:create') {
        const value = input as Input<'entity:create'>
        const entity: Entity = {
          id: `e-new-${++counter}`,
          kind: value.kind,
          name: value.name.trim(),
          template: value.template ?? 'structured',
          fields: value.fields ?? {},
          body: value.body ?? null,
          image: null,
          tagId: null,
          created: '2026-09-12T08:00:00.000Z',
          modified: '2026-09-12T08:00:00.000Z'
        }
        return entity as Output<C>
      }
      if (channel === 'entity:delete') return null as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
  return calls
}

const failing =
  (message: string, code: 'ALREADY_EXISTS' | 'INTERNAL' = 'INTERNAL') =>
  (): never => {
    throw new IpcRequestError({ code, message })
  }

const list = (label: string): HTMLElement => screen.getByRole('list', { name: label })
const rowNames = (label: string): string[] =>
  within(list(label))
    .getAllByRole('listitem')
    .map((item) => item.querySelector('button span')?.textContent ?? '')
const row = (name: string): HTMLElement =>
  screen.getByRole('button', { name: new RegExp(`^${name}`) })
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

async function renderLoaded(
  kind: EntityKind,
  overrides: Partial<Record<Channel, Handler>> = {}
): Promise<[Channel, unknown][]> {
  const calls = install(overrides)
  await act(async () => {
    await useEntityStore.getState().load()
  })
  render(<EntityTab kind={kind} />)
  return calls
}

describe('EntityTab (F-9.2)', () => {
  beforeEach(() => {
    resetEntityStore()
    useDialogStore.setState({ modals: [], toasts: [] })
  })
  afterEach(cleanup)

  it('lists only the entities of its kind, in list order, as cards with an excerpt', async () => {
    await renderLoaded('character')
    expect(rowNames('Characters')).toEqual(['Aldous', 'Mara'])
    expect(row('Aldous')).toHaveTextContent(
      'The old cartographer who taught Mara to read the stars.'
    )
    expect(row('Mara')).toHaveTextContent('27')
    expect(screen.getByRole('button', { name: 'Cards' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('combobox', { name: 'Category' })).toBeNull()
  })

  it('the list view drops the excerpt and the choice is remembered per kind', async () => {
    const user = userEvent.setup()
    await renderLoaded('character')
    await user.click(screen.getByRole('button', { name: 'List' }))
    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true')
    expect(row('Aldous')).not.toHaveTextContent('cartographer')
    expect(useEntityStore.getState().view).toEqual({
      character: 'list',
      setting: 'cards',
      world: 'cards'
    })
  })

  it('search matches the name, the fields, and the page; the empty message says so', async () => {
    const user = userEvent.setup()
    await renderLoaded('character')
    const search = screen.getByRole('searchbox', { name: 'Search characters' })
    await user.type(search, 'scar')
    expect(rowNames('Characters')).toEqual(['Mara'])
    await user.clear(search)
    await user.type(search, 'STARS')
    expect(rowNames('Characters')).toEqual(['Aldous'])
    await user.clear(search)
    await user.type(search, 'nobody')
    expect(screen.getByText('No characters match.')).toBeInTheDocument()
  })

  it('an empty kind says so', async () => {
    install({ 'entity:list': () => [] })
    await act(async () => {
      await useEntityStore.getState().load()
    })
    render(<EntityTab kind="setting" />)
    expect(screen.getByText('No settings yet.')).toBeInTheDocument()
  })

  it('the World tab shows the category chip and filters by category', async () => {
    const user = userEvent.setup()
    await renderLoaded('world')
    expect(rowNames('World')).toEqual(['Blood magic', 'The Guild'])
    expect(row('Blood magic')).toHaveTextContent('Magic system')
    const category = screen.getByRole('combobox', { name: 'Category' })
    expect(
      within(category)
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual(['All categories', 'Magic system', 'Culture'])
    await user.selectOptions(category, 'Culture')
    expect(rowNames('World')).toEqual(['The Guild'])
  })

  it('clicking a row selects it; clicking again clears the selection', async () => {
    const user = userEvent.setup()
    await renderLoaded('character')
    await user.click(row('Mara'))
    expect(useEntityStore.getState().selectedId).toBe('e-mara')
    expect(row('Mara')).toHaveAttribute('aria-current', 'true')
    await user.click(row('Mara'))
    expect(useEntityStore.getState().selectedId).toBeNull()
  })

  it('quick-add creates a structured entity of the kind, selects it, and clears the field', async () => {
    const user = userEvent.setup()
    const calls = await renderLoaded('setting')
    const form = screen.getByRole('form', { name: 'New setting' })
    const name = within(form).getByRole('textbox', { name: 'Setting name' })
    const add = within(form).getByRole('button', { name: 'Add' })
    expect(add).toBeDisabled()
    await user.type(name, '  The Harbour ')
    await user.click(add)
    expect(calls.at(-1)).toEqual([
      'entity:create',
      { kind: 'setting', name: 'The Harbour', template: 'structured' }
    ])
    expect(rowNames('Settings')).toEqual(['Dark Forest', 'The Harbour'])
    expect(name).toHaveValue('')
    expect(useEntityStore.getState().selectedId).toBe('e-new-1')
  })

  it('Enter in the name field submits the quick-add', async () => {
    const user = userEvent.setup()
    const calls = await renderLoaded('world')
    await user.type(
      screen.getByRole('textbox', { name: 'World-building item name' }),
      'Tides{Enter}'
    )
    expect(calls.at(-1)).toEqual([
      'entity:create',
      { kind: 'world', name: 'Tides', template: 'structured' }
    ])
  })

  it('the button beside Add opens the creation dialog for the kind (F-9.3)', async () => {
    const user = userEvent.setup()
    const calls = await renderLoaded('character')
    const form = screen.getByRole('form', { name: 'New character' })
    await user.click(within(form).getByRole('button', { name: 'New character…' }))
    expect(useEntityStore.getState().creating).toBe('character')
    expect(calls.filter(([channel]) => channel === 'entity:create')).toHaveLength(0)
  })

  it('a refused quick-add toasts the cause and keeps the name', async () => {
    const user = userEvent.setup()
    await renderLoaded('character', {
      'entity:create': failing('A character named "Mara" already exists', 'ALREADY_EXISTS')
    })
    const name = screen.getByRole('textbox', { name: 'Character name' })
    await user.type(name, 'mara{Enter}')
    expect(toasts()).toEqual(['A character named "Mara" already exists'])
    expect(name).toHaveValue('mara')
    expect(rowNames('Characters')).toEqual(['Aldous', 'Mara'])
  })

  it('Delete asks first with a danger confirm; cancelling keeps the entity', async () => {
    const user = userEvent.setup()
    const calls = await renderLoaded('character')
    await user.click(screen.getByRole('button', { name: 'Delete Mara' }))
    const modal = useDialogStore.getState().modals[0]
    if (modal?.kind !== 'confirm') throw new Error('expected a confirm')
    expect(modal.options).toMatchObject({
      title: 'Delete "Mara"?',
      confirmLabel: 'Delete',
      danger: true
    })
    await act(async () => {
      useDialogStore.getState().resolveConfirm(modal.id, false)
    })
    expect(calls.filter(([channel]) => channel === 'entity:delete')).toHaveLength(0)
    expect(rowNames('Characters')).toEqual(['Aldous', 'Mara'])
  })

  it('confirming Delete removes the entity', async () => {
    const user = userEvent.setup()
    const calls = await renderLoaded('character')
    await user.click(screen.getByRole('button', { name: 'Delete Mara' }))
    const modal = useDialogStore.getState().modals[0]
    if (!modal) throw new Error('expected a confirm')
    await act(async () => {
      useDialogStore.getState().resolveConfirm(modal.id, true)
    })
    expect(calls.at(-1)).toEqual(['entity:delete', { id: 'e-mara' }])
    expect(rowNames('Characters')).toEqual(['Aldous'])
  })

  it('a failed delete toasts and keeps the row', async () => {
    const user = userEvent.setup()
    await renderLoaded('character', { 'entity:delete': failing('Database is locked') })
    await user.click(screen.getByRole('button', { name: 'Delete Mara' }))
    const modal = useDialogStore.getState().modals[0]
    if (!modal) throw new Error('expected a confirm')
    await act(async () => {
      useDialogStore.getState().resolveConfirm(modal.id, true)
    })
    expect(toasts()).toEqual(['Database is locked'])
    expect(rowNames('Characters')).toEqual(['Aldous', 'Mara'])
  })
})
