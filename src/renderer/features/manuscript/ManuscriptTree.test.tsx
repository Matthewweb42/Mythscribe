import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { TreeNode } from '@shared/ipc/contract'
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

beforeEach(() => {
  useTreeStore.getState().clear()
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
})
