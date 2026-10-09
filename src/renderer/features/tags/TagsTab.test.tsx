import { Editor } from '@tiptap/core'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Entity, Input, Output, Tag } from '@shared/ipc/contract'
import type { TagMentions } from '@shared/mentions'
import { toTagName } from '@shared/tags'
import {
  resetActiveEditorStore,
  useActiveEditorStore
} from '@renderer/features/editor/activeEditorStore'
import { buildExtensions } from '@renderer/features/editor/extensions'
import { entityFixture } from '@renderer/features/entities/entityFixture'
import { resetEntityStore, useEntityStore } from '@renderer/features/entities/entityStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetCustomTemplateStore } from './customTemplateStore'
import { resetDocumentTagStore, useDocumentTagStore } from './documentTagStore'
import { resetMentionStore, useMentionStore } from './mentionStore'
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
      if (channel === 'tag:aliases') return {} as Output<C>
      if (channel === 'tagTemplate:list') return [] as Output<C>
      if (channel === 'tag:create') {
        const value = input as Input<'tag:create'>
        const tag: Tag = {
          id: `t-new-${++counter}`,
          name: toTagName(value.name),
          category: value.category,
          color: value.color ?? '#000000',
          parentId: null,
          usageCount: 0,
          trackMentions: true,
          aliases: [],
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
      if (channel === 'documentTag:listAll') return [] as Output<C>
      if (channel === 'mention:listForTag') return [] as Output<C>
      if (channel === 'layout:set') return input as Output<C>
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
    resetCustomTemplateStore()
    resetDocumentTagStore()
    resetMentionStore()
    useTreeStore.getState().clear()
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

  it('a selection request opens that tag\u2019s detail view under All and is consumed (F-4.6)', async () => {
    const user = userEvent.setup()
    await renderLoaded()
    await user.click(categoryTab('Tone'))
    expect(rowNames()).toEqual(['moody'])
    act(() => {
      useTagStore.getState().requestSelection('t-mara')
    })
    expect(screen.getByRole('textbox', { name: 'Tag name' })).toHaveValue('mara')
    expect(categoryTab('All')).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(useTagStore.getState().pendingSelection).toBeNull())
    // Back returns to the full list; a remount does not replay the request.
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(rowNames()).toEqual(['dark-forest', 'mara', 'moody'])
    cleanup()
    render(<TagsTab />)
    expect(rowNames()).toEqual(['dark-forest', 'mara', 'moody'])
    // A repeat request for the same tag, while its detail is already closed, opens it again.
    act(() => {
      useTagStore.getState().requestSelection('t-mara')
    })
    expect(screen.getByRole('textbox', { name: 'Tag name' })).toHaveValue('mara')
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

  it('double-click on a row opens the detail with the name selected; the second click acts nowhere else (2026-10-07)', async () => {
    const user = userEvent.setup()
    const calls = await renderLoaded()
    await user.click(row('mara'))
    expect(screen.getByRole('textbox', { name: 'Tag name' })).not.toHaveFocus()
    // The first click swapped the list for the detail, so the rest of the double-click lands on it.
    const back = screen.getByRole('button', { name: 'Back' })
    fireEvent.mouseDown(back, { detail: 2 })
    fireEvent.click(back, { detail: 2 })
    fireEvent.doubleClick(back, { detail: 2 })
    const name = screen.getByRole('textbox', { name: 'Tag name' })
    expect(name).toHaveFocus()
    expect(name).toHaveValue('mara')
    await user.keyboard('Zed Alpha{Enter}')
    expect(calls.at(-1)).toEqual(['tag:update', { id: 't-mara', name: 'Zed Alpha' }])
    expect(screen.getByRole('textbox', { name: 'Tag name' })).toHaveValue('zed-alpha')
  })

  it('F2 on a row opens the detail with the name field focused', async () => {
    const user = userEvent.setup()
    await renderLoaded()
    row('moody').focus()
    await user.keyboard('{F2}')
    expect(screen.getByRole('textbox', { name: 'Tag name' })).toHaveFocus()
    expect(screen.getByRole('textbox', { name: 'Tag name' })).toHaveValue('moody')
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

describe('TagDetail documents (F-4.10)', () => {
  /** Seeds the tree with the fixture, as the app does on project open. */
  function seedTree(): void {
    useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
  }
  const documents = (): HTMLElement => screen.getByRole('list', { name: 'Documents with this tag' })

  beforeEach(() => {
    resetTagStore()
    resetCustomTemplateStore()
    resetDocumentTagStore()
    resetMentionStore()
    useTreeStore.getState().clear()
    useDialogStore.setState({ modals: [], toasts: [] })
    resetLayoutStore()
  })

  afterEach(() => {
    resetLayoutStore()
  })

  /** Puts the sidebar on the Tags tab without a scheduled write. */
  function onTagsTab(): void {
    const { layout } = useLayoutStore.getState()
    useLayoutStore.setState({ layout: { ...layout, sidebar: { ...layout.sidebar, tab: 'tags' } } })
  }

  it('opening a detail loads every link and lists the carrying documents in tree order', async () => {
    const user = userEvent.setup()
    seedTree()
    onTagsTab()
    const calls = await renderLoaded({
      'documentTag:listAll': () => [
        { nodeId: 'ch-4', tagId: 't-forest' },
        { nodeId: 'sc-2', tagId: 't-forest' },
        { nodeId: 'sc-2', tagId: 't-mara' },
        { nodeId: 'title-page', tagId: 't-forest' },
        { nodeId: 'gone', tagId: 't-forest' }
      ]
    })
    await user.click(row('dark-forest'))
    expect(calls.filter(([channel]) => channel === 'documentTag:listAll')).toHaveLength(1)
    await waitFor(() => expect(documents()).toBeInTheDocument())
    expect(
      within(documents())
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['Title Page', 'Scene 2Chapter 2', 'Chapter 4Arc 2'])
    await user.click(within(documents()).getByRole('button', { name: /^Scene 2/ }))
    expect(useTreeStore.getState().selectedId).toBe('sc-2')
    expect(useLayoutStore.getState().layout.sidebar.tab).toBe('tags')
  })

  it('shows the empty state for a tag no document carries', async () => {
    const user = userEvent.setup()
    seedTree()
    await renderLoaded()
    await user.click(row('moody'))
    await waitFor(() =>
      expect(screen.getByText('No documents carry this tag.')).toBeInTheDocument()
    )
    expect(screen.queryByRole('list', { name: 'Documents with this tag' })).not.toBeInTheDocument()
  })

  it('Show in tree sets the tree filter and switches to the Manuscript tab', async () => {
    const user = userEvent.setup()
    seedTree()
    onTagsTab()
    await renderLoaded()
    await user.click(row('mara'))
    await user.click(screen.getByRole('button', { name: 'Show in tree' }))
    expect(useTreeStore.getState().tagFilter).toBe('t-mara')
    expect(useLayoutStore.getState().layout.sidebar.tab).toBe('manuscript')
  })

  it('a failed link load toasts and leaves the detail view open', async () => {
    const user = userEvent.setup()
    seedTree()
    await renderLoaded({ 'documentTag:listAll': failing('Database is locked') })
    await user.click(row('mara'))
    await waitFor(() => expect(toasts()).toEqual(['Database is locked']))
    expect(screen.getByRole('textbox', { name: 'Tag name' })).toHaveValue('mara')
    expect(useDocumentTagStore.getState().tagIdsByNode).toEqual({})
  })
})

describe('TagDetail mentions (F-4.12)', () => {
  const TEXT = 'Mara waited at the gate.'
  /** The open document of `sc-2`, so a jump can select the passage it finds. */
  let editor: Editor

  const mention = (nodeId: string, count: number, ranges: [number, number][]): TagMentions => ({
    tagId: 't-mara',
    nodeId,
    count,
    ranges
  })
  const mentions = (): HTMLElement =>
    screen.getByRole('list', { name: 'Documents mentioning this tag' })
  const trackBox = (): HTMLElement => screen.getByRole('checkbox', { name: 'Track mentions' })

  beforeEach(() => {
    resetTagStore()
    resetCustomTemplateStore()
    resetDocumentTagStore()
    resetMentionStore()
    resetActiveEditorStore()
    useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
    useDialogStore.setState({ modals: [], toasts: [] })
    editor = new Editor({
      extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-2' }),
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: TEXT }] }]
      }
    })
  })

  afterEach(() => {
    editor.destroy()
    resetActiveEditorStore()
  })

  it('lists the mentioning documents in tree order with their counts and says how many there are', async () => {
    const user = userEvent.setup()
    await renderLoaded({
      'mention:listForTag': () => [
        mention('ch-4', 1, [[3, 7]]),
        mention('sc-2', 2, [
          [1, 5],
          [40, 44]
        ]),
        mention('gone', 5, [[1, 5]])
      ]
    })
    await user.click(row('mara'))
    await waitFor(() => expect(mentions()).toBeInTheDocument())
    // A recorded node that is not in the tree any more is skipped.
    expect(
      within(mentions())
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual(['Scene 2 ×2', 'Chapter 4 ×1'])
    expect(screen.getByText('Mentioned in 2 documents')).toBeInTheDocument()
  })

  it('clicking a mention opens the document and selects the recorded occurrence', async () => {
    const user = userEvent.setup()
    await renderLoaded({ 'mention:listForTag': () => [mention('sc-2', 1, [[1, 5]])] })
    await user.click(row('mara'))
    await waitFor(() => expect(mentions()).toBeInTheDocument())
    useActiveEditorStore.getState().set('sc-2', editor)
    await user.click(within(mentions()).getByRole('button', { name: /^Scene 2/ }))
    await waitFor(() => expect(useTreeStore.getState().selectedId).toBe('sc-2'))
    await waitFor(() =>
      expect(
        editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)
      ).toBe('Mara')
    )
    expect(toasts()).toEqual([])
  })

  it('says so when nothing mentions the tag, and lists nothing', async () => {
    const user = userEvent.setup()
    await renderLoaded()
    await user.click(row('moody'))
    await waitFor(() => expect(screen.getByText('Not mentioned')).toBeInTheDocument())
    expect(
      screen.queryByRole('list', { name: 'Documents mentioning this tag' })
    ).not.toBeInTheDocument()
  })

  it('Track mentions patches the tag and hides the list while it is off', async () => {
    const user = userEvent.setup()
    const calls = await renderLoaded({
      'mention:listForTag': () => [mention('sc-2', 1, [[1, 5]])]
    })
    await user.click(row('mara'))
    await waitFor(() => expect(mentions()).toBeInTheDocument())
    expect(trackBox()).toBeChecked()
    await user.click(trackBox())
    expect(calls.at(-1)).toEqual(['tag:update', { id: 't-mara', trackMentions: false }])
    await waitFor(() => expect(trackBox()).not.toBeChecked())
    expect(
      screen.queryByRole('list', { name: 'Documents mentioning this tag' })
    ).not.toBeInTheDocument()
    await user.click(trackBox())
    expect(calls.at(-1)).toEqual(['tag:update', { id: 't-mara', trackMentions: true }])
    await waitFor(() => expect(mentions()).toBeInTheDocument())
  })

  it('adds an alias on Enter and removes one from its chip (F-4.14)', async () => {
    const user = userEvent.setup()
    const calls = await renderLoaded()
    await user.click(row('mara'))
    const aliases = screen.getByRole('group', { name: 'Aliases' })
    await user.type(
      within(aliases).getByRole('textbox', { name: 'Add alias' }),
      'The Navigator{Enter}'
    )
    expect(calls.at(-1)).toEqual(['tag:update', { id: 't-mara', aliases: ['The Navigator'] }])
    await waitFor(() =>
      expect(useTagStore.getState().byId['t-mara']?.aliases).toEqual(['The Navigator'])
    )
    expect(within(aliases).getByRole('textbox', { name: 'Add alias' })).toHaveValue('')
    await user.click(within(aliases).getByRole('button', { name: 'Remove alias The Navigator' }))
    expect(calls.at(-1)).toEqual(['tag:update', { id: 't-mara', aliases: [] }])
  })

  it('a failed toggle toasts and leaves the checkbox as the stored tag has it', async () => {
    const user = userEvent.setup()
    await renderLoaded({ 'tag:update': failing('Database is locked') })
    await user.click(row('mara'))
    await user.click(trackBox())
    await waitFor(() => expect(toasts()).toEqual(['Database is locked']))
    expect(trackBox()).toBeChecked()
    expect(useTagStore.getState().byId['t-mara']?.trackMentions).toBe(true)
  })

  it('a failed mention load toasts and leaves the detail view open', async () => {
    const user = userEvent.setup()
    await renderLoaded({ 'mention:listForTag': failing('Database is locked') })
    await user.click(row('mara'))
    await waitFor(() => expect(toasts()).toEqual(['Database is locked']))
    expect(screen.getByRole('textbox', { name: 'Tag name' })).toHaveValue('mara')
    expect(useMentionStore.getState().byTag).toEqual({})
  })
})

