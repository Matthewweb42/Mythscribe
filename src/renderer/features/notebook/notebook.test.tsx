import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { getSchema, type TiptapEditorHTMLElement } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import {
  notebookDocFromText,
  notebookPlain,
  type NotebookItem,
  type NotebookPage,
  type NotebookVersion
} from '@shared/notebook'
import {
  NOTEBOOK_STARTER_FOLDERS,
  NOTEBOOK_STARTER_OUTLINE_FOLDERS,
  NOTEBOOK_TEMPLATE_IDS,
  NOTEBOOK_TEMPLATES,
  notebookTemplate,
  templateDoc
} from '@shared/notebookTemplates'
import type { TiptapNodeT } from '@shared/tiptap'
import { buildExtensions } from '@renderer/features/editor/extensions'
import { resetEntityStore, useEntityStore } from '@renderer/features/entities/entityStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { IpcRequestError, setIpcClient } from '@renderer/lib/ipc'
import { takeDropped } from './droppedEntries'
import { NotebookPageView } from './NotebookPageView'
import { resetNotebookPageStore, useNotebookPageStore } from './notebookPageStore'
import { NEW_PAGE_TITLE, resetNotebookStore, unseenAiEdit, useNotebookStore } from './notebookStore'
import { NotesTab } from './NotesTab'
import { openNotebookPage, resetOpenNotebookPage, useOpenNotebookPageStore } from './openPage'
import { templateChoiceOf, templateMenuItems } from './templateMenu'

/**
 * Notes redesign phase 1, slice 1: the notebook store over a fake main that keeps the items and
 * versions as `notebookStore.ts` (main) does, the Notes tab's tree and toolbar, and the page view
 * with Ms Scribe's edit bar.
 */

interface Row extends NotebookPage {
  deleted: boolean
}

let rows: Row[]
let versions: NotebookVersion[]
let calls: [Channel, unknown][]
let listeners: Partial<Record<EventName, ((payload: unknown) => void)[]>>
let stamp = 0

const tick = (): string => new Date(Date.UTC(2026, 9, 15, 0, 0, stamp++)).toISOString()

function row(
  id: string,
  kind: NotebookItem['kind'],
  parentId: string | null,
  position: number,
  text = ''
): Row {
  const content = kind === 'page' && text !== '' ? notebookDocFromText(text) : null
  return {
    id,
    kind,
    parentId,
    position,
    title: id,
    modified: tick(),
    created: tick(),
    content,
    plain: notebookPlain(content),
    deleted: false
  }
}

const live = (): Row[] => rows.filter((r) => !r.deleted)
const itemOf = ({ id, parentId, kind, title, position, modified, role }: Row): NotebookItem => ({
  id,
  parentId,
  kind,
  title,
  position,
  modified,
  ...(role === undefined ? {} : { role })
})
const pageOf = (r: Row): NotebookPage => ({
  ...itemOf(r),
  content: r.content,
  plain: r.plain,
  created: r.created
})
const find = (id: string): Row => {
  const found = live().find((r) => r.id === id)
  if (found === undefined) throw new IpcRequestError({ code: 'NOT_FOUND', message: 'gone' })
  return found
}
const under = (id: string): string[] => [
  id,
  ...rows.filter((r) => r.parentId === id).flatMap((r) => under(r.id))
]

function emit(ids: string[]): void {
  for (const listener of listeners['notebook:changed'] ?? []) listener({ ids })
}

/** Ms Scribe's write as main makes it: the page as it was kept first, by `ai`. */
function aiWrite(id: string, text: string): void {
  const r = find(id)
  versions.unshift({
    id: `v-${versions.length + 1}`,
    pageId: id,
    author: 'ai',
    title: r.title,
    content: r.content,
    created: tick()
  })
  r.content = notebookDocFromText(text)
  r.plain = text
  r.modified = tick()
}

