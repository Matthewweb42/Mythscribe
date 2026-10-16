import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings } from '@shared/aiSettings'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import type { NotebookItem } from '@shared/notebook'
import type { NotesSortRunResult } from '@shared/notesSort'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore } from '@renderer/features/shell/layoutStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { NotesImportDialog } from './NotesImportDialog'
import { resetNotebookStore, useNotebookStore } from './notebookStore'
import { resetNotesSortStore, sortTitleOf, useNotesSortStore } from './notesSortStore'

/**
 * Notes structure B in the renderer: the choice a drop or a pick asks (One page each, Split at
 * headings, Sort with Ms Scribe, priced), a page split from its menu with Undo on the toast, and a
 * sort's one Undo.
 */

const item = (id: string, kind: NotebookItem['kind'], parentId: string | null): NotebookItem => ({
  id,
  parentId,
  kind,
  title: id,
  position: 0,
  modified: '2026-10-16T10:00:00.000Z'
})

let items: NotebookItem[]
let calls: [Channel, unknown][]
let sortResult: NotesSortRunResult

const sent = (channel: Channel): unknown[] =>
  calls.filter(([each]) => each === channel).map(([, input]) => input)
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

function install(): void {
  calls = []
  setIpcClient({
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      await Promise.resolve()
      switch (channel) {
        case 'notebook:list':
          return items.map((each) => ({ ...each })) as Output<C>
        case 'notebook:import': {
          const { files, paths } = input as Input<'notebook:import'>
          const names = files?.map((file) => file.name) ?? paths ?? []
          const made = names.map((name, at) => item(`imp-${at}-${name}`, 'page', null))
          items.push(...made)
          return { items: made, skipped: [] } as Output<C>
        }
        case 'notebook:splitPage': {
          const { id } = input as Input<'notebook:splitPage'>
          const folder = item('Fenlands folder', 'folder', null)
          const pages = [item('Mara', 'page', folder.id), item('Rook', 'page', folder.id)]
          items = items.filter((each) => each.id !== id).concat(folder, ...pages)
          return { folder, pages, pageId: id } as Output<C>
        }
        case 'notebook:delete':
        case 'notebook:restore':
          return (channel === 'notebook:restore' ? item('x', 'page', null) : null) as Output<C>
        case 'notebook:restoreVersion':
          return {
            ...item('Mara', 'page', null),
            content: null,
            plain: '',
            created: ''
          } as Output<C>
        case 'notebook:versions':
          return [] as Output<C>
        case 'library:choose':
          return ['/home/me/World notes.md'] as Output<C>
        case 'notesSort:estimate':
          return {
            sources: 1,
            words: 900,
            requests: 1,
            tokensIn: 1_600,
            tokensOut: 1_300
          } as Output<C>
        case 'notesSort:run':
          return sortResult as Output<C>
        case 'layout:set':
          return input as Output<C>
        default:
          throw new Error(`unexpected ${channel}`)
      }
    },
    on() {
      return () => {}
    }
  })
}

beforeEach(() => {
  items = [item('People', 'folder', null), item('Fenlands', 'page', null)]
  sortResult = {
    ok: true,
    made: [
      item('Magic', 'folder', null),
      item('Shadow walking', 'page', 'Magic'),
      item('Rook', 'page', 'People')
    ],
    appended: [{ pageId: 'Mara', versionId: 'v-1', title: 'Mara' }],
    pages: 3,
    dropped: 0,
    unread: 0,
    stopped: null
  }
  resetNotebookStore()
  resetNotesSortStore()
  resetAiSettingsStore()
  install()
})
afterEach(() => {
  resetNotebookStore()
  resetNotesSortStore()
  resetAiSettingsStore()
  resetLayoutStore()
  setIpcClient(null)
})

const file = (name: string) => ({ name, folders: [], data: new Uint8Array([35]) })

