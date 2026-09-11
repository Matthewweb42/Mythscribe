import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TreeNode } from '@shared/ipc/contract'
import { DialogHost } from '@renderer/features/shell/dialogs/DialogHost'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { CreateNodeBar } from './CreateNodeBar'
import { ManuscriptTree } from './ManuscriptTree'
import { treeFixture } from './treeFixture'
import { buildIndex, useTreeStore } from './treeStore'

const item = (name: string): HTMLElement => screen.getByRole('treeitem', { name })
/** The row `<div>` of a treeitem, excluding its nested group. */
const row = (name: string): Element => {
  const first = item(name).firstElementChild
  if (!first) throw new Error(`no row for ${name}`)
  return first
}

/**
 * Answers `tree:create` with an "Untitled …" node after `afterId`, `tree:rename` with the new
 * title, `tree:duplicate` with a "<title> (Copy)" subtree (ids suffixed `-copy`), and
 * `tree:delete` with null.
 */
function install(): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(async (channel: string, input: unknown) => {
    const state = useTreeStore.getState()
    if (channel === 'tree:create') {
      const req = input as {
        parentId: string
        afterId?: string
        kind: 'document' | 'folder'
        hierarchyLevel: 'part' | 'chapter' | 'scene' | null
      }
      const after = req.afterId === undefined ? undefined : state.byId[req.afterId]
      const node: TreeNode = {
        id: `new-${invoke.mock.calls.length}`,
        parentId: req.parentId,
        sectionType: null,
        kind: req.kind,
        hierarchyLevel: req.hierarchyLevel,
        title:
          req.hierarchyLevel === 'scene'
            ? 'Untitled Scene'
            : `Untitled ${req.hierarchyLevel ?? req.kind}`,
        position: after ? after.position + 1 : (state.childrenOf[req.parentId] ?? []).length,
        wordCount: 0,
        matterType: null,
        preset: null,
        created: 'c',
        modified: 'm'
      }
      return node
    }
    if (channel === 'tree:rename') {
      const req = input as { id: string; title: string }
      const node = state.byId[req.id]
      if (!node) throw new Error('missing')
      return { ...node, title: req.title }
    }
    if (channel === 'tree:duplicate') {
      const req = input as { id: string }
      const rows: TreeNode[] = []
      const copy = (id: string, parentId: string | null, position: number, title: string): void => {
        const source = state.byId[id]
        if (!source) throw new Error('missing')
        const copied: TreeNode = { ...source, id: `${id}-copy`, parentId, position, title }
        rows.push(copied)
        ;(state.childrenOf[id] ?? []).forEach((childId, i) => {
          copy(childId, copied.id, i, state.byId[childId]?.title ?? '')
        })
      }
      const source = state.byId[req.id]
      if (!source) throw new Error('missing')
      copy(req.id, source.parentId, source.position + 1, `${source.title} (Copy)`)
      return rows
    }
    if (channel === 'tree:delete') {
      const req = input as { id: string }
      if (!state.byId[req.id]) throw new Error('missing')
      return null
    }
    throw new Error(`unexpected ${channel}`)
  })
  const client: IpcClient = { invoke: invoke as IpcClient['invoke'], on: () => () => {} }
  setIpcClient(client)
  return invoke
}

const treeNames = (): (string | null)[] =>
  screen.getAllByRole('treeitem').map((el) => el.getAttribute('aria-label'))

beforeEach(() => {
  useTreeStore.getState().clear()
  useDialogStore.setState({ modals: [], toasts: [] })
  useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
})

