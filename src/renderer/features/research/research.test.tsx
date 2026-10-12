import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output, TreeNode } from '@shared/ipc/contract'
import type { ResearchDoc } from '@shared/research'
import type { TiptapNodeT } from '@shared/tiptap'
import {
  resetCompileWindowStore,
  useCompileWindowStore
} from '@renderer/features/compile/compileWindowStore'
import { ManuscriptTree } from '@renderer/features/manuscript/ManuscriptTree'
import { researchTreeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient } from '@renderer/lib/ipc'
import {
  pageKey,
  pageOwnerOf,
  reloadResearchPages,
  resetPageStore,
  usePageStore
} from './pageStore'
import { ResearchPage } from './ResearchPage'
import { ResearchTab } from './ResearchTab'
import { researchRootOf, researchTarget, resetResearchPageRefresh } from './researchView'
import { resetResearchStore, useResearchStore } from './researchStore'

/**
 * F-16.8 (plan P1 §2.1–2.3), the renderer: the page store by owner, the Research meta store, the
 * Manuscript tree without the Research root and the Research tab with it alone, and the
 * Research page with its source line, Open original and the Not canon switch.
 */

type Handler = (input: unknown) => unknown
let calls: [Channel, unknown][]

const UPLOAD: ResearchDoc = {
  nodeId: 'r-upload',
  origin: 'upload',
  contextFileId: 'f-1',
  fileName: 'Coast survey.pdf',
  fileType: 'pdf',
  converted: true,
  notCanon: false
}
const NOTE: ResearchDoc = {
  nodeId: 'r-note',
  origin: 'written',
  contextFileId: null,
  fileName: null,
  fileType: null,
  converted: false,
  notCanon: false
}

const page = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

const treeNode = (
  over: Partial<TreeNode> & Pick<TreeNode, 'id' | 'parentId' | 'title'>
): TreeNode => ({
  sectionType: null,
  kind: 'document',
  hierarchyLevel: null,
  position: 0,
  wordCount: 0,
  matterType: null,
  preset: null,
  created: 'c',
  modified: 'm',
  ...over
})

function install(overrides: Partial<Record<Channel, Handler>> = {}): void {
  calls = []
  setIpcClient({
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      const override = overrides[channel]
      if (override) return override(input) as Output<C>
      if (channel === 'research:list') return [UPLOAD, NOTE] as Output<C>
      if (channel === 'document:get') return { id: 'r-note', content: page('Stored.') } as Output<C>
      if (channel === 'document:save') return { wordCount: 2, modified: 'm2' } as Output<C>
      if (channel === 'goals:get') throw new Error('not needed')
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  })
}

const sent = (channel: Channel): unknown[] =>
  calls.filter(([each]) => each === channel).map(([, input]) => input)

beforeEach(() => {
  install()
  resetPageStore()
  resetResearchStore()
  resetResearchPageRefresh()
  resetCompileWindowStore()
  useTreeStore.getState().clear()
  useTreeStore.setState({ ...buildIndex(researchTreeFixture), loaded: true })
})
afterEach(() => {
  resetPageStore()
  resetResearchStore()
  useTreeStore.getState().clear()
})