describe('the choice before an import', () => {
  it('asks once for a drop, and Split at headings imports with the split', async () => {
    await useNotebookStore.getState().load()
    await useNotesSortStore.getState().askImport([file('World.md'), file('Plain.txt')], 'People')
    expect(useNotesSortStore.getState().choice).toMatchObject({
      kind: 'import',
      names: ['World.md', 'Plain.txt'],
      parentId: 'People',
      paths: null
    })
    await useNotesSortStore.getState().confirm('headings')
    expect(useNotesSortStore.getState().choice).toBeNull()
    expect(sent('notebook:import')).toEqual([
      { parentId: 'People', files: [file('World.md'), file('Plain.txt')], split: 'headings' }
    ])
    expect(sent('notesSort:run')).toEqual([])
  })

  it('picks files in the open dialog first, and One page each imports them as before', async () => {
    await useNotesSortStore.getState().askImport()
    expect(useNotesSortStore.getState().choice).toMatchObject({
      paths: ['/home/me/World notes.md'],
      names: ['World notes.md'],
      parentId: null
    })
    await useNotesSortStore.getState().confirm('none')
    expect(sent('notebook:import')).toEqual([
      { parentId: null, paths: ['/home/me/World notes.md'] }
    ])
  })

  it('Sort imports one page each, sorts those pages, and the one Undo takes it back', async () => {
    await useNotesSortStore.getState().askImport([file('World.md')], null)
    await useNotesSortStore.getState().confirm('sort')
    expect(sent('notebook:import')).toEqual([{ parentId: null, files: [file('World.md')] }])
    expect(sent('notesSort:run')).toEqual([{ pageIds: ['imp-0-World.md'] }])
    expect(useNotesSortStore.getState()).toMatchObject({
      running: null,
      done: { title: 'World', pages: 3, undone: false }
    })

    await useNotesSortStore.getState().undo()
    // The new folder takes its page with it; the page made in her folder goes alone.
    expect(sent('notebook:delete')).toEqual([{ id: 'Magic' }, { id: 'Rook' }])
    expect(sent('notebook:restoreVersion')).toEqual([{ versionId: 'v-1' }])
    expect(useNotesSortStore.getState().done?.undone).toBe(true)
    expect(toasts()).toContain('Undid the sort of World')
    await useNotesSortStore.getState().undo()
    expect(sent('notebook:delete')).toHaveLength(2)
  })

  it('keeps a failed sort’s cause with its next step', async () => {
    sortResult = {
      ok: false,
      code: 'NO_KEY',
      message: 'No API key is saved.',
      nextStep: 'Add one.'
    }
    await useNotesSortStore.getState().sort(['Fenlands'], 'Fenlands')
    expect(useNotesSortStore.getState()).toMatchObject({
      done: null,
      failed: { title: 'Fenlands', message: 'No API key is saved. Add one.' }
    })
  })

  it('names one file by its title and several by their count', () => {
    expect(sortTitleOf(['World notes.md'])).toBe('World notes')
    expect(sortTitleOf(['a.md', 'b.md'])).toBe('2 files')
  })
})

describe('a page split at its headings', () => {
  it('puts a folder in its place, with Undo on the toast', async () => {
    await useNotebookStore.getState().load()
    useNotebookStore.getState().select('Fenlands')
    await useNotebookStore.getState().splitPage('Fenlands')
    expect(sent('notebook:splitPage')).toEqual([{ id: 'Fenlands' }])
    expect(useNotebookStore.getState()).toMatchObject({
      openId: null,
      selectedId: 'Fenlands folder'
    })
    const toast = useDialogStore.getState().toasts.at(-1)
    expect(toast?.message).toBe('Split “Fenlands” into 2 pages')
    act(() => toast?.action?.run())
    await waitFor(() => expect(sent('notebook:restore')).toEqual([{ id: 'Fenlands' }]))
    expect(sent('notebook:delete')).toEqual([{ id: 'Fenlands folder' }])
  })
})

describe('the import dialog', () => {
  it('offers Sort with Ms Scribe only while it can run, priced before it starts', async () => {
    await useNotesSortStore.getState().askImport([file('World.md')], null)
    const view = render(<NotesImportDialog />)
    expect(screen.getByRole('dialog', { name: 'Add “World.md” to Notes' })).toBeTruthy()
    expect(
      screen.getAllByRole('radio').map((radio) => radio.closest('label')?.textContent)
    ).toEqual([
      'One page eachEach file becomes one page, as it is.',
      'Split at headingsA folder for each file, with a page for each of its main headings. No AI.'
    ])
    view.unmount()

    act(() => useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 1 } }))
    render(<NotesImportDialog />)
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    fireEvent.click(screen.getByRole('radio', { name: /Sort with Ms Scribe/ }))
    await waitFor(() =>
      expect(screen.getByTestId('notes-sort-price').textContent).toContain('900 words')
    )
    expect(sent('notesSort:estimate')).toEqual([{ files: [file('World.md')] }])
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }))
    await waitFor(() => expect(sent('notesSort:run')).toEqual([{ pageIds: ['imp-0-World.md'] }]))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('asks a page’s sort with its price, and Escape closes it', async () => {
    act(() => useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 1 } }))
    await useNotebookStore.getState().load()
    useNotesSortStore.getState().askSort('Fenlands')
    render(<NotesImportDialog />)
    expect(screen.getByRole('dialog', { name: 'Sort “Fenlands” with Ms Scribe' })).toBeTruthy()
    await waitFor(() => expect(sent('notesSort:estimate')).toEqual([{ pageIds: ['Fenlands'] }]))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(sent('notesSort:run')).toEqual([])
  })
})
