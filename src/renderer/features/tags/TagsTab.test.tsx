import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output, Tag } from '@shared/ipc/contract'
import { toTagName } from '@shared/tags'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { tagFixture } from './tagFixture'
import { resetTagStore, useTagStore } from './tagStore'
import { TagsTab } from './TagsTab'

type Handler = (input: unknown) => unknown

/** Records every call; mutations answer like main does (kebab-cased name, merged patch). */
function install(overrides: Partial<Record<Channel, Handler>> = {}): [Channel, unknown][] {
  const calls: [Channel, unknown][] = []
  let counter = 0
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      const override = overrides[channel]
      if (override) return override(input) as Output<C>
      if (channel === 'tag:list') return tagFixture as Output<C>
      if (channel === 'tag:create') {
        const value = input as Input<'tag:create'>
        const tag: Tag = {
          id: `t-new-${++counter}`,
          name: toTagName(value.name),
          category: value.category,
          color: value.color ?? '#000000',
          parentId: null,
          usageCount: 0,
          created: '2026-09-12T08:00:00.000Z',
          modified: '2026-09-12T08:00:00.000Z'
        }
        return tag as Output<C>
      }
      if (channel === 'tag:update') {
        const { id, ...patch } = input as Input<'tag:update'>
        const current = useTagStore.getState().byId[id]
        if (!current) throw new Error('missing tag')
        const tag: Tag = {
          ...current,
          ...patch,
          name: patch.name === undefined ? current.name : toTagName(patch.name),
          modified: '2026-09-12T09:00:00.000Z'
        }
        return tag as Output<C>
      }
      if (channel === 'tag:delete') return null as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
  return calls
}

const failing = (message: string): Handler => {
  return () => {
    throw new IpcRequestError({ code: 'ALREADY_EXISTS', message })
  }
}

const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })

const categoryTab = (name: string): HTMLElement =>
  within(screen.getByRole('tablist', { name: 'Tag categories' })).getByRole('tab', { name })
const list = (): HTMLElement => screen.getByRole('list', { name: 'Tags' })
const rowNames = (): string[] =>
  within(list())
    .getAllByRole('listitem')
    .map((item) => item.querySelector('span:nth-child(2)')?.textContent ?? '')
const row = (name: string): HTMLElement =>
  within(list()).getByRole('button', { name: new RegExp(`^${name} `) })
const form = (): HTMLElement => screen.getByRole('form', { name: 'New tag' })
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

async function renderLoaded(
  overrides: Partial<Record<Channel, Handler>> = {}
): Promise<[Channel, unknown][]> {
  const calls = install(overrides)
  await act(async () => {
    await useTagStore.getState().load()
  })
  render(<TagsTab />)
  return calls
}