describe('the page store (F-16.6, F-16.8)', () => {
  it('keys pages by owner and reads a key back', () => {
    expect(pageKey({ kind: 'research', id: 'n-1' })).toBe('research:n-1')
    expect(pageOwnerOf('pinned:r:1')).toEqual({ kind: 'pinned', id: 'r:1' })
    expect(pageOwnerOf('notes:n-1')).toBeNull()
    expect(pageOwnerOf('research:')).toBeNull()
  })

  it('reads and saves a Research page as its document, and the tree takes the new count', async () => {
    const key = pageKey({ kind: 'research', id: 'r-note' })
    await usePageStore.getState().load(key)
    expect(usePageStore.getState().docs[key]?.content).toEqual(page('Stored.'))
    usePageStore.getState().edit(key, page('Typed here.'))
    await usePageStore.getState().flush()
    expect(sent('document:save')).toEqual([{ id: 'r-note', content: page('Typed here.') }])
    expect(useTreeStore.getState().byId['r-note']?.wordCount).toBe(2)
  })

  it('reads and saves a record’s Pinned and Ideas pages through the record channels', async () => {
    install({
      'record:get': () => ({ id: 'rec-1', pinned: page('Eyes: grey'), ideas: null }),
      'record:savePage': () => ({})
    })
    const pinned = pageKey({ kind: 'pinned', id: 'rec-1' })
    const ideas = pageKey({ kind: 'ideas', id: 'rec-1' })
    await usePageStore.getState().load(pinned)
    await usePageStore.getState().load(ideas)
    expect(usePageStore.getState().docs[pinned]?.content).toEqual(page('Eyes: grey'))
    expect(usePageStore.getState().docs[ideas]?.content).toMatchObject({ type: 'doc' })
    usePageStore.getState().edit(ideas, page('Maybe a twin.'))
    await usePageStore.getState().flush()
    expect(sent('record:savePage')).toEqual([
      { id: 'rec-1', page: 'ideas', doc: page('Maybe a twin.') }
    ])
  })

  it('reads an open Research page again after main rewrote it, and leaves closed ones alone', async () => {
    const key = pageKey({ kind: 'research', id: 'r-note' })
    await usePageStore.getState().load(key)
    install({ 'document:get': () => ({ id: 'r-note', content: page('Replaced.') }) })
    await reloadResearchPages(['r-note', 'sc-1'])
    expect(usePageStore.getState().docs[key]?.content).toEqual(page('Replaced.'))
    expect(sent('document:get')).toEqual([{ id: 'r-note' }])
  })
})

describe('the Research meta store (F-16.8)', () => {
  it('loads every document’s meta', async () => {
    await useResearchStore.getState().load()
    expect(useResearchStore.getState()).toMatchObject({
      loaded: true,
      docs: { 'r-upload': UPLOAD, 'r-note': NOTE }
    })
  })

  it('adds uploads into the tree, opens the first, and names every skipped file', async () => {
    const made = treeNode({
      id: 'r-new',
      parentId: 'research',
      title: 'Tides',
      position: 2,
      wordCount: 30
    })
    install({
      'research:add': () => ({
        nodes: [made],
        docs: [{ ...NOTE, nodeId: 'r-new', origin: 'upload', fileType: 'md' }],
        skipped: [
          { name: 'song.mp3', reason: 'Research takes Word, Markdown, text, PDF, and image files.' }
        ]
      })
    })
    await useResearchStore.getState().add()
    expect(sent('research:add')).toEqual([{}])
    const tree = useTreeStore.getState()
    expect(tree.childrenOf.research).toEqual(['r-folder', 'r-note', 'r-new'])
    expect(tree.sectionOf['r-new']).toBe('research')
    expect(tree.wordCountRollup.research).toBe(40 + 12 + 30)
    expect(tree.selectedId).toBe('r-new')
    expect(useResearchStore.getState().docs['r-new']?.fileType).toBe('md')
    expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual([
      'song.mp3: Research takes Word, Markdown, text, PDF, and image files.'
    ])
    // A cancelled dialog adds nothing.
    install({ 'research:add': () => null })
    await useResearchStore.getState().add('r-folder')
    expect(sent('research:add')).toEqual([{ parentId: 'r-folder' }])
  })

  it('creates a written note after the selection with inline rename, and switches a page Not canon', async () => {
    install({
      'research:create': () => ({
        node: treeNode({
          id: 'r-made',
          parentId: 'research',
          title: 'Untitled document',
          position: 2
        }),
        doc: { ...NOTE, nodeId: 'r-made' }
      }),
      'research:setNotCanon': () => ({ ...NOTE, notCanon: true })
    })
    await useResearchStore.getState().create({ parentId: 'research', afterId: 'r-note' })
    expect(sent('research:create')).toEqual([{ parentId: 'research', afterId: 'r-note' }])
    expect(useTreeStore.getState()).toMatchObject({ selectedId: 'r-made', renamingId: 'r-made' })
    await useResearchStore.getState().setNotCanon('r-note', true)
    expect(useResearchStore.getState().docs['r-note']?.notCanon).toBe(true)
  })
})

