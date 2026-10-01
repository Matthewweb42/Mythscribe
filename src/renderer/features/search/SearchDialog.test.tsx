import { Editor } from '@tiptap/core'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import {
  SEARCH_MAX_RESULTS,
  SEARCH_TYPES,
  type SearchRequest,
  type SearchResponse,
  type SearchResult
} from '@shared/search'
import {
  resetActiveEditorStore,
  useActiveEditorStore
} from '@renderer/features/editor/activeEditorStore'
import { buildExtensions } from '@renderer/features/editor/extensions'
import { entityFixture } from '@renderer/features/entities/entityFixture'
import { resetEntityStore, useEntityStore } from '@renderer/features/entities/entityStore'
import { resetFocusStore, useFocusStore } from '@renderer/features/focus/focusStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { tagFixture } from '@renderer/features/tags/tagFixture'
import { resetTagStore, useTagStore } from '@renderer/features/tags/tagStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { SearchButton, SearchDialog } from './SearchDialog'
import { resetSearchStore, useSearchStore } from './searchStore'

const sceneHit: SearchResult = {
  type: 'document',
  id: 'sc-1',
  title: 'Scene 1',
  location: 'Chapter 1',
  field: null,
  snippet: {
    text: '…waited at the dark forest. Rose waited too.',
    highlights: [
      [1, 7],
      [33, 39]
    ]
  },
  titleHighlights: [],
  count: 2
}
const titleHit: SearchResult = {
  type: 'document',
  id: 'sc-2',
  title: 'Waited',
  location: 'Chapter 2',
  field: null,
  snippet: { text: 'Nothing of note.', highlights: [] },
  titleHighlights: [[0, 6]],
  count: 1
}
const notesHit: SearchResult = {
  type: 'notes',
  id: 'sc-3',
  title: 'Scene 3',
  location: 'Chapter 3',
  field: null,
  snippet: { text: 'She waited here.', highlights: [[4, 10]] },
  titleHighlights: [],
  count: 1
}
const entityHit: SearchResult = {
  type: 'character',
  id: 'e-mara',
  title: 'Mara',
  location: 'character',
  field: 'Appearance',
  snippet: { text: 'Tall; she waited often.', highlights: [[10, 16]] },
  titleHighlights: [],
  count: 1
}
const all: SearchResponse = {
  results: [sceneHit, titleHit, notesHit, entityHit],
  total: 4,
  truncated: false
}

let requests: SearchRequest[]
let answer: SearchResponse
let editor: Editor | null

function install(): void {
  requests = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'search:query') {
        requests.push(input as SearchRequest)
        return answer as Output<C>
      }
      if (channel === 'layout:set' || channel === 'window:setFullScreen') return input as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
}

/** The dialog open on an answered query, without waiting on the debounce. */
function openWith(response: SearchResponse, query = 'waited'): void {
  useSearchStore.setState({
    open: true,
    query,
    response,
    answeredQuery: query,
    status: 'done',
    error: null
  })
  render(<SearchDialog />)
}

const dialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Search project' })
const box = (): HTMLElement => screen.getByRole('searchbox', { name: 'Search the project' })
/** The result rows: the options of the results listbox, not the tag select's. */
const options = (): HTMLElement[] =>
  within(screen.getByRole('listbox', { name: 'Search results' })).queryAllByRole('option')
const selected = (): string | null | undefined =>
  options().find((option) => option.getAttribute('aria-selected') === 'true')?.textContent
const marks = (element: HTMLElement): (string | null)[] =>
  Array.from(element.querySelectorAll('mark')).map((mark) => mark.textContent)

beforeEach(() => {
  answer = all
  editor = null
  install()
  resetSearchStore()
  resetTagStore()
  resetEntityStore()
  resetFocusStore()
  resetLayoutStore()
  resetActiveEditorStore()
  useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true, selectedId: null })
  useDialogStore.setState({ modals: [], toasts: [] })
})
afterEach(() => {
  editor?.destroy()
  // The search debounce and the layout's debounced write must not fire into the next file.
  resetSearchStore()
  resetLayoutStore()
  resetActiveEditorStore()
  resetFocusStore()
  resetEntityStore()
  useTreeStore.getState().clear()
  setIpcClient(null)
})

