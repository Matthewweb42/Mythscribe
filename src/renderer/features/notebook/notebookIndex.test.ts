import { describe, expect, it } from 'vitest'
import type { NotebookItem } from '@shared/notebook'
import { changedLines } from './notebookChanges'
import {
  NOTEBOOK_ROOT,
  buildNotebookIndex,
  notebookDropTarget,
  notebookDropZone,
  notebookRows,
  notebookTargetFolder,
  positionBetween
} from './notebookIndex'

const item = (
  id: string,
  kind: NotebookItem['kind'],
  parentId: string | null,
  position: number
): NotebookItem => ({ id, kind, parentId, position, title: id, modified: '2026-10-15T00:00:00Z' })

// people/ (mara, tomas), places/ (quay), ideas (a page at the top)
const ITEMS = [
  item('ideas', 'page', null, 2),
  item('people', 'folder', null, 0),
  item('places', 'folder', null, 1),
  item('tomas', 'page', 'people', 1),
  item('mara', 'page', 'people', 0),
  item('quay', 'page', 'places', 0)
]

describe('the notebook tree helpers (notes redesign phase 1)', () => {
  const index = buildNotebookIndex(ITEMS)

  it('indexes children by parent in position order, an orphan at the top', () => {
    expect(index.childrenOf[NOTEBOOK_ROOT]).toEqual(['people', 'places', 'ideas'])
    expect(index.childrenOf.people).toEqual(['mara', 'tomas'])
    const orphan = buildNotebookIndex([item('lost', 'page', 'gone', 0)])
    expect(orphan.childrenOf[NOTEBOOK_ROOT]).toEqual(['lost'])
  })

  it('lists the rows on screen, skipping a collapsed folder’s children', () => {
    expect(notebookRows(index, {}).map((r) => `${r.id}@${r.depth}`)).toEqual([
      'people@1',
      'mara@2',
      'tomas@2',
      'places@1',
      'quay@2',
      'ideas@1'
    ])
    expect(notebookRows(index, { people: true }).map((r) => r.id)).toEqual([
      'people',
      'places',
      'quay',
      'ideas'
    ])
  })

  it('splits rows into drop zones as the manuscript tree does', () => {
    expect(notebookDropZone('page', 0.2)).toBe('before')
    expect(notebookDropZone('page', 0.6)).toBe('after')
    expect(notebookDropZone('folder', 0.1)).toBe('before')
    expect(notebookDropZone('folder', 0.5)).toBe('into')
    expect(notebookDropZone('folder', 0.9)).toBe('after')
  })

  it('places a drop between siblings, into a folder last, and refuses a folder into itself', () => {
    expect(notebookDropTarget(index, 'ideas', 'tomas', 'before')).toEqual({
      parentId: 'people',
      position: 0.5
    })
    expect(notebookDropTarget(index, 'ideas', 'tomas', 'after')).toEqual({
      parentId: 'people',
      position: 2
    })
    expect(notebookDropTarget(index, 'mara', 'places', 'into')).toEqual({
      parentId: 'places',
      position: 1
    })
    expect(notebookDropTarget(index, 'quay', 'people', 'before')).toEqual({
      parentId: null,
      position: -1
    })
    // Moving a row past its own neighbour leaves it out of the sibling list first.
    expect(notebookDropTarget(index, 'mara', 'tomas', 'after')).toEqual({
      parentId: 'people',
      position: 2
    })
    expect(notebookDropTarget(index, 'people', 'mara', 'before')).toBeNull()
    expect(notebookDropTarget(index, 'people', 'people', 'into')).toBeNull()
    expect(notebookDropTarget(index, 'mara', 'ideas', 'into')).toBeNull()
  })

  it('puts a new item in the selected folder, beside the selected page, or at the top', () => {
    expect(notebookTargetFolder(index, 'people')).toBe('people')
    expect(notebookTargetFolder(index, 'quay')).toBe('places')
    expect(notebookTargetFolder(index, 'ideas')).toBeNull()
    expect(notebookTargetFolder(index, null)).toBeNull()
  })

  it('takes midpoints and ends for positions', () => {
    expect(positionBetween(undefined, undefined)).toBe(0)
    expect(positionBetween(undefined, 3)).toBe(2)
    expect(positionBetween(3, undefined)).toBe(4)
    expect(positionBetween(1, 2)).toBe(1.5)
  })
})

describe('changedLines', () => {
  it('marks the lines Ms Scribe added to or took words from, the others unchanged', () => {
    const lines = changedLines(
      'Mara\nEyes: grey.\nBorn on the reef.',
      'Mara\nEyes: brown.\nBorn on the reef.\nSwore to find the heir.'
    )
    expect(lines.map((l) => [l.pieces.map((p) => p.text).join(''), l.changed])).toEqual([
      ['Mara', false],
      ['Eyes: grey.brown.', true],
      ['Born on the reef.', false],
      ['Swore to find the heir.', true]
    ])
    expect(lines[1]?.pieces).toEqual([
      { op: 'same', text: 'Eyes: ' },
      { op: 'del', text: 'grey.' },
      { op: 'add', text: 'brown.' }
    ])
  })

  it('shows a removed line on the line where it was cut', () => {
    const lines = changedLines('One.\nTwo.\nThree.', 'One.\nThree.')
    expect(lines.some((l) => l.changed && l.pieces.some((p) => p.op === 'del'))).toBe(true)
    expect(
      lines.map((l) =>
        l.pieces
          .filter((p) => p.op !== 'del')
          .map((p) => p.text)
          .join('')
      )
    ).toEqual(['One.', 'Three.'])
  })
})