describe('the Research meta store under overlapping answers (F-16.8)', () => {
  /** A channel whose answer waits until `release` is called. */
  const held = <T,>(value: T): { handler: Handler; release: () => void } => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    return { handler: () => gate.then(() => value), release }
  }

  it('keeps an upload answered while a list read was in flight, and the newer Not canon switch', async () => {
    const listing = held([UPLOAD, NOTE])
    const made = treeNode({ id: 'r-new', parentId: 'research', title: 'Tides', position: 2 })
    install({
      'research:list': listing.handler,
      'research:add': () => ({
        nodes: [made],
        docs: [{ ...NOTE, nodeId: 'r-new', origin: 'upload', fileType: 'md' }],
        skipped: []
      }),
      'research:setNotCanon': () => ({ ...NOTE, notCanon: true })
    })
    const loading = useResearchStore.getState().load()
    await useResearchStore.getState().add()
    await useResearchStore.getState().setNotCanon('r-note', true)
    listing.release()
    await loading
    const { docs, loaded } = useResearchStore.getState()
    expect(loaded).toBe(true)
    expect(docs['r-new']?.fileType).toBe('md')
    expect(docs['r-note']?.notCanon).toBe(true)
    expect(docs['r-upload']).toEqual(UPLOAD)
    expect(useTreeStore.getState().selectedId).toBe('r-new')
  })

  it('drops every answer for a project that closed', async () => {
    const listing = held([UPLOAD])
    const creating = held({
      node: treeNode({ id: 'r-late', parentId: 'research', title: 'Late' }),
      doc: { ...NOTE, nodeId: 'r-late' }
    })
    install({ 'research:list': listing.handler, 'research:create': creating.handler })
    const loading = useResearchStore.getState().load()
    const making = useResearchStore.getState().create()
    resetResearchStore()
    listing.release()
    creating.release()
    await Promise.all([loading, making])
    expect(useResearchStore.getState()).toMatchObject({ docs: {}, loaded: false })
    expect(useTreeStore.getState().byId['r-late']).toBeUndefined()
  })
})