describe('TagsTab bulk operations and the tag bank file (F-4.9)', () => {
  beforeEach(() => {
    resetTagStore()
    resetCustomTemplateStore()
    resetDocumentTagStore()
    resetMentionStore()
    useTreeStore.getState().clear()
    useDialogStore.setState({ modals: [], toasts: [] })
  })

  const box = (name: string): HTMLElement =>
    within(list()).getByRole('checkbox', { name: new RegExp(`^${name} `) })
  const bulk = (): HTMLElement => screen.getByRole('group', { name: 'Selected tags' })
  const confirmTop = async (answer: boolean): Promise<void> => {
    const modal = useDialogStore.getState().modals[0]
    if (modal?.kind !== 'confirm') throw new Error('expected a confirm')
    await act(async () => {
      useDialogStore.getState().resolveConfirm(modal.id, answer)
    })
  }

  it('Select turns the rows into checkboxes and the create form into the bulk bar; Done leaves', async () => {
    const user = userEvent.setup()
    await renderLoaded()
    await user.click(screen.getByRole('button', { name: 'Select' }))
    expect(screen.getByRole('button', { name: 'Select' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('form', { name: 'New tag' })).not.toBeInTheDocument()
    expect(within(bulk()).getByText('0 selected')).toBeInTheDocument()
    await user.click(box('mara'))
    expect(box('mara')).toBeChecked()
    expect(within(bulk()).getByText('1 selected')).toBeInTheDocument()
    // A checked row does not open the detail view.
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument()
    await user.click(within(bulk()).getByRole('button', { name: 'All' }))
    expect(within(bulk()).getByText('3 selected')).toBeInTheDocument()
    await user.click(within(bulk()).getByRole('button', { name: 'None' }))
    expect(within(bulk()).getByText('0 selected')).toBeInTheDocument()
    await user.click(box('moody'))
    await user.click(within(bulk()).getByRole('button', { name: 'Done' }))
    expect(form()).toBeInTheDocument()
    expect(row('moody')).toBeInTheDocument()
    // Re-entering starts empty.
    await user.click(screen.getByRole('button', { name: 'Select' }))
    expect(within(bulk()).getByText('0 selected')).toBeInTheDocument()
  })

  it('the selection is pruned to the visible rows, so a hidden tag is never acted on', async () => {
    const user = userEvent.setup()
    const calls = await renderLoaded({ 'tag:deleteMany': () => null })
    await user.click(screen.getByRole('button', { name: 'Select' }))
    await user.click(within(bulk()).getByRole('button', { name: 'All' }))
    await user.type(screen.getByRole('searchbox', { name: 'Search tags' }), 'm')
    expect(within(bulk()).getByText('2 selected')).toBeInTheDocument()
    await user.click(within(bulk()).getByRole('button', { name: 'Delete' }))
    const modal = useDialogStore.getState().modals[0]
    if (modal?.kind !== 'confirm') throw new Error('expected a confirm')
    expect(modal.options).toMatchObject({
      title: 'Delete 2 tags?',
      message: 'This removes them from every document. This cannot be undone.',
      danger: true
    })
    await confirmTop(true)
    expect(calls.at(-1)).toEqual(['tag:deleteMany', { ids: ['t-mara', 't-moody'] }])
    expect(useTagStore.getState().ids).toEqual(['t-forest'])
    expect(toasts()).toEqual(['Deleted 2 tags'])
    expect(within(bulk()).getByText('0 selected')).toBeInTheDocument()
  })

  it('a cancelled delete sends nothing', async () => {
    const user = userEvent.setup()
    const calls = await renderLoaded()
    await user.click(screen.getByRole('button', { name: 'Select' }))
    await user.click(box('mara'))
    await user.click(within(bulk()).getByRole('button', { name: 'Delete' }))
    await confirmTop(false)
    expect(calls.filter(([channel]) => channel === 'tag:deleteMany')).toHaveLength(0)
    expect(box('mara')).toBeChecked()
  })

  it('a color pick recolors every checked tag in one request', async () => {
    const user = userEvent.setup()
    const calls = await renderLoaded({
      'tag:recolor': (input) => {
        const { ids, color } = input as Input<'tag:recolor'>
        return ids.map((id) => ({ ...useTagStore.getState().byId[id]!, color }))
      }
    })
    await user.click(screen.getByRole('button', { name: 'Select' }))
    const color = within(bulk()).getByLabelText('Color for selected tags')
    expect(color).toBeDisabled()
    await user.click(box('dark-forest'))
    await user.click(box('moody'))
    fireEvent.change(color, { target: { value: '#123456' } })
    await waitFor(() => expect(useTagStore.getState().byId['t-moody']?.color).toBe('#123456'))
    expect(calls.filter(([channel]) => channel === 'tag:recolor')).toEqual([
      ['tag:recolor', { ids: ['t-forest', 't-moody'], color: '#123456' }]
    ])
    expect(useTagStore.getState().byId['t-forest']?.color).toBe('#123456')
    expect(useTagStore.getState().byId['t-mara']?.color).toBe('#dc2626')
  })

  it('Merge needs two tags, asks first, and folds the others into the chosen one', async () => {
    const user = userEvent.setup()
    const calls = await renderLoaded({
      'tag:merge': () => ({
        target: { ...tagFixture[1]!, usageCount: 4 },
        removedIds: ['t-forest'],
        aliases: { 't-forest': 't-mara' }
      })
    })
    await user.click(screen.getByRole('button', { name: 'Select' }))
    const mergeButton = within(bulk()).getByRole('button', { name: 'Merge' })
    await user.click(box('dark-forest'))
    expect(mergeButton).toBeDisabled()
    await user.click(box('mara'))
    expect(mergeButton).toBeEnabled()
    await user.selectOptions(within(bulk()).getByRole('combobox', { name: 'Merge into' }), 'mara')
    await user.click(mergeButton)
    const modal = useDialogStore.getState().modals[0]
    if (modal?.kind !== 'confirm') throw new Error('expected a confirm')
    expect(modal.options).toMatchObject({
      title: 'Merge 1 tag into "mara"?',
      confirmLabel: 'Merge',
      danger: true
    })
    await confirmTop(true)
    expect(calls.at(-1)).toEqual(['tag:merge', { targetId: 't-mara', sourceIds: ['t-forest'] }])
    expect(within(list()).getAllByRole('checkbox')).toHaveLength(2)
    expect(box('mara')).toBeChecked()
    expect(box('mara')).toHaveAccessibleName(/4 uses/)
    expect(useTagStore.getState().aliases).toEqual({ 't-forest': 't-mara' })
    expect(toasts()).toEqual(['Merged 1 tag into "mara"'])
  })

  it('a failed merge toasts and keeps the bank and the selection', async () => {
    const user = userEvent.setup()
    await renderLoaded({ 'tag:merge': failing('Database is locked') })
    await user.click(screen.getByRole('button', { name: 'Select' }))
    await user.click(box('dark-forest'))
    await user.click(box('mara'))
    await user.click(within(bulk()).getByRole('button', { name: 'Merge' }))
    await confirmTop(true)
    expect(toasts()).toEqual(['Database is locked'])
    expect(useTagStore.getState().ids).toEqual(['t-forest', 't-mara', 't-moody'])
    expect(within(bulk()).getByText('2 selected')).toBeInTheDocument()
  })

  it('Import… merges what main created and reports both counts; a cancel says nothing', async () => {
    const user = userEvent.setup()
    let answer: Output<'tag:import'> = null
    const calls = await renderLoaded({ 'tag:import': () => answer })
    const importButton = screen.getByRole('button', { name: 'Import…' })
    await user.click(importButton)
    await waitFor(() => expect(importButton).toBeEnabled())
    expect(calls.at(-1)).toEqual(['tag:import', {}])
    expect(toasts()).toEqual([])
    answer = {
      created: [{ ...tagFixture[2]!, id: 't-alpha', name: 'alpha', usageCount: 0 }],
      skipped: ['mara', 'moody']
    }
    await user.click(importButton)
    await waitFor(() => expect(toasts()).toEqual(['Imported 1 tag, skipped 2 already in the bank']))
    expect(rowNames()).toEqual(['alpha', 'dark-forest', 'mara', 'moody'])
  })

  it('Export… reports the path and count; an error toasts with its cause', async () => {
    const user = userEvent.setup()
    let fail = false
    await renderLoaded({
      'tag:export': () => {
        if (fail) throw new IpcRequestError({ code: 'IO', message: 'Disk full' })
        return { path: '/books/Saga tags.json', count: 3 }
      }
    })
    const exportButton = screen.getByRole('button', { name: 'Export…' })
    await user.click(exportButton)
    await waitFor(() => expect(toasts()).toEqual(['Exported 3 tags to Saga tags.json']))
    fail = true
    await user.click(exportButton)
    await waitFor(() => expect(toasts()).toHaveLength(2))
    expect(toasts()[1]).toContain('Disk full')
  })

  it('an empty bank cannot export or select', async () => {
    await renderLoaded({ 'tag:list': () => [] })
    expect(screen.getByRole('button', { name: 'Export…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Select' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Import…' })).toBeEnabled()
  })
})

describe('TagDetail record (F-9.12)', () => {
  const mara = (tagId: string | null): Entity => {
    const found = entityFixture.find((entity) => entity.id === 'e-mara')
    if (!found) throw new Error('fixture lost Mara')
    return { ...found, tagId }
  }

  beforeEach(() => {
    resetTagStore()
    resetCustomTemplateStore()
    resetDocumentTagStore()
    resetMentionStore()
    resetEntityStore()
    useTreeStore.getState().clear()
    useDialogStore.setState({ modals: [], toasts: [] })
  })
  afterEach(() => {
    resetEntityStore()
  })

  it('opens the record a tag points at', async () => {
    const user = userEvent.setup()
    useEntityStore.getState().merge(mara('t-mara'))
    const calls = await renderLoaded()
    await user.click(row('mara'))
    expect(screen.queryByRole('button', { name: 'Make a record' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Open record' }))
    expect(useEntityStore.getState().selectedId).toBe('e-mara')
    expect(calls.some(([channel]) => channel === 'tag:makeRecord')).toBe(false)
  })

  it('makes a record for a tag that has none, merges it, and opens it', async () => {
    const user = userEvent.setup()
    const calls = await renderLoaded({
      'tag:makeRecord': () => ({
        entity: mara('t-mara'),
        tag: useTagStore.getState().byId['t-mara']
      })
    })
    await user.click(row('mara'))
    await user.click(screen.getByRole('button', { name: 'Make a record' }))
    await waitFor(() => expect(useEntityStore.getState().selectedId).toBe('e-mara'))
    expect(calls).toContainEqual(['tag:makeRecord', { tagId: 't-mara' }])
    expect(useEntityStore.getState().byId['e-mara']?.tagId).toBe('t-mara')
    expect(screen.getByRole('button', { name: 'Open record' })).toBeInTheDocument()
  })

  it('toasts the cause when the record cannot be made', async () => {
    const user = userEvent.setup()
    await renderLoaded({ 'tag:makeRecord': failing('A sheet named Mara has another tag') })
    await user.click(row('mara'))
    await user.click(screen.getByRole('button', { name: 'Make a record' }))
    await waitFor(() => expect(toasts().join(' ')).toContain('A sheet named Mara has another tag'))
    expect(useEntityStore.getState().selectedId).toBeNull()
  })
})