describe('TagsTab (F-4.2)', () => {
  beforeEach(() => {
    resetTagStore()
    useDialogStore.setState({ modals: [], toasts: [] })
  })

  it('shows All plus the seven categories as tabs, with All selected and every tag listed', async () => {
    await renderLoaded()
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'All',
      'Characters',
      'Settings',
      'World Building',
      'Tone',
      'Content',
      'Plot Threads',
      'Custom'
    ])
    expect(categoryTab('All')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('All')
    expect(rowNames()).toEqual(['dark-forest', 'mara', 'moody'])
    expect(row('dark-forest')).toHaveTextContent('3 uses')
    expect(row('mara')).toHaveTextContent('1 use')
    expect(row('moody')).toHaveTextContent('0 uses')
    const dot = row('dark-forest').querySelector('span[aria-hidden]')
    expect(dot).toHaveStyle({ backgroundColor: '#ea580c' })
  })

  it('shows the empty state when the bank is empty', async () => {
    await renderLoaded({ 'tag:list': () => [] })
    expect(screen.getByText('No tags yet.')).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Tags' })).not.toBeInTheDocument()
  })

  it('a category tab and the search filter the list together', async () => {
    const user = userEvent.setup()
    await renderLoaded()
    await user.click(categoryTab('Characters'))
    expect(categoryTab('Characters')).toHaveAttribute('aria-selected', 'true')
    expect(rowNames()).toEqual(['mara'])
    await user.click(categoryTab('All'))
    await user.type(screen.getByRole('searchbox', { name: 'Search tags' }), 'O')
    expect(rowNames()).toEqual(['dark-forest', 'moody'])
    await user.click(categoryTab('Tone'))
    expect(rowNames()).toEqual(['moody'])
    await user.clear(screen.getByRole('searchbox', { name: 'Search tags' }))
    await user.type(screen.getByRole('searchbox', { name: 'Search tags' }), 'zzz')
    expect(screen.getByText('No tags match.')).toBeInTheDocument()
  })

  it('the arrow keys move between category tabs and focus follows', async () => {
    const user = userEvent.setup()
    await renderLoaded()
    categoryTab('All').focus()
    await user.keyboard('{ArrowRight}')
    expect(categoryTab('Characters')).toHaveAttribute('aria-selected', 'true')
    expect(categoryTab('Characters')).toHaveFocus()
    await user.keyboard('{End}')
    expect(categoryTab('Custom')).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowRight}')
    expect(categoryTab('All')).toHaveAttribute('aria-selected', 'true')
  })

  it('the create form defaults to Custom under All, follows the chosen category, and sends the trimmed name', async () => {
    const user = userEvent.setup()
    const calls = await renderLoaded()
    const category = within(form()).getByRole('combobox', { name: 'Category' })
    const color = within(form()).getByLabelText('Color')
    const submit = within(form()).getByRole('button', { name: 'Create tag' })
    expect(category).toHaveValue('custom')
    expect(color).toHaveValue('#6b7280')
    expect(submit).toBeDisabled()

    await user.selectOptions(category, 'tone')
    expect(color).toHaveValue('#2563eb')
    await user.type(within(form()).getByRole('textbox', { name: 'Tag name' }), '  Eerie Calm ')
    expect(submit).toBeEnabled()
    await user.click(submit)

    expect(calls.at(-1)).toEqual([
      'tag:create',
      { name: 'Eerie Calm', category: 'tone', color: '#2563eb' }
    ])
    expect(rowNames()).toEqual(['dark-forest', 'eerie-calm', 'mara', 'moody'])
    expect(within(form()).getByRole('textbox', { name: 'Tag name' })).toHaveValue('')
    expect(calls.filter(([channel]) => channel === 'tag:list')).toHaveLength(1)
  })

  it('a hand-picked color survives a category change, and the form follows the active tab', async () => {
    const user = userEvent.setup()
    const calls = await renderLoaded()
    fireEvent.change(within(form()).getByLabelText('Color'), { target: { value: '#123456' } })
    await user.selectOptions(within(form()).getByRole('combobox', { name: 'Category' }), 'content')
    expect(within(form()).getByLabelText('Color')).toHaveValue('#123456')

    await user.click(categoryTab('Tone'))
    expect(within(form()).getByRole('combobox', { name: 'Category' })).toHaveValue('tone')
    expect(within(form()).getByLabelText('Color')).toHaveValue('#2563eb')
    await user.type(within(form()).getByRole('textbox', { name: 'Tag name' }), 'Tense{Enter}')
    expect(calls.at(-1)).toEqual([
      'tag:create',
      { name: 'Tense', category: 'tone', color: '#2563eb' }
    ])
    expect(rowNames()).toEqual(['moody', 'tense'])
  })

  it('a failed create toasts and leaves the list alone', async () => {
    const user = userEvent.setup()
    await renderLoaded({ 'tag:create': failing('A tag named "mara" already exists') })
    await user.type(within(form()).getByRole('textbox', { name: 'Tag name' }), 'Mara{Enter}')
    expect(toasts()).toEqual(['A tag named "mara" already exists'])
    expect(rowNames()).toEqual(['dark-forest', 'mara', 'moody'])
    expect(within(form()).getByRole('textbox', { name: 'Tag name' })).toHaveValue('Mara')
  })

  it('clicking a row opens the detail view with usage and dates; Back returns to the list', async () => {
    const user = userEvent.setup()
    await renderLoaded()
    await user.click(row('dark-forest'))
    expect(screen.queryByRole('list', { name: 'Tags' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Tag name' })).toHaveValue('dark-forest')
    expect(screen.getByLabelText('Color')).toHaveValue('#ea580c')
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('setting')
    expect(screen.getByText('Used in 3 documents')).toBeInTheDocument()
    expect(screen.getByText(formatDate(tagFixture[0]!.created))).toBeInTheDocument()
    expect(screen.getByText(formatDate(tagFixture[0]!.modified))).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(rowNames()).toEqual(['dark-forest', 'mara', 'moody'])
  })

  it('picking a category tab closes the detail view', async () => {
    const user = userEvent.setup()
    await renderLoaded()
    await user.click(row('mara'))
    expect(screen.getByText('Used in 1 document')).toBeInTheDocument()
    await user.click(categoryTab('Tone'))
    expect(rowNames()).toEqual(['moody'])
  })

  it('Enter commits a rename, the field shows the stored kebab name, and the list re-sorts', async () => {
    const user = userEvent.setup()
    const calls = await renderLoaded()
    await user.click(row('mara'))
    const name = screen.getByRole('textbox', { name: 'Tag name' })
    await user.clear(name)
    await user.type(name, 'Zed Alpha{Enter}')
    expect(calls.at(-1)).toEqual(['tag:update', { id: 't-mara', name: 'Zed Alpha' }])
    expect(screen.getByRole('textbox', { name: 'Tag name' })).toHaveValue('zed-alpha')
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(rowNames()).toEqual(['dark-forest', 'moody', 'zed-alpha'])
  })

  it('blur commits a rename; Escape restores the name; an unchanged or empty name is a no-op', async () => {
    const user = userEvent.setup()
    const calls = await renderLoaded()
    await user.click(row('mara'))
    const name = screen.getByRole('textbox', { name: 'Tag name' })
    await user.clear(name)
    await user.type(name, 'Nope{Escape}')
    expect(name).toHaveValue('mara')
    await user.tab()
    await user.click(name)
    await user.clear(name)
    await user.tab()
    expect(calls.filter(([channel]) => channel === 'tag:update')).toHaveLength(0)
    await user.click(name)
    await user.clear(name)
    await user.type(name, 'Renamed')
    await user.tab()
    expect(calls.at(-1)).toEqual(['tag:update', { id: 't-mara', name: 'Renamed' }])
  })

  it('a failed rename toasts and keeps the stored name', async () => {
    const user = userEvent.setup()
    await renderLoaded({ 'tag:update': failing('A tag named "moody" already exists') })
    await user.click(row('mara'))
    const name = screen.getByRole('textbox', { name: 'Tag name' })
    await user.clear(name)
    await user.type(name, 'Moody{Enter}')
    expect(toasts()).toEqual(['A tag named "moody" already exists'])
    expect(useTagStore.getState().byId['t-mara']?.name).toBe('mara')
  })

  it('the color and category controls write at once', async () => {
    const user = userEvent.setup()
    const calls = await renderLoaded()
    await user.click(row('moody'))
    fireEvent.change(screen.getByLabelText('Color'), { target: { value: '#abcdef' } })
    await act(async () => {})
    expect(calls.at(-1)).toEqual(['tag:update', { id: 't-moody', color: '#abcdef' }])
    expect(useTagStore.getState().byId['t-moody']?.color).toBe('#abcdef')
    expect(screen.getByLabelText('Color')).toHaveValue('#abcdef')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Category' }), 'content')
    expect(calls.at(-1)).toEqual(['tag:update', { id: 't-moody', category: 'content' }])
    expect(useTagStore.getState().byId['t-moody']?.category).toBe('content')
  })

  it('coalesces rapid color-drag steps: one request in flight, the latest pick sent after', async () => {
    const pending: { input: Input<'tag:update'>; resolve: (tag: Tag) => void }[] = []
    const calls = await renderLoaded({
      'tag:update': (input) =>
        new Promise<Tag>((resolve) => {
          pending.push({ input: input as Input<'tag:update'>, resolve })
        })
    })
    await userEvent.setup().click(row('moody'))
    const color = screen.getByLabelText('Color')

    fireEvent.change(color, { target: { value: '#111111' } })
    fireEvent.change(color, { target: { value: '#222222' } })
    fireEvent.change(color, { target: { value: '#333333' } })

    // Only the first drag step is on the wire; the field already shows the latest pick.
    expect(calls.filter(([channel]) => channel === 'tag:update')).toHaveLength(1)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.input).toEqual({ id: 't-moody', color: '#111111' })
    expect(color).toHaveValue('#333333')

    await act(async () => {
      pending[0]?.resolve({ ...tagFixture[2]!, color: '#111111' })
    })

    // The first write landed; the coalesced latest pick goes out next, not '#222222'.
    expect(calls.filter(([channel]) => channel === 'tag:update')).toHaveLength(2)
    expect(pending).toHaveLength(2)
    expect(pending[1]?.input).toEqual({ id: 't-moody', color: '#333333' })

    await act(async () => {
      pending[1]?.resolve({ ...tagFixture[2]!, color: '#333333' })
    })

    expect(useTagStore.getState().byId['t-moody']?.color).toBe('#333333')
    expect(color).toHaveValue('#333333')
  })

  it('Delete asks first with a danger confirm; cancelling keeps the tag', async () => {
    const user = userEvent.setup()
    const calls = await renderLoaded()
    await user.click(row('dark-forest'))
    await user.click(screen.getByRole('button', { name: 'Delete tag' }))
    const modal = useDialogStore.getState().modals[0]
    expect(modal?.kind).toBe('confirm')
    if (modal?.kind !== 'confirm') throw new Error('expected a confirm')
    expect(modal.options).toMatchObject({
      title: 'Delete "dark-forest"?',
      message: 'This removes the tag from every document. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true
    })
    await act(async () => {
      useDialogStore.getState().resolveConfirm(modal.id, false)
    })
    expect(calls.filter(([channel]) => channel === 'tag:delete')).toHaveLength(0)
    expect(screen.getByText('Used in 3 documents')).toBeInTheDocument()
  })

  it('confirming Delete removes the tag and closes the detail view', async () => {
    const user = userEvent.setup()
    const calls = await renderLoaded()
    await user.click(row('dark-forest'))
    await user.click(screen.getByRole('button', { name: 'Delete tag' }))
    const modal = useDialogStore.getState().modals[0]
    if (!modal) throw new Error('expected a confirm')
    await act(async () => {
      useDialogStore.getState().resolveConfirm(modal.id, true)
    })
    expect(calls.at(-1)).toEqual(['tag:delete', { id: 't-forest' }])
    expect(rowNames()).toEqual(['mara', 'moody'])
  })

  it('a failed delete toasts and keeps the detail view open', async () => {
    const user = userEvent.setup()
    await renderLoaded({ 'tag:delete': failing('Database is locked') })
    await user.click(row('dark-forest'))
    await user.click(screen.getByRole('button', { name: 'Delete tag' }))
    const modal = useDialogStore.getState().modals[0]
    if (!modal) throw new Error('expected a confirm')
    await act(async () => {
      useDialogStore.getState().resolveConfirm(modal.id, true)
    })
    expect(toasts()).toEqual(['Database is locked'])
    expect(screen.getByText('Used in 3 documents')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete tag' })).toBeEnabled()
    expect(useTagStore.getState().ids).toEqual(['t-forest', 't-mara', 't-moody'])
  })
})