describe('the Manuscript tree and the Research tab (F-16.8)', () => {
  it('leaves the Research root out of the Manuscript tree', () => {
    render(<ManuscriptTree format="novel" />)
    expect(screen.getByRole('treeitem', { name: 'Manuscript' })).toBeInTheDocument()
    expect(screen.queryByRole('treeitem', { name: 'Research' })).toBeNull()
    expect(screen.queryByRole('treeitem', { name: 'Open questions' })).toBeNull()
  })

  it('shows the Research root alone in the Research tab, with no compile tick in its menu', async () => {
    useCompileWindowStore.setState({ stateLoaded: true, excluded: [] })
    render(<ResearchTab format="novel" />)
    const tree = screen.getByRole('tree')
    expect(within(tree).getByRole('treeitem', { name: 'Research' })).toBeInTheDocument()
    expect(within(tree).queryByRole('treeitem', { name: 'Manuscript' })).toBeNull()
    expect(within(tree).getByRole('treeitem', { name: 'Open questions' })).toBeInTheDocument()
    const row = within(tree).getByRole('treeitem', { name: 'Open questions' }).firstElementChild
    if (row === null) throw new Error('no row')
    fireEvent.contextMenu(row)
    const menu = await screen.findByRole('menu')
    expect(within(menu).queryByRole('menuitemcheckbox', { name: 'Include in compile' })).toBeNull()
    expect(within(menu).getByRole('menuitem', { name: 'New document' })).toBeInTheDocument()
  })

  it('makes a document in Research a written note through research:create', async () => {
    install({
      'research:create': () => ({
        node: treeNode({
          id: 'r-made',
          parentId: 'research',
          title: 'Untitled document',
          position: 2
        }),
        doc: { ...NOTE, nodeId: 'r-made' }
      })
    })
    render(<ResearchTab format="novel" />)
    const row = screen.getByRole('treeitem', { name: 'Open questions' }).firstElementChild
    if (row === null) throw new Error('no row')
    fireEvent.contextMenu(row)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New document' }))
    await waitFor(() =>
      expect(sent('research:create')).toEqual([{ parentId: 'research', afterId: 'r-note' }])
    )
    expect(sent('tree:create')).toEqual([])
  })

  it('places new Research beside the selection when it is in Research, else at the root', () => {
    const state = useTreeStore.getState()
    expect(researchRootOf(state)).toBe('research')
    expect(researchTarget(state, null)).toEqual({ parentId: 'research' })
    expect(researchTarget(state, 'sc-1')).toEqual({ parentId: 'research' })
    expect(researchTarget(state, 'r-folder')).toEqual({ parentId: 'r-folder' })
    expect(researchTarget(state, 'r-upload')).toEqual({ parentId: 'r-folder', afterId: 'r-upload' })
  })
})

describe('the Research page (F-16.8)', () => {
  it('names a converted PDF, opens its original, and switches the whole page Not canon', async () => {
    install({
      'research:openOriginal': () => null,
      'research:setNotCanon': () => ({ ...UPLOAD, notCanon: true }),
      'document:get': () => ({ id: 'r-upload', content: page('Tide tables for 1891.') })
    })
    await act(() => useResearchStore.getState().load())
    install({
      'research:openOriginal': () => null,
      'research:setNotCanon': () => ({ ...UPLOAD, notCanon: true }),
      'document:get': () => ({ id: 'r-upload', content: page('Tide tables for 1891.') })
    })
    render(<ResearchPage nodeId="r-upload" />)
    expect(screen.getByRole('heading', { name: 'Coast survey' })).toBeInTheDocument()
    expect(screen.getByTestId('research-source')).toHaveTextContent(
      'Converted from PDF: Coast survey.pdf'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open original' }))
    await waitFor(() => expect(sent('research:openOriginal')).toEqual([{ nodeId: 'r-upload' }]))
    // The loading instance is replaced once the page is in, so the editor is looked up again.
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Research page' })).toHaveTextContent(
        'Tide tables for 1891.'
      )
    )
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() =>
      expect(screen.getByTestId('research-page')).toHaveAttribute('data-not-canon', 'true')
    )
    expect(sent('research:setNotCanon')).toEqual([{ nodeId: 'r-upload', notCanon: true }])
    expect(screen.getByText(/Nothing on this page is treated as true/)).toBeInTheDocument()
  })

  it('offers no original for a written note, and marks a paragraph Not canon from the toolbar', async () => {
    await act(() => useResearchStore.getState().load())
    render(<ResearchPage nodeId="r-note" />)
    expect(screen.queryByRole('button', { name: 'Open original' })).toBeNull()
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Research page' })).toHaveTextContent('Stored.')
    )
    const editor = screen.getByRole('textbox', { name: 'Research page' })
    const toggle = screen.getByRole('button', { name: 'Not canon' })
    await waitFor(() => expect(toggle).toBeEnabled())
    fireEvent.click(toggle)
    await waitFor(() => expect(editor.querySelector('p[data-not-canon]')).not.toBeNull())
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    const key = pageKey({ kind: 'research', id: 'r-note' })
    expect(usePageStore.getState().docs[key]?.content?.content?.[0]?.attrs).toMatchObject({
      notCanon: true
    })
  })
})