function install(): void {
  calls = []
  listeners = {}
  setIpcClient({
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      await Promise.resolve()
      switch (channel) {
        case 'notebook:list':
          return live()
            .sort((a, b) => a.position - b.position)
            .map(itemOf) as Output<C>
        case 'notebook:get':
          return pageOf(find((input as Input<'notebook:get'>).id)) as Output<C>
        case 'notebook:create': {
          const { parentId, kind, title, content } = input as Input<'notebook:create'>
          const made = row(`n-${rows.length + 1}`, kind, parentId, rows.length)
          made.title = title
          made.content = content ?? null
          made.plain = notebookPlain(made.content)
          rows.push(made)
          return pageOf(made) as Output<C>
        }
        case 'notebook:update': {
          const { id, title, content } = input as Input<'notebook:update'>
          const r = find(id)
          if (title !== undefined) r.title = title
          if (content !== undefined) {
            r.content = content
            r.plain = notebookPlain(content)
          }
          r.modified = tick()
          return pageOf(r) as Output<C>
        }
        case 'notebook:move': {
          const { id, parentId, position } = input as Input<'notebook:move'>
          Object.assign(find(id), { parentId, position })
          return null as Output<C>
        }
        case 'notebook:delete':
          for (const id of under((input as Input<'notebook:delete'>).id)) {
            const r = rows.find((each) => each.id === id)
            if (r) r.deleted = true
          }
          return null as Output<C>
        case 'notebook:restore': {
          const { id } = input as Input<'notebook:restore'>
          for (const each of under(id)) {
            const r = rows.find((x) => x.id === each)
            if (r) r.deleted = false
          }
          return itemOf(find(id)) as Output<C>
        }
        case 'notebook:versions': {
          const { id } = input as Input<'notebook:versions'>
          return versions.filter((v) => v.pageId === id) as Output<C>
        }
        case 'notebook:restoreVersion': {
          const { versionId } = input as Input<'notebook:restoreVersion'>
          const version = versions.find((v) => v.id === versionId)
          if (version === undefined) throw new Error('no version')
          const r = find(version.pageId)
          versions.unshift({
            ...version,
            id: `v-${versions.length + 1}`,
            author: 'me',
            content: r.content
          })
          r.content = version.content
          r.plain = notebookPlain(version.content)
          return pageOf(r) as Output<C>
        }
        case 'notebook:import': {
          const { files } = input as Input<'notebook:import'>
          const made = (files ?? []).map((file, at) => {
            const r = row(`imp-${at}`, 'page', null, 10 + at, 'Imported text')
            r.title = file.name.replace(/\.[^.]+$/, '')
            rows.push(r)
            return itemOf(r)
          })
          return { items: made, skipped: [{ name: 'art.png', reason: 'No text.' }] } as Output<C>
        }
        case 'layout:set':
          return input as Output<C>
        default:
          throw new Error(`unexpected ${channel}`)
      }
    },
    on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void) {
      const list: ((payload: unknown) => void)[] = listeners[event] ?? []
      list.push(listener as (payload: unknown) => void)
      listeners[event] = list
      return () => {
        listeners[event] = (listeners[event] ?? []).filter((each) => each !== listener)
      }
    }
  })
}

const sent = (channel: Channel): unknown[] =>
  calls.filter(([each]) => each === channel).map(([, input]) => input)
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)
const text = (doc: TiptapNodeT | null | undefined): string =>
  doc == null ? '' : notebookPlain(doc)

beforeEach(() => {
  stamp = 0
  rows = [
    row('People', 'folder', null, 0),
    row('Mara', 'page', 'People', 0, 'Eyes: grey.'),
    row('Ideas', 'page', null, 1, 'A twin in the north.')
  ]
  versions = []
  window.localStorage.clear()
  resetNotebookStore()
  resetNotebookPageStore()
  resetPendingSaves()
  resetEntityStore()
  resetOpenNotebookPage()
  install()
})
afterEach(() => {
  resetNotebookStore()
  resetNotebookPageStore()
  resetPendingSaves()
  resetEntityStore()
  resetOpenNotebookPage()
  setIpcClient(null)
})