describe('SearchDialog (F-10.1)', () => {
  it('renders nothing while closed; the header button opens it', async () => {
    render(
      <>
        <SearchButton />
        <SearchDialog />
      </>
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const button = screen.getByRole('button', { name: 'Search project' })
    expect(button).toHaveAttribute('title', 'Search project (Ctrl+Shift+F)')
    await userEvent.click(button)
    expect(dialog()).toHaveAttribute('aria-modal', 'true')
    expect(box()).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent('Type at least 2 characters.')
    expect(options()).toEqual([])
  })

  it('offers the five type chips, all on, and the tag bank under "Any tag"', () => {
    useTagStore.setState({
      byId: Object.fromEntries(tagFixture.map((tag) => [tag.id, tag])),
      ids: tagFixture.map((tag) => tag.id),
      loaded: true
    })
    openWith(all)
    const chips = within(screen.getByRole('group', { name: 'Search in' })).getAllByRole('button')
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'Documents',
      'Notes',
      'Characters',
      'Settings',
      'World'
    ])
    for (const chip of chips) expect(chip).toHaveAttribute('aria-pressed', 'true')
    const select = screen.getByRole('combobox', { name: 'Filter by tag' })
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent)
    ).toEqual(['Any tag', ...tagFixture.map((tag) => tag.name)])
  })

  it('searches what is typed, and again when a chip or the tag changes', async () => {
    useTagStore.setState({
      byId: Object.fromEntries(tagFixture.map((tag) => [tag.id, tag])),
      ids: tagFixture.map((tag) => tag.id),
      loaded: true
    })
    useSearchStore.getState().openSearch()
    render(<SearchDialog />)
    await userEvent.type(box(), 'waited')
    await waitFor(() => expect(options()).toHaveLength(4))
    expect(requests).toEqual([{ query: 'waited', types: [...SEARCH_TYPES], tagId: null }])

    const documents = screen.getByRole('button', { name: 'Documents' })
    await userEvent.click(documents)
    expect(documents).toHaveAttribute('aria-pressed', 'false')
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]?.types).toEqual(['notes', 'character', 'setting', 'world'])

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Filter by tag' }),
      tagFixture[0]!.id
    )
    await waitFor(() => expect(requests).toHaveLength(3))
    expect(requests[2]?.tagId).toBe(tagFixture[0]!.id)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Filter by tag' }), '')
    await waitFor(() => expect(requests[3]?.tagId).toBeNull())
  })

  it('renders a row per result: title, location, count, and the snippet with its marks', () => {
    openWith(all)
    const rows = options()
    expect(rows).toHaveLength(4)
    expect(rows[0]).toHaveTextContent('Scene 1')
    expect(rows[0]).toHaveTextContent('Chapter 1')
    expect(rows[0]).toHaveTextContent('×2')
    expect(marks(rows[0]!)).toEqual(['waited', 'waited'])
    // A title-only hit marks the title and shows the start of the text unmarked.
    expect(marks(rows[1]!)).toEqual(['Waited'])
    expect(rows[1]).toHaveTextContent('Nothing of note.')
    expect(rows[1]).not.toHaveTextContent('×')
    expect(rows[2]).toHaveTextContent('Notes · Chapter 3')
    expect(rows[3]).toHaveTextContent('character · Appearance')
    expect(marks(rows[3]!)).toEqual(['waited'])
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('says when nothing matched, when the list was cut, and why a search failed', () => {
    openWith({ results: [], total: 0, truncated: false }, 'zzz')
    expect(screen.getByRole('status')).toHaveTextContent('No results for "zzz".')
    act(() => useSearchStore.setState({ response: { ...all, total: 950, truncated: true } }))
    expect(dialog()).toHaveTextContent(`Showing the first ${SEARCH_MAX_RESULTS} of 950.`)
    act(() =>
      useSearchStore.setState({ response: null, status: 'error', error: 'No project is open' })
    )
    expect(screen.getByRole('status')).toHaveTextContent('No project is open')
    act(() => useSearchStore.setState({ types: [], status: 'idle', error: null }))
    expect(screen.getByRole('status')).toHaveTextContent('Choose at least one type to search.')
  })

  it('moves the active row with the arrow keys, wrapping, and with the pointer', async () => {
    openWith(all)
    expect(box()).toHaveFocus()
    expect(selected()).toContain('Scene 1')
    expect(box()).toHaveAttribute('aria-activedescendant', options()[0]!.id)
    await userEvent.keyboard('{ArrowDown}')
    expect(selected()).toContain('Nothing of note.')
    await userEvent.keyboard('{ArrowUp}{ArrowUp}')
    expect(selected()).toContain('Mara')
    expect(box()).toHaveAttribute('aria-activedescendant', options()[3]!.id)
    await userEvent.keyboard('{ArrowDown}')
    expect(selected()).toContain('Scene 1')
    fireEvent.mouseMove(options()[2]!)
    expect(selected()).toContain('Scene 3')
    // A new answer starts at its first row again.
    act(() =>
      useSearchStore.setState({ response: { ...all, results: [notesHit, entityHit], total: 2 } })
    )
    await waitFor(() => expect(selected()).toContain('Scene 3'))
    expect(options()[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('closes on Escape, the close button, and a backdrop click, keeping the query', async () => {
    openWith(all)
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    act(() => useSearchStore.getState().openSearch())
    await userEvent.click(await screen.findByRole('button', { name: 'Close search' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    act(() => useSearchStore.getState().openSearch())
    fireEvent.mouseDown((await screen.findByRole('dialog')).parentElement!)
    expect(useSearchStore.getState()).toMatchObject({ open: false, query: 'waited' })
  })

  it('Enter jumps to a document and selects the first occurrence, whatever its case', async () => {
    editor = new Editor({
      extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Mara Waited at the dark forest. Rose waited too.' }]
          }
        ]
      }
    })
    useActiveEditorStore.getState().set('sc-1', editor)
    useEntityStore.setState({ selectedId: 'e-mara' })
    openWith(all)
    await userEvent.keyboard('{Enter}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(useTreeStore.getState().selectedId).toBe('sc-1'))
    const { from, to } = editor.state.selection
    expect(editor.state.doc.textBetween(from, to)).toBe('Waited')
    // Selecting a document closes the entity page (F-9.3).
    expect(useEntityStore.getState().selectedId).toBeNull()
    expect(useDialogStore.getState().toasts).toEqual([])
  })

  it('a title-only hit opens the document without looking for a passage', async () => {
    openWith(all)
    await userEvent.click(options()[1]!)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(useTreeStore.getState().selectedId).toBe('sc-2')
    expect(useDialogStore.getState().toasts).toEqual([])
  })

  it('a notes hit selects the node and opens the notes panel: docked, or floating in focus mode', async () => {
    openWith(all)
    expect(useLayoutStore.getState().layout.notes.open).toBe(false)
    await userEvent.click(options()[2]!)
    expect(useTreeStore.getState().selectedId).toBe('sc-3')
    expect(useLayoutStore.getState().layout.notes.open).toBe(true)
    // Already open: a second jump must not close it.
    act(() => useSearchStore.getState().openSearch())
    await userEvent.click(options()[2]!)
    expect(useLayoutStore.getState().layout.notes.open).toBe(true)

    resetLayoutStore()
    await useFocusStore.getState().enter()
    act(() => useSearchStore.getState().openSearch())
    await userEvent.click(options()[2]!)
    expect(useFocusStore.getState().panels.notes).toBe(true)
    expect(useFocusStore.getState().active).toBe(true)
    expect(useLayoutStore.getState().layout.notes.open).toBe(false)
  })

  it('an entity hit opens the entity page, leaving focus mode first', async () => {
    useEntityStore.setState({
      byId: Object.fromEntries(entityFixture.map((entity) => [entity.id, entity])),
      ids: entityFixture.map((entity) => entity.id),
      loaded: true
    })
    await useFocusStore.getState().enter()
    openWith(all)
    await userEvent.keyboard('{ArrowUp}{Enter}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(useEntityStore.getState().selectedId).toBe('e-mara'))
    expect(useFocusStore.getState().active).toBe(false)
  })
})