describe('ManuscriptTree', () => {
  it('shows a folder glyph for generic folders and a file glyph for generic documents', () => {
    const genericNode = (
      id: string,
      title: string,
      kind: 'folder' | 'document',
      position: number
    ): TreeNode => ({
      id,
      parentId: 'end',
      sectionType: null,
      kind,
      hierarchyLevel: null,
      title,
      position,
      wordCount: 0,
      matterType: null,
      preset: null,
      created: 'c',
      modified: 'm'
    })
    const generic = treeFixture.concat([
      genericNode('notes', 'Notes', 'folder', 0),
      genericNode('loose', 'Loose page', 'document', 1)
    ])
    useTreeStore.setState({ ...buildIndex(generic), loaded: true })
    render(<ManuscriptTree format="novel" />)
    expect(item('Notes').querySelector('svg.lucide-folder-open')).not.toBeNull()
    expect(item('Loose page').querySelector('svg.lucide-file')).not.toBeNull()
  })

  it('renders nothing before the tree is loaded', () => {
    useTreeStore.setState({ loaded: false })
    const { container } = render(<ManuscriptTree format="webnovel" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders an empty state for a project without sections', () => {
    useTreeStore.setState({ ...buildIndex([]), loaded: true })
    render(<ManuscriptTree format="novel" />)
    expect(screen.getByText('This project has no sections yet.')).toBeInTheDocument()
    expect(screen.queryByRole('tree')).not.toBeInTheDocument()
  })

  it('labels the three sections by format', () => {
    const { rerender } = render(<ManuscriptTree format="webnovel" />)
    expect(screen.getByRole('tree', { name: 'Document tree' })).toBeInTheDocument()
    expect(item('Front Matter')).toBeInTheDocument()
    expect(item('Volume 1')).toBeInTheDocument()
    expect(item('End Matter')).toBeInTheDocument()
    rerender(<ManuscriptTree format="novel" />)
    expect(item('Manuscript')).toBeInTheDocument()
    expect(screen.queryByRole('treeitem', { name: 'Volume 1' })).not.toBeInTheDocument()
  })

  it('nests rows in position order with aria-level per depth', () => {
    render(<ManuscriptTree format="webnovel" />)
    const names = screen.getAllByRole('treeitem').map((el) => el.getAttribute('aria-label'))
    expect(names).toEqual([
      'Front Matter',
      'Title Page',
      'Volume 1',
      'Arc 1',
      'Chapter 1',
      'Scene 1',
      'Chapter 2',
      'Scene 2',
      'Chapter 3',
      'Scene 3',
      'Arc 2',
      'Chapter 4',
      'Scene 4',
      'Chapter 5',
      'Scene 5',
      'Chapter 6',
      'Scene 6',
      'End Matter'
    ])
    expect(item('Volume 1')).toHaveAttribute('aria-level', '1')
    expect(item('Arc 1')).toHaveAttribute('aria-level', '2')
    expect(item('Chapter 4')).toHaveAttribute('aria-level', '3')
    expect(item('Scene 6')).toHaveAttribute('aria-level', '4')
    expect(item('Scene 6')).not.toHaveAttribute('aria-expanded')
    expect(item('Arc 1')).toHaveAttribute('aria-expanded', 'true')
  })

  it('collapses and expands a folder from its chevron', async () => {
    render(<ManuscriptTree format="webnovel" />)
    await userEvent.click(screen.getByRole('button', { name: 'Collapse Arc 1' }))
    expect(item('Arc 1')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('treeitem', { name: 'Chapter 1' })).not.toBeInTheDocument()
    expect(item('Chapter 4')).toBeInTheDocument()
    expect(useTreeStore.getState().selectedId).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Expand Arc 1' }))
    expect(item('Chapter 1')).toBeInTheDocument()
    expect(item('Arc 1')).toHaveAttribute('aria-expanded', 'true')
  })

  it('selects documents on click but never sections', async () => {
    render(<ManuscriptTree format="webnovel" />)
    await userEvent.click(row('Scene 1'))
    expect(item('Scene 1')).toHaveAttribute('aria-selected', 'true')
    expect(item('Scene 2')).toHaveAttribute('aria-selected', 'false')
    await userEvent.click(row('Volume 1'))
    expect(item('Volume 1')).toHaveAttribute('aria-selected', 'false')
    expect(item('Volume 1')).toHaveAttribute('aria-expanded', 'false')
    expect(useTreeStore.getState().selectedId).toBe('sc-1')
  })

  it('shows own word counts for documents and rollups for folders and sections', () => {
    render(<ManuscriptTree format="webnovel" />)
    expect(row('Scene 1')).toHaveTextContent((1200).toLocaleString())
    expect(row('Scene 3')).toHaveTextContent('0')
    expect(row('Chapter 1')).toHaveTextContent((1200).toLocaleString())
    expect(row('Arc 1')).toHaveTextContent((2000).toLocaleString())
    expect(row('Volume 1')).toHaveTextContent((4800).toLocaleString())
    expect(row('Front Matter')).toHaveTextContent('12')
  })

  it('styles front/end matter documents in gold and levels by color', () => {
    render(<ManuscriptTree format="webnovel" />)
    expect(item('Title Page')).toHaveAttribute('data-matter', 'true')
    expect(row('Title Page').querySelector('.text-matter')).not.toBeNull()
    expect(item('Scene 1')).not.toHaveAttribute('data-matter')
    expect(row('Scene 1').querySelector('.text-matter')).toBeNull()
    expect(row('Scene 1').querySelector('.text-level-scene')).not.toBeNull()
    expect(row('Chapter 1').querySelector('.text-level-chapter')).not.toBeNull()
    expect(row('Arc 1').querySelector('.text-level-part')).not.toBeNull()
  })

  it('gives the selected row the roving tab stop, else the first row', () => {
    render(<ManuscriptTree format="webnovel" />)
    expect(item('Front Matter')).toHaveAttribute('tabindex', '0')
    expect(item('Scene 1')).toHaveAttribute('tabindex', '-1')
    act(() => useTreeStore.getState().select('sc-1'))
    expect(item('Front Matter')).toHaveAttribute('tabindex', '-1')
    expect(item('Scene 1')).toHaveAttribute('tabindex', '0')
  })

  it('moves focus with the arrow keys and selects with Enter', async () => {
    render(<ManuscriptTree format="webnovel" />)
    item('Arc 1').focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(item('Chapter 1')).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(item('Chapter 1')).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{ArrowRight}')
    expect(item('Scene 1')).toHaveFocus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(item('Chapter 1')).toHaveFocus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(item('Chapter 1')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('treeitem', { name: 'Scene 1' })).not.toBeInTheDocument()
    await userEvent.keyboard('{ArrowRight}')
    expect(item('Chapter 1')).toHaveAttribute('aria-expanded', 'true')
    await userEvent.keyboard('{ArrowUp}')
    expect(item('Arc 1')).toHaveFocus()
    await userEvent.keyboard('{ArrowUp}')
    expect(item('Volume 1')).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(item('Volume 1')).toHaveAttribute('aria-expanded', 'false')
    expect(useTreeStore.getState().selectedId).toBe('ch-1')
  })

  it('New scene from the bar inserts after the selected scene and opens inline rename', async () => {
    const invoke = install()
    useTreeStore.setState({ selectedId: 'sc-1' })
    render(
      <>
        <ManuscriptTree format="webnovel" />
        <CreateNodeBar format="webnovel" />
      </>
    )
    await userEvent.click(screen.getByRole('button', { name: 'New scene' }))
    expect(invoke).toHaveBeenCalledWith('tree:create', {
      parentId: 'ch-1',
      afterId: 'sc-1',
      kind: 'document',
      hierarchyLevel: 'scene'
    })
    const names = treeNames()
    expect(names.indexOf('Untitled Scene')).toBe(names.indexOf('Scene 1') + 1)
    expect(names.indexOf('Untitled Scene')).toBe(names.indexOf('Chapter 2') - 1)
    const created = item('Untitled Scene')
    expect(created).toHaveAttribute('aria-selected', 'true')
    const input = within(created).getByRole('textbox', { name: 'Rename' })
    expect(input).toHaveFocus()
    expect(input).toHaveValue('Untitled Scene')
  })

  it('creating into a collapsed chapter expands it so the new row is visible', async () => {
    install()
    useTreeStore.setState({ selectedId: 'sc-1', collapsed: { 'ch-1': true, 'arc-1': true } })
    render(
      <>
        <ManuscriptTree format="webnovel" />
        <CreateNodeBar format="webnovel" />
      </>
    )
    expect(screen.queryByRole('treeitem', { name: 'Scene 1' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'New scene' }))
    expect(item('Chapter 1')).toHaveAttribute('aria-expanded', 'true')
    expect(item('Untitled Scene')).toBeInTheDocument()
  })

  it('disables the three bar buttons with Front Matter content selected', () => {
    useTreeStore.setState({ selectedId: 'title-page' })
    render(
      <>
        <ManuscriptTree format="webnovel" />
        <CreateNodeBar format="webnovel" />
      </>
    )
    expect(screen.getByRole('button', { name: 'New scene' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'New chapter' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'New arc' })).toBeDisabled()
  })

  it('right-click on a chapter opens a menu with the levels and the generic items, no templates', async () => {
    render(<ManuscriptTree format="webnovel" />)
    fireEvent.contextMenu(row('Chapter 2'), { clientX: 40, clientY: 50 })
    const menu = screen.getByRole('menu')
    const labels = within(menu)
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    expect(labels).toEqual([
      'New Arc',
      'New Chapter',
      'New Scene',
      'New document',
      'New folder',
      'Rename',
      'Duplicate',
      'Delete'
    ])
    expect(within(menu).queryByText(/template/i)).not.toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'New Arc' })).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    expect(within(menu).getByRole('menuitem', { name: 'New Chapter' })).toHaveFocus()
    await userEvent.keyboard('{ArrowUp}{ArrowUp}')
    expect(within(menu).getByRole('menuitem', { name: 'Delete' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(item('Chapter 2')).toHaveFocus()
  })

  it('right-click on Title Page offers only the generic items plus Rename, Duplicate, and Delete', () => {
    render(<ManuscriptTree format="webnovel" />)
    fireEvent.contextMenu(row('Title Page'), { clientX: 40, clientY: 50 })
    const labels = within(screen.getByRole('menu'))
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    expect(labels).toEqual(['New document', 'New folder', 'Rename', 'Duplicate', 'Delete'])
  })

  it('right-click on a section never offers Rename, Duplicate, or Delete', () => {
    render(<ManuscriptTree format="webnovel" />)
    fireEvent.contextMenu(row('Volume 1'), { clientX: 40, clientY: 50 })
    const labels = within(screen.getByRole('menu'))
      .getAllByRole('menuitem')
      .map((el) => el.textContent)
    expect(labels).not.toContain('Rename')
    expect(labels).not.toContain('Duplicate')
    expect(labels).not.toContain('Delete')
  })

  it('Rename from the menu opens the inline editor prefilled with the title (F-2.3)', async () => {
    const invoke = install()
    render(<ManuscriptTree format="webnovel" />)
    fireEvent.contextMenu(row('Scene 1'), { clientX: 40, clientY: 50 })
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    const input = within(item('Scene 1')).getByRole('textbox', { name: 'Rename' })
    expect(input).toHaveFocus()
    expect(input).toHaveValue('Scene 1')
    expect(invoke).not.toHaveBeenCalled()
    await userEvent.keyboard('Opening{Enter}')
    expect(invoke).toHaveBeenCalledWith('tree:rename', { id: 'sc-1', title: 'Opening' })
    expect(item('Opening')).toBeInTheDocument()
  })

  it('Duplicate from the menu adds "<title> (Copy)" right after the row and selects it (F-2.3)', async () => {
    const invoke = install()
    useTreeStore.setState({ selectedId: 'sc-2' })
    render(<ManuscriptTree format="webnovel" />)
    fireEvent.contextMenu(row('Scene 1'), { clientX: 40, clientY: 50 })
    await userEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('tree:duplicate', { id: 'sc-1' })
    const names = treeNames()
    expect(names.indexOf('Scene 1 (Copy)')).toBe(names.indexOf('Scene 1') + 1)
    expect(names.indexOf('Scene 1 (Copy)')).toBe(names.indexOf('Chapter 2') - 1)
    expect(item('Scene 1 (Copy)')).toHaveAttribute('aria-selected', 'true')
    expect(item('Scene 1 (Copy)')).toHaveAttribute('aria-level', '4')
    expect(screen.queryByRole('textbox', { name: 'Rename' })).not.toBeInTheDocument()
    expect(row('Chapter 1')).toHaveTextContent((2400).toLocaleString())
  })

  it('Duplicate on a chapter copies its scenes under the new chapter', async () => {
    install()
    render(<ManuscriptTree format="webnovel" />)
    fireEvent.contextMenu(row('Chapter 1'), { clientX: 40, clientY: 50 })
    await userEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }))
    const copy = item('Chapter 1 (Copy)')
    expect(copy).toHaveAttribute('aria-level', '3')
    expect(within(copy).getByRole('treeitem', { name: 'Scene 1' })).toBeInTheDocument()
    const names = treeNames()
    expect(names.slice(names.indexOf('Chapter 1'), names.indexOf('Chapter 2'))).toEqual([
      'Chapter 1',
      'Scene 1',
      'Chapter 1 (Copy)',
      'Scene 1'
    ])
  })

  it('surfaces a failed duplicate as a toast and keeps the tree unchanged', async () => {
    const client: IpcClient = {
      invoke: async () => {
        throw new Error('Database is locked')
      },
      on: () => () => {}
    }
    setIpcClient(client)
    render(<ManuscriptTree format="webnovel" />)
    fireEvent.contextMenu(row('Scene 1'), { clientX: 40, clientY: 50 })
    await userEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }))
    await waitFor(() =>
      expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual(['Database is locked'])
    )
    expect(screen.queryByRole('treeitem', { name: 'Scene 1 (Copy)' })).not.toBeInTheDocument()
  })

  it('Delete from the menu asks first; Cancel keeps the row and sends nothing (F-2.3)', async () => {
    const invoke = install()
    render(
      <>
        <ManuscriptTree format="webnovel" />
        <DialogHost />
      </>
    )
    fireEvent.contextMenu(row('Chapter 2'), { clientX: 40, clientY: 50 })
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    const dialog = await screen.findByRole('dialog', { name: "Delete 'Chapter 2'?" })
    expect(dialog).toHaveTextContent('This also deletes everything inside it.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalled()
    expect(item('Chapter 2')).toBeInTheDocument()
    expect(item('Scene 2')).toBeInTheDocument()
  })

  it('Delete confirmed removes the row and its children and moves the selection on (F-2.3)', async () => {
    const invoke = install()
    useTreeStore.setState({ selectedId: 'sc-2' })
    render(
      <>
        <ManuscriptTree format="webnovel" />
        <DialogHost />
      </>
    )
    fireEvent.contextMenu(row('Chapter 2'), { clientX: 40, clientY: 50 })
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: "Delete 'Chapter 2'?" })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('tree:delete', { id: 'ch-2' })
    await waitFor(() =>
      expect(screen.queryByRole('treeitem', { name: 'Chapter 2' })).not.toBeInTheDocument()
    )
    expect(screen.queryByRole('treeitem', { name: 'Scene 2' })).not.toBeInTheDocument()
    expect(item('Chapter 3')).toHaveAttribute('aria-selected', 'true')
    const names = treeNames()
    expect(names.indexOf('Chapter 3')).toBe(names.indexOf('Scene 1') + 1)
    expect(row('Arc 1')).toHaveTextContent((1200).toLocaleString())
  })

  it('Delete on a document warns only that it cannot be undone', async () => {
    install()
    render(
      <>
        <ManuscriptTree format="webnovel" />
        <DialogHost />
      </>
    )
    fireEvent.contextMenu(row('Scene 1'), { clientX: 40, clientY: 50 })
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: "Delete 'Scene 1'?" })
    expect(dialog).toHaveTextContent('This cannot be undone.')
    expect(dialog).not.toHaveTextContent('everything inside it')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() =>
      expect(screen.queryByRole('treeitem', { name: 'Scene 1' })).not.toBeInTheDocument()
    )
    expect(item('Chapter 1')).toBeInTheDocument()
  })

  it('surfaces a failed delete as a toast and keeps the row', async () => {
    const client: IpcClient = {
      invoke: async () => {
        throw new Error('Database is locked')
      },
      on: () => () => {}
    }
    setIpcClient(client)
    render(
      <>
        <ManuscriptTree format="webnovel" />
        <DialogHost />
      </>
    )
    fireEvent.contextMenu(row('Scene 1'), { clientX: 40, clientY: 50 })
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: "Delete 'Scene 1'?" })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() =>
      expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual(['Database is locked'])
    )
    expect(item('Scene 1')).toBeInTheDocument()
  })

  it('choosing New Scene from the menu creates it under that chapter', async () => {
    const invoke = install()
    render(<ManuscriptTree format="webnovel" />)
    fireEvent.contextMenu(row('Chapter 2'), { clientX: 40, clientY: 50 })
    await userEvent.click(screen.getByRole('menuitem', { name: 'New Scene' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('tree:create', {
      parentId: 'ch-2',
      afterId: undefined,
      kind: 'document',
      hierarchyLevel: 'scene'
    })
    const names = treeNames()
    expect(names.indexOf('Untitled Scene')).toBe(names.indexOf('Scene 2') + 1)
    expect(within(item('Untitled Scene')).getByRole('textbox', { name: 'Rename' })).toHaveFocus()
  })

  it('choosing New folder from the menu creates a generic folder inside the row', async () => {
    const invoke = install()
    render(<ManuscriptTree format="webnovel" />)
    fireEvent.contextMenu(row('Chapter 2'), { clientX: 40, clientY: 50 })
    await userEvent.click(screen.getByRole('menuitem', { name: 'New folder' }))
    expect(invoke).toHaveBeenCalledWith('tree:create', {
      parentId: 'ch-2',
      afterId: undefined,
      kind: 'folder',
      hierarchyLevel: null
    })
    expect(item('Untitled folder')).toHaveAttribute('aria-level', '4')
  })

  it('an outside click closes the menu without creating anything', async () => {
    const invoke = install()
    render(<ManuscriptTree format="webnovel" />)
    fireEvent.contextMenu(row('Chapter 2'), { clientX: 40, clientY: 50 })
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await userEvent.click(row('Arc 2'))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('surfaces a failed menu create as a toast', async () => {
    const client: IpcClient = {
      invoke: async () => {
        throw new Error('Database is locked')
      },
      on: () => () => {}
    }
    setIpcClient(client)
    render(<ManuscriptTree format="webnovel" />)
    fireEvent.contextMenu(row('Chapter 2'), { clientX: 40, clientY: 50 })
    await userEvent.click(screen.getByRole('menuitem', { name: 'New Scene' }))
    await waitFor(() =>
      expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual(['Database is locked'])
    )
    expect(screen.queryByRole('treeitem', { name: 'Untitled Scene' })).not.toBeInTheDocument()
  })

  it('rename commits on Enter and updates the label', async () => {
    const invoke = install()
    render(<ManuscriptTree format="webnovel" />)
    act(() => useTreeStore.getState().startRename('sc-1'))
    const input = screen.getByRole('textbox', { name: 'Rename' })
    expect(input).toHaveFocus()
    await userEvent.keyboard('Opening{Enter}')
    expect(invoke).toHaveBeenCalledWith('tree:rename', { id: 'sc-1', title: 'Opening' })
    expect(screen.queryByRole('textbox', { name: 'Rename' })).not.toBeInTheDocument()
    expect(item('Opening')).toBeInTheDocument()
    expect(screen.queryByRole('treeitem', { name: 'Scene 1' })).not.toBeInTheDocument()
    expect(useTreeStore.getState().renamingId).toBeNull()
  })

  it('rename commits on blur', async () => {
    const invoke = install()
    render(<ManuscriptTree format="webnovel" />)
    act(() => useTreeStore.getState().startRename('sc-1'))
    await userEvent.keyboard('Opening')
    await userEvent.tab()
    expect(invoke).toHaveBeenCalledWith('tree:rename', { id: 'sc-1', title: 'Opening' })
    expect(item('Opening')).toBeInTheDocument()
  })

  it('Escape cancels the rename without IPC and leaves the tree key handler alone', async () => {
    const invoke = install()
    render(<ManuscriptTree format="webnovel" />)
    act(() => useTreeStore.getState().startRename('sc-1'))
    await userEvent.keyboard('Changed{Escape}')
    expect(invoke).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: 'Rename' })).not.toBeInTheDocument()
    expect(item('Scene 1')).toBeInTheDocument()
    expect(useTreeStore.getState().renamingId).toBeNull()
  })

  it('an empty or unchanged title ends the rename without IPC', async () => {
    const invoke = install()
    render(<ManuscriptTree format="webnovel" />)
    act(() => useTreeStore.getState().startRename('sc-1'))
    await userEvent.clear(screen.getByRole('textbox', { name: 'Rename' }))
    await userEvent.keyboard('   {Enter}')
    expect(invoke).not.toHaveBeenCalled()
    expect(item('Scene 1')).toBeInTheDocument()
    act(() => useTreeStore.getState().startRename('sc-1'))
    await userEvent.keyboard('{Enter}')
    expect(invoke).not.toHaveBeenCalled()
    expect(item('Scene 1')).toBeInTheDocument()
    expect(useTreeStore.getState().renamingId).toBeNull()
  })

  it('arrow keys typed in the rename input do not move the tree focus', async () => {
    install()
    render(<ManuscriptTree format="webnovel" />)
    act(() => useTreeStore.getState().startRename('sc-1'))
    const input = screen.getByRole('textbox', { name: 'Rename' })
    await userEvent.keyboard('{ArrowDown}{ArrowUp}')
    expect(input).toHaveFocus()
    expect(item('Chapter 2')).not.toHaveFocus()
  })

  it('surfaces a failed rename as a toast and keeps the old label', async () => {
    const client: IpcClient = {
      invoke: async () => {
        throw new Error('Title is too long')
      },
      on: () => () => {}
    }
    setIpcClient(client)
    render(<ManuscriptTree format="webnovel" />)
    act(() => useTreeStore.getState().startRename('sc-1'))
    await userEvent.keyboard('Opening{Enter}')
    expect(await screen.findByRole('treeitem', { name: 'Scene 1' })).toBeInTheDocument()
    expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual(['Title is too long'])
    expect(screen.queryByRole('textbox', { name: 'Rename' })).not.toBeInTheDocument()
  })
})