describe('the notebook store', () => {
  it('loads the tree and refetches it when main says the notebook changed', async () => {
    const store = useNotebookStore.getState
    store().subscribe('p-1')
    await store().load()
    expect(store().childrenOf['']).toEqual(['People', 'Ideas'])
    expect(store().childrenOf.People).toEqual(['Mara'])
    rows.push(row('Places', 'folder', null, 2))
    act(() => emit(['Places']))
    await waitFor(() => expect(store().childrenOf['']).toEqual(['People', 'Ideas', 'Places']))
  })

  it('opens the page Ms Scribe links to, refetching the tree for a page she just made', async () => {
    const store = useNotebookStore.getState
    await store().load()
    openNotebookPage('Mara')
    expect(store().openId).toBe('Mara')
    rows.push(row('Powers', 'page', null, 2, 'Blood over dragon.'))
    openNotebookPage('Powers')
    await waitFor(() => expect(store().openId).toBe('Powers'))
  })

  it('makes a page in the selected folder, opens it and starts its rename', async () => {
    const store = useNotebookStore.getState
    await store().load()
    store().select('People')
    const made = await store().create('page')
    expect(sent('notebook:create')).toEqual([
      { parentId: 'People', kind: 'page', title: NEW_PAGE_TITLE }
    ])
    expect(store()).toMatchObject({ openId: made.id, selectedId: made.id, renamingId: made.id })
    const folder = await store().create('folder', null)
    expect(folder.parentId).toBeNull()
    expect(store().openId).toBe(made.id)
  })

  it('deletes a folder with what is in it, closes its open page, and Undo brings it back', async () => {
    const store = useNotebookStore.getState
    await store().load()
    store().open('Mara')
    await store().remove('People')
    expect(store().openId).toBeNull()
    expect(store().byId.Mara).toBeUndefined()
    const toast = useDialogStore.getState().toasts.at(-1)
    expect(toast?.message).toBe('Deleted “People”')
    act(() => toast?.action?.run())
    await waitFor(() => expect(store().byId.Mara?.parentId).toBe('People'))
    expect(sent('notebook:restore')).toEqual([{ id: 'People' }])
  })

  it('moves an item and renames one', async () => {
    const store = useNotebookStore.getState
    await store().load()
    await store().move('Ideas', 'People', 5)
    expect(store().childrenOf.People).toEqual(['Mara', 'Ideas'])
    await store().rename('Ideas', 'Maybes')
    expect(store().byId.Ideas?.title).toBe('Maybes')
  })

  it('opening a page closes an entity page, and picking an entity closes the note page', async () => {
    const store = useNotebookStore.getState
    await store().load()
    useEntityStore.setState({ selectedId: 'e-1' })
    store().open('Mara')
    expect(useEntityStore.getState().selectedId).toBeNull()
    expect(store().openId).toBe('Mara')
    useEntityStore.getState().select('e-2')
    expect(store().openId).toBeNull()
  })

  it('imports dropped files into the target folder and says what it skipped', async () => {
    const store = useNotebookStore.getState
    await store().load()
    await store().importFiles(
      [{ name: 'Reef.md', folders: [], data: new Uint8Array([35]) }],
      'People'
    )
    expect(sent('notebook:import')).toEqual([
      { parentId: 'People', files: [{ name: 'Reef.md', folders: [], data: new Uint8Array([35]) }] }
    ])
    expect(toasts()).toEqual(['Imported 1 page', 'art.png: No text.'])
    expect(store().openId).toBe('imp-0')
  })
})

