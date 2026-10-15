import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { TiptapEditorHTMLElement } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import {
  notebookDocFromText,
  notebookPlain,
  type NotebookItem,
  type NotebookPage,
  type NotebookVersion
} from '@shared/notebook'
import type { TiptapNodeT } from '@shared/tiptap'
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
const itemOf = ({ id, parentId, kind, title, position, modified }: Row): NotebookItem => ({
  id,
  parentId,
  kind,
  title,
  position,
  modified
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
          const { parentId, kind, title } = input as Input<'notebook:create'>
          const made = row(`n-${rows.length + 1}`, kind, parentId, rows.length)
          made.title = title
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
