import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Entity, Input, Output } from '@shared/ipc/contract'
import type { EntityKind } from '@shared/entities'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { EntityTab } from './EntityTab'
import { entityFixture } from './entityFixture'
import { resetEntityDraftStore, useEntityDraftStore } from './entityDraftStore'
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
          aliases: [],
          origin: 'author',
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
    resetEntityDraftStore()
    useDialogStore.setState({ modals: [], toasts: [] })
  })
  afterEach(() => {
    cleanup()
    resetEntityDraftStore()
  })

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

  it('offers Upload context… on every story-bible tab, which opens the Library add (F-9.8)', async () => {
    const calls = await renderLoaded('setting', { 'library:add': () => null })
    await userEvent.click(screen.getByTestId('upload-context'))
    expect(calls.at(-1)).toEqual(['library:add', {}])
  })

  it('marks an entity the AI logged until the author edits it (F-5.16)', async () => {
    await renderLoaded('character', {
      'entity:list': () =>
        entityFixture.map((entity) =>
          entity.id === 'e-aldous' ? { ...entity, origin: 'ai' as const } : entity
        )
    })
    expect(row('Aldous')).toHaveTextContent('Added by AI')
    expect(row('Mara')).not.toHaveTextContent('Added by AI')
  })

  it('the list view drops the excerpt and the choice is remembered per kind', async () => {
    const user = userEvent.setup()
    await renderLoaded('character')
    await user.click(screen.getByRole('button', { name: 'List' }))
    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true')
    expect(row('Aldous')).not.toHaveTextContent('cartographer')
    expect(useEntityStore.getState().view).toEqual({ character: 'list' })
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
    expect(screen.getByText('No places yet.')).toBeInTheDocument()
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

  it('double-click renames a row inline and leaves it selected (2026-10-07)', async () => {
    const user = userEvent.setup()
    const renamed = (input: unknown): Entity => ({
      ...entityFixture[1]!,
      name: (input as { name: string }).name
    })
    const calls = await renderLoaded('character', { 'entity:update': renamed })
    await user.dblClick(row('Mara'))
    expect(useEntityStore.getState().selectedId).toBe('e-mara')
    const input = screen.getByRole('textbox', { name: 'Rename' })
    expect(input).toHaveFocus()
    expect(input).toHaveValue('Mara')
    await user.keyboard('Zara{Enter}')
    expect(calls).toContainEqual(['entity:update', { id: 'e-mara', name: 'Zara' }])
    expect(rowNames('Characters')).toEqual(['Aldous', 'Zara'])
  })

  it('renaming the open entity goes through its page draft, so the page shows the new name', async () => {
    const user = userEvent.setup()
    const renamed = (input: unknown): Entity => ({
      ...entityFixture[1]!,
      name: (input as { name?: string }).name ?? 'Mara'
    })
    const calls = await renderLoaded('character', { 'entity:update': renamed })
    useEntityDraftStore.getState().open(entityFixture[1]!)
    row('Mara').focus()
    await user.keyboard('{F2}')
    await user.keyboard('{Control>}a{/Control}Zara{Enter}')
    expect(calls).toContainEqual(['entity:update', { id: 'e-mara', name: 'Zara' }])
    expect(useEntityDraftStore.getState().draft?.name).toBe('Zara')
  })

  it('a refused rename toasts the cause; Escape cancels without a write', async () => {
    const user = userEvent.setup()
    const calls = await renderLoaded('character', {
      'entity:update': failing('An entity named "Aldous" already exists.', 'ALREADY_EXISTS')
    })
    await user.dblClick(row('Mara'))
    await user.keyboard('Aldous{Enter}')
    expect(toasts()).toEqual(['An entity named "Aldous" already exists.'])
    expect(rowNames('Characters')).toEqual(['Aldous', 'Mara'])
    await user.dblClick(row('Mara'))
    await user.keyboard('Other{Escape}')
    expect(screen.queryByRole('textbox', { name: 'Rename' })).not.toBeInTheDocument()
    expect(calls.filter(([channel]) => channel === 'entity:update')).toHaveLength(1)
  })

  it('quick-add creates a structured entity of the kind, selects it, and clears the field', async () => {
    const user = userEvent.setup()
    const calls = await renderLoaded('setting')
    const form = screen.getByRole('form', { name: 'New place' })
    const name = within(form).getByRole('textbox', { name: 'Place name' })
    const add = within(form).getByRole('button', { name: 'Add' })
    expect(add).toBeDisabled()
    await user.type(name, '  The Harbour ')
    await user.click(add)
    expect(calls.at(-1)).toEqual([
      'entity:create',
      { kind: 'setting', name: 'The Harbour', template: 'structured' }
    ])
    expect(rowNames('Places')).toEqual(['Dark Forest', 'The Harbour'])
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

  describe('export and import (F-9.5)', () => {
    const openMenu = async (user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> => {
      await user.click(screen.getByRole('button', { name: 'More' }))
      return screen.getByRole('menu')
    }
    const item = (label: string): HTMLElement => screen.getByRole('menuitem', { name: label })

    it('the More menu offers both exports and the import', async () => {
      const user = userEvent.setup()
      await renderLoaded('character')
      const menu = await openMenu(user)
      expect(
        within(menu)
          .getAllByRole('menuitem')
          .map((el) => el.textContent)
      ).toEqual(['Export as JSON…', 'Export as CSV…', 'Import…', 'Rename category…'])
      expect(item('Export as JSON…')).toBeEnabled()
    })

    it('exports the kind and toasts where the file went', async () => {
      const user = userEvent.setup()
      const calls = await renderLoaded('character', {
        'entity:export': () => ({ path: '/home/a/My Book-characters.csv', count: 2 })
      })
      await openMenu(user)
      await user.click(item('Export as CSV…'))
      expect(calls.at(-1)).toEqual(['entity:export', { kind: 'character', format: 'csv' }])
      expect(toasts()).toEqual(['Exported 2 characters to My Book-characters.csv'])
      expect(screen.queryByRole('menu')).toBeNull()
    })

    it('names one exported entity in the singular', async () => {
      const user = userEvent.setup()
      await renderLoaded('world', {
        'entity:export': () => ({ path: '/home/a/Book-world.json', count: 1 })
      })
      await openMenu(user)
      await user.click(item('Export as JSON…'))
      expect(toasts()).toEqual(['Exported 1 world-building item to Book-world.json'])
      expect(screen.queryByRole('menu')).toBeNull()
    })

    it('says nothing when the save dialog is cancelled', async () => {
      const user = userEvent.setup()
      await renderLoaded('character', { 'entity:export': () => null })
      await openMenu(user)
      await user.click(item('Export as JSON…'))
      expect(toasts()).toEqual([])
    })

    it('a refused export toasts the cause', async () => {
      const user = userEvent.setup()
      await renderLoaded('character', { 'entity:export': failing('Disk is full') })
      await openMenu(user)
      await user.click(item('Export as JSON…'))
      expect(toasts()).toEqual(['Disk is full'])
    })

    it('both exports are disabled while the kind is empty, and Import is not', async () => {
      const user = userEvent.setup()
      install({ 'entity:list': () => [] })
      await act(async () => {
        await useEntityStore.getState().load()
      })
      render(<EntityTab kind="world" />)
      await openMenu(user)
      expect(item('Export as JSON…')).toBeDisabled()
      expect(item('Export as CSV…')).toBeDisabled()
      expect(item('Import…')).toBeEnabled()
    })

    it('Import asks main for a plan and holds it for the dialog', async () => {
      const user = userEvent.setup()
      const plan = {
        source: { name: 'library.json', format: 'json' as const },
        duplicates: 0,
        items: [
          {
            id: 'r1',
            record: {
              kind: 'character' as const,
              name: 'Ilse',
              template: 'structured' as const,
              fields: {},
              body: null
            },
            existingId: null,
            action: 'add' as const
          }
        ]
      }
      const calls = await renderLoaded('character', { 'entity:importOpen': () => plan })
      await openMenu(user)
      await user.click(item('Import…'))
      expect(calls.at(-1)).toEqual(['entity:importOpen', { kind: 'character' }])
      expect(useEntityStore.getState().importPlan).toEqual(plan)
    })

    it('a refused import toasts the cause and opens nothing', async () => {
      const user = userEvent.setup()
      await renderLoaded('character', {
        'entity:importOpen': failing('Row 2: "creature" is not a kind of entity')
      })
      await openMenu(user)
      await user.click(item('Import…'))
      expect(toasts()).toEqual(['Row 2: "creature" is not a kind of entity'])
      expect(useEntityStore.getState().importPlan).toBeNull()
    })
  })
})