describe('Ms Scribe’s edit on a page', () => {
  it('raises the bar only for an unseen newest version by Ms Scribe', () => {
    const v = (id: string, author: NotebookVersion['author']): NotebookVersion => ({
      id,
      pageId: 'Mara',
      author,
      title: 'Mara',
      content: null,
      created: tick()
    })
    expect(unseenAiEdit('Mara', [], undefined)).toBeNull()
    expect(unseenAiEdit('Mara', [v('v-2', 'me'), v('v-1', 'ai')], undefined)).toBeNull()
    expect(unseenAiEdit('Mara', [v('v-1', 'ai')], 'v-1')).toBeNull()
    expect(unseenAiEdit('Mara', [v('v-1', 'ai')], undefined)).toEqual({
      pageId: 'Mara',
      versionId: 'v-1',
      before: null
    })
  })

  it('shows the bar on the open page, highlights the changed line, and Undo restores the page', async () => {
    const store = useNotebookStore.getState
    store().subscribe('p-1')
    await store().load()
    render(<NotebookPageView id="Mara" />)
    act(() => store().open('Mara'))
    await screen.findByRole('textbox', { name: 'Note page' })
    expect(screen.queryByTestId('notebook-ai-edit')).not.toBeInTheDocument()

    // Ms Scribe edits the page while it is open: main writes it and says so.
    aiWrite('Mara', 'Eyes: brown.\nSwore to find the heir.')
    act(() => emit(['Mara']))
    const bar = await screen.findByTestId('notebook-ai-edit')
    expect(bar).toHaveTextContent('Ms Scribe edited this page')
    await waitFor(() =>
      expect(text(useNotebookPageStore.getState().docs.Mara?.content)).toBe(
        'Eyes: brown.\nSwore to find the heir.'
      )
    )

    fireEvent.click(within(bar).getByRole('button', { name: 'Show changes' }))
    const changes = screen.getByTestId('notebook-changes')
    const changed = changes.querySelectorAll('[data-changed="true"]')
    expect(Array.from(changed).map((line) => line.textContent)).toEqual([
      'Eyes: grey.brown.',
      'Swore to find the heir.'
    ])
    expect(changes.querySelector('del')).toHaveTextContent('grey.')

    fireEvent.click(within(bar).getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(screen.queryByTestId('notebook-ai-edit')).not.toBeInTheDocument())
    expect(sent('notebook:restoreVersion')).toEqual([{ versionId: 'v-1' }])
    await waitFor(() =>
      expect(text(useNotebookPageStore.getState().docs.Mara?.content)).toBe('Eyes: grey.')
    )
  })

  it('opens at the passage a source quotes, selected, and takes the quote once', async () => {
    const store = useNotebookStore.getState
    await store().load()
    render(<NotebookPageView id="Mara" />)
    act(() => openNotebookPage('Mara', 'grey.'))
    await waitFor(() => {
      const box: TiptapEditorHTMLElement = screen.getByRole('textbox', { name: 'Note page' })
      const selection = box.editor?.state.selection
      expect(selection && box.editor?.state.doc.textBetween(selection.from, selection.to)).toBe(
        'grey.'
      )
    })
    expect(useOpenNotebookPageStore.getState().quote).toBeNull()
  })

  it('shows the bar once when the page opens after the edit, not again on the next open', async () => {
    const store = useNotebookStore.getState
    store().subscribe('p-1')
    await store().load()
    aiWrite('Mara', 'Eyes: brown.')
    store().open('Mara')
    await waitFor(() => expect(store().aiEdit).toMatchObject({ pageId: 'Mara', versionId: 'v-1' }))
    store().dismissAiEdit()
    store().close()
    store().open('Mara')
    await waitFor(() => expect(sent('notebook:versions')).toHaveLength(2))
    expect(store().aiEdit).toBeNull()
  })

  it('the echo of the author’s own save does not reload her editor', async () => {
    const store = useNotebookStore.getState
    store().subscribe('p-1')
    await store().load()
    store().open('Mara')
    const pages = useNotebookPageStore.getState
    await pages().load('Mara')
    pages().edit('Mara', notebookDocFromText('Eyes: green.'))
    await pages().flush()
    const reads = sent('notebook:get').length
    act(() => emit(['Mara']))
    await waitFor(() => expect(sent('notebook:get').length).toBe(reads + 1))
    // Same text stored as shown: no reload (a reload would read the page once more).
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sent('notebook:get').length).toBe(reads + 1)
    expect(text(pages().docs.Mara?.content)).toBe('Eyes: green.')
  })
})

describe('the Notes tab', () => {
  it('lists folders and pages, makes a page from the toolbar, and opens a page on click', async () => {
    await useNotebookStore.getState().load()
    render(<NotesTab />)
    const tree = screen.getByRole('tree', { name: 'Notes' })
    expect(
      within(tree)
        .getAllByRole('treeitem')
        .map((i) => i.getAttribute('aria-label'))
    ).toEqual(['People', 'Mara', 'Ideas'])
    fireEvent.click(within(tree).getByText('Ideas'))
    expect(useNotebookStore.getState().openId).toBe('Ideas')

    fireEvent.click(screen.getByRole('button', { name: 'New page' }))
    const input = await screen.findByRole('textbox', { name: 'Rename' })
    fireEvent.change(input, { target: { value: 'Timeline' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() =>
      expect(within(tree).getByRole('treeitem', { name: 'Timeline' })).toBeInTheDocument()
    )
  })

  it('collapses a folder from its chevron and deletes from the row’s menu', async () => {
    await useNotebookStore.getState().load()
    render(<NotesTab />)
    const tree = screen.getByRole('tree', { name: 'Notes' })
    fireEvent.click(within(tree).getByRole('button', { name: 'Collapse People' }))
    expect(within(tree).queryByText('Mara')).not.toBeInTheDocument()
    fireEvent.contextMenu(within(tree).getByText('Ideas'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    await waitFor(() => expect(within(tree).queryByText('Ideas')).not.toBeInTheDocument())
    expect(toasts()).toContain('Deleted “Ideas”')
  })

  it('reads dropped files from the plain list when the drop has no entries', async () => {
    const file = new File(['# Reef'], 'Reef.md')
    const read = await takeDropped({ items: [], files: [file] })()
    expect(read).toHaveLength(1)
    expect(read[0]).toMatchObject({ name: 'Reef.md', folders: [] })
  })
})

describe('note templates (phase 6)', () => {
  const created = (): Input<'notebook:create'>[] =>
    sent('notebook:create') as Input<'notebook:create'>[]

  it('each built-in loads in the notes editor’s schema with its headings', () => {
    const schema = getSchema(buildExtensions({ sceneBreak: '* * *', onSave: () => undefined }))
    for (const id of NOTEBOOK_TEMPLATE_IDS) {
      const template = notebookTemplate(id)
      const loaded = schema.nodeFromJSON(templateDoc(template))
      loaded.check()
      const headings: string[] = []
      loaded.forEach((block) => {
        if (block.type.name === 'heading') headings.push(block.textContent)
      })
      expect(headings).toEqual(template.headings)
    }
  })

  it('the menu lists My templates first, then the built-ins', async () => {
    rows.push(row('Templates', 'folder', null, 3), row('Villain', 'page', 'Templates', 0, 'Wants'))
    const store = useNotebookStore.getState
    await store().load()
    const items = templateMenuItems(store())
    expect(items.map((item) => item.label)).toEqual([
      'My templates',
      'Villain',
      'Built-in',
      ...NOTEBOOK_TEMPLATES.map((template) => template.name)
    ])
    expect(items.filter((item) => item.heading === true)).toHaveLength(2)
    expect(templateChoiceOf(items[1]?.id ?? '')).toEqual({ kind: 'mine', pageId: 'Villain' })
    expect(templateChoiceOf('template-built-in:character')).toEqual({
      kind: 'builtIn',
      id: 'character'
    })
    expect(templateChoiceOf('template-built-in:nope')).toBeNull()
    rows = rows.filter((r) => r.id !== 'Templates' && r.id !== 'Villain')
    await store().load()
    expect(templateMenuItems(store()).some((item) => item.heading === true)).toBe(false)
  })

  it('makes a page from the Character template in the toolbar, opened with its title to type over', async () => {
    await useNotebookStore.getState().load()
    render(<NotesTab />)
    fireEvent.click(screen.getByRole('button', { name: 'New from template' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Character' }))
    await screen.findByRole('textbox', { name: 'Rename' })
    expect(created()).toEqual([
      {
        parentId: null,
        kind: 'page',
        title: 'New character',
        content: templateDoc(notebookTemplate('character'))
      }
    ])
    expect(useNotebookStore.getState().openId).toBe(useNotebookStore.getState().renamingId)
  })

  it('a folder’s menu makes a page from one of her templates inside that folder', async () => {
    rows.push(row('Templates', 'folder', null, 3), row('Villain', 'page', 'Templates', 0, 'Wants'))
    await useNotebookStore.getState().load()
    render(<NotesTab />)
    const tree = screen.getByRole('tree', { name: 'Notes' })
    fireEvent.contextMenu(within(tree).getByText('People'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'New from template ›' }))
    expect(screen.getByText('My templates')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Villain' }))
    await waitFor(() => expect(created()).toHaveLength(1))
    expect(created()[0]).toEqual({
      parentId: 'People',
      kind: 'page',
      title: 'Villain',
      content: notebookDocFromText('Wants')
    })
  })

  it('Save as template copies the page into Templates, making the folder once', async () => {
    const store = useNotebookStore.getState
    await store().load()
    render(<NotesTab />)
    const tree = screen.getByRole('tree', { name: 'Notes' })
    fireEvent.contextMenu(within(tree).getByText('Mara'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save as template' }))
    await waitFor(() => expect(toasts()).toContain('Saved “Mara” as a template'))
    await store().saveAsTemplate('Ideas')
    const folders = live().filter((r) => r.kind === 'folder' && r.title === 'Templates')
    expect(folders).toHaveLength(1)
    const copies = live().filter((r) => r.parentId === folders[0]?.id)
    expect(copies.map((r) => [r.title, r.plain])).toEqual([
      ['Mara', 'Eyes: grey.'],
      ['Ideas', 'A twin in the north.']
    ])
    // A page already in Templates is not offered again.
    const copy = copies[0]?.id ?? ''
    await waitFor(() => expect(within(tree).getAllByText('Mara')).toHaveLength(2))
    fireEvent.contextMenu(
      within(tree)
        .getAllByRole('treeitem')
        .find((each) => each.dataset.notebookId === copy)
        ?.querySelector('div') ?? tree
    )
    expect(screen.queryByRole('menuitem', { name: 'Save as template' })).not.toBeInTheDocument()
  })

  it('an empty Notes starts with the folders and a Style guide page, made once', async () => {
    rows = []
    const store = useNotebookStore.getState
    await store().load()
    render(<NotesTab />)
    expect(screen.getByRole('button', { name: 'Start blank' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Start with folders' }))
    const tree = await screen.findByRole('tree', { name: 'Notes' })
    expect(
      within(tree)
        .getAllByRole('treeitem')
        .map((item) => item.getAttribute('aria-label'))
    ).toEqual([...NOTEBOOK_STARTER_FOLDERS, 'Style guide'])
    const guide = live().find((r) => r.title === 'Style guide')
    expect(guide?.content).toEqual(templateDoc(notebookTemplate('styleGuide')))
    const made = created().length
    await store().startWithFolders()
    expect(created()).toHaveLength(made)
  })
})

describe('the notes binder (2026-10-16)', () => {
  /** A section root as main makes it. */
  const root = (id: string, role: NonNullable<NotebookItem['role']>, position: number): Row => ({
    ...row(id, 'folder', null, position),
    role
  })
  const created = (): Input<'notebook:create'>[] =>
    sent('notebook:create') as Input<'notebook:create'>[]

  beforeEach(() => {
    rows = [
      root('Outline', 'outline', 0),
      root('Timeline', 'timeline', 1),
      root('Documents', 'documents', 2),
      row('People', 'folder', 'Documents', 0),
      row('Mara', 'page', 'People', 0, 'Eyes: grey.')
    ]
  })

  const sectionRow = (tree: HTMLElement, name: string): HTMLElement => {
    const found = within(tree)
      .getAllByRole('treeitem')
      .find((each) => each.getAttribute('aria-label') === name)
    const div = found?.querySelector<HTMLElement>(':scope > div')
    if (!div) throw new Error(`no row ${name}`)
    return div
  }

  it('draws the three sections as section rows that fold on a click', async () => {
    await useNotebookStore.getState().load()
    render(<NotesTab />)
    const tree = screen.getByRole('tree', { name: 'Notes' })
    const top = within(tree)
      .getAllByRole('treeitem')
      .filter((each) => each.getAttribute('aria-level') === '1')
    expect(top.map((each) => each.getAttribute('aria-label'))).toEqual([
      'Outline',
      'Timeline',
      'Documents'
    ])
    const documents = sectionRow(tree, 'Documents')
    expect(documents).toHaveAttribute('data-section', 'documents')
    expect(documents.className).toContain('uppercase')
    expect(documents).toHaveAttribute('draggable', 'false')
    expect(within(tree).getByText('People')).toBeInTheDocument()
    fireEvent.click(documents)
    expect(within(tree).queryByText('People')).not.toBeInTheDocument()
    fireEvent.click(documents)
    expect(within(tree).getByText('People')).toBeInTheDocument()
  })

  it('a section’s plus and menu make things inside it, with no Rename, Move or Delete', async () => {
    await useNotebookStore.getState().load()
    render(<NotesTab />)
    const tree = screen.getByRole('tree', { name: 'Notes' })
    fireEvent.click(within(tree).getByRole('button', { name: 'New in Outline' }))
    expect(screen.getAllByRole('menuitem').map((each) => each.textContent)).toEqual([
      'New page',
      'New from template ›',
      'New folder'
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: 'New page' }))
    await waitFor(() => expect(created()).toHaveLength(1))
    expect(created()[0]).toEqual({ parentId: 'Outline', kind: 'page', title: NEW_PAGE_TITLE })

    fireEvent.contextMenu(sectionRow(tree, 'Timeline'))
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'New folder' }))
    await waitFor(() => expect(created()).toHaveLength(2))
    expect(created()[1]).toMatchObject({ parentId: 'Timeline', kind: 'folder' })
  })

  it('the toolbar makes a page in Documents when nothing is selected', async () => {
    await useNotebookStore.getState().load()
    render(<NotesTab />)
    fireEvent.click(screen.getByRole('button', { name: 'New page' }))
    await waitFor(() => expect(created()).toHaveLength(1))
    expect(created()[0]).toEqual({ parentId: 'Documents', kind: 'page', title: NEW_PAGE_TITLE })
  })

  it('offers the starter set while Documents is empty: folders in Documents, Chapter plans in Outline', async () => {
    rows = rows.filter((each) => each.role !== undefined)
    const store = useNotebookStore.getState
    await store().load()
    render(<NotesTab />)
    fireEvent.click(screen.getByRole('button', { name: 'Start with folders' }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Start with folders' })).not.toBeInTheDocument()
    )
    const made = created().map((each) => [each.parentId, each.title])
    expect(made).toEqual([
      ...NOTEBOOK_STARTER_FOLDERS.map((title) => ['Documents', title]),
      ['Documents', 'Style guide'],
      ...NOTEBOOK_STARTER_OUTLINE_FOLDERS.map((title) => ['Outline', title])
    ])
    await store().startWithFolders()
    expect(created()).toHaveLength(made.length)
  })

  it('Save as template keeps the Templates folder in Documents', async () => {
    const store = useNotebookStore.getState
    await store().load()
    await store().saveAsTemplate('Mara')
    const folder = live().find((each) => each.title === 'Templates')
    expect(folder?.parentId).toBe('Documents')
  })
})
