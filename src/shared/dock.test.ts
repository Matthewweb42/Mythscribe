import { describe, expect, it } from 'vitest'
import {
  DOCK_EDGE_PX,
  DOCK_PANELS,
  defaultDock,
  dropTargetAt,
  isValidDock,
  movePanel,
  normalizeDock,
  sameDock,
  stepPanel,
  type DockColumns,
  type DockPanelId
} from './dock'

const all = (): boolean => true

describe('defaultDock', () => {
  it('puts the sidebar, the editor, the notes, the tags, the references, and the assistant in a column each', () => {
    expect(defaultDock()).toEqual([
      ['sidebar'],
      ['editor'],
      ['notes'],
      ['tags'],
      ['references'],
      ['assistant']
    ])
    expect(isValidDock(defaultDock())).toBe(true)
    expect(defaultDock()).not.toBe(defaultDock())
  })
})

describe('isValidDock', () => {
  it('wants every panel once, no empty column, and the editor alone', () => {
    expect(
      isValidDock([['sidebar', 'notes'], ['editor'], ['tags', 'references', 'assistant']])
    ).toBe(true)
    expect(isValidDock(defaultDock().slice(1))).toBe(false)
    expect(isValidDock([...defaultDock(), ['notes']])).toBe(false)
    expect(isValidDock([...defaultDock(), []])).toBe(false)
    expect(
      isValidDock([['sidebar', 'editor'], ['notes'], ['tags'], ['references'], ['assistant']])
    ).toBe(false)
    expect(isValidDock([...defaultDock(), ['console']])).toBe(false)
  })
})

describe('normalizeDock', () => {
  it('leaves a valid arrangement as it is', () => {
    const columns = [['assistant'], ['editor'], ['sidebar', 'notes'], ['tags', 'references']]
    expect(normalizeDock(columns)).toEqual(columns)
  })

  it('drops unknown names, repeats, and empty columns', () => {
    expect(
      normalizeDock([['sidebar', 'console'], [], ['editor', 'editor'], ['notes', 'sidebar']])
    ).toEqual([['sidebar'], ['editor'], ['notes'], ['tags'], ['references'], ['assistant']])
  })

  it('takes a stacked editor out into its own column where it was', () => {
    expect(
      normalizeDock([['sidebar', 'editor', 'notes'], ['tags'], ['references'], ['assistant']])
    ).toEqual([['sidebar'], ['editor'], ['notes'], ['tags'], ['references'], ['assistant']])
  })

  it('appends missing side panels and puts a missing editor in the middle', () => {
    expect(normalizeDock([['assistant'], ['editor']])).toEqual([
      ['assistant'],
      ['editor'],
      ['sidebar'],
      ['notes'],
      ['tags'],
      ['references']
    ])
    const repaired = normalizeDock([['sidebar'], ['notes']])
    expect(isValidDock(repaired)).toBe(true)
    expect(repaired[1]).toEqual(['editor'])
    expect(normalizeDock([])).toHaveLength(DOCK_PANELS.length)
  })
})

describe('movePanel', () => {
  it('opens a new column beside another panel, on either side', () => {
    const moved = movePanel(defaultDock(), 'assistant', {
      kind: 'beside',
      panel: 'editor',
      side: 'left'
    })
    expect(moved).toEqual([
      ['sidebar'],
      ['assistant'],
      ['editor'],
      ['notes'],
      ['tags'],
      ['references']
    ])
    expect(
      movePanel(defaultDock(), 'sidebar', { kind: 'beside', panel: 'assistant', side: 'right' })
    ).toEqual([['editor'], ['notes'], ['tags'], ['references'], ['assistant'], ['sidebar']])
  })

  it('stacks into another panel’s column above or below it, closing the column it left', () => {
    const below = movePanel(defaultDock(), 'assistant', {
      kind: 'stack',
      panel: 'notes',
      position: 'after'
    })
    expect(below).toEqual([
      ['sidebar'],
      ['editor'],
      ['notes', 'assistant'],
      ['tags'],
      ['references']
    ])
    const above = movePanel(below, 'tags', {
      kind: 'stack',
      panel: 'assistant',
      position: 'before'
    })
    expect(above).toEqual([['sidebar'], ['editor'], ['notes', 'tags', 'assistant'], ['references']])
    // Out of a stack into a column of its own again.
    expect(
      movePanel(above, 'tags', { kind: 'beside', panel: 'references', side: 'right' })
    ).toEqual([['sidebar'], ['editor'], ['notes', 'assistant'], ['references'], ['tags']])
  })

  it('moves the editor between columns but never stacks it or stacks onto it', () => {
    expect(
      movePanel(defaultDock(), 'editor', { kind: 'beside', panel: 'assistant', side: 'right' })
    ).toEqual([['sidebar'], ['notes'], ['tags'], ['references'], ['assistant'], ['editor']])
    const columns = defaultDock()
    expect(movePanel(columns, 'editor', { kind: 'stack', panel: 'notes', position: 'after' })).toBe(
      columns
    )
    expect(
      movePanel(columns, 'notes', { kind: 'stack', panel: 'editor', position: 'before' })
    ).toBe(columns)
  })

  it('returns the same arrangement for a drop on itself or one that changes nothing', () => {
    const columns = defaultDock()
    expect(movePanel(columns, 'notes', { kind: 'beside', panel: 'notes', side: 'left' })).toBe(
      columns
    )
    // Notes left of tags is where they already are.
    expect(movePanel(columns, 'notes', { kind: 'beside', panel: 'tags', side: 'left' })).toBe(
      columns
    )
  })
})

describe('stepPanel', () => {
  it('trades places with the next column on that side', () => {
    expect(stepPanel(defaultDock(), 'notes', 'left', all)).toEqual([
      ['sidebar'],
      ['notes'],
      ['editor'],
      ['tags'],
      ['references'],
      ['assistant']
    ])
    expect(stepPanel(defaultDock(), 'sidebar', 'right', all)).toEqual([
      ['editor'],
      ['sidebar'],
      ['notes'],
      ['tags'],
      ['references'],
      ['assistant']
    ])
  })

  it('skips the columns the author cannot see', () => {
    const hidden = new Set<DockPanelId>(['tags', 'references'])
    const visible = (column: readonly DockPanelId[]): boolean =>
      column.some((id) => !hidden.has(id))
    expect(stepPanel(defaultDock(), 'notes', 'right', visible)).toEqual([
      ['sidebar'],
      ['editor'],
      ['tags'],
      ['references'],
      ['assistant'],
      ['notes']
    ])
  })

  it('steps a stacked panel out into a column of its own on that side', () => {
    const stacked: DockColumns = [
      ['sidebar'],
      ['editor'],
      ['notes', 'tags'],
      ['references'],
      ['assistant']
    ]
    expect(stepPanel(stacked, 'tags', 'left', all)).toEqual([
      ['sidebar'],
      ['editor'],
      ['tags'],
      ['notes'],
      ['references'],
      ['assistant']
    ])
    expect(stepPanel(stacked, 'notes', 'right', all)).toEqual([
      ['sidebar'],
      ['editor'],
      ['tags'],
      ['notes'],
      ['references'],
      ['assistant']
    ])
  })

  it('returns the same arrangement at the edge', () => {
    const columns = defaultDock()
    expect(stepPanel(columns, 'sidebar', 'left', all)).toBe(columns)
    expect(stepPanel(columns, 'assistant', 'right', all)).toBe(columns)
    expect(sameDock(stepPanel(columns, 'notes', 'left', all), columns)).toBe(false)
  })
})

describe('dropTargetAt', () => {
  const rect = { left: 100, top: 50, width: 300, height: 600 }

  it('opens a new column from the strips along the left and right edges', () => {
    expect(dropTargetAt('notes', rect, 100 + DOCK_EDGE_PX - 1, 300)).toEqual({
      kind: 'beside',
      panel: 'notes',
      side: 'left'
    })
    expect(dropTargetAt('notes', rect, 400 - 10, 300)).toEqual({
      kind: 'beside',
      panel: 'notes',
      side: 'right'
    })
  })

  it('stacks above or below from the top and bottom halves', () => {
    expect(dropTargetAt('notes', rect, 250, 100)).toEqual({
      kind: 'stack',
      panel: 'notes',
      position: 'before'
    })
    expect(dropTargetAt('notes', rect, 250, 500)).toEqual({
      kind: 'stack',
      panel: 'notes',
      position: 'after'
    })
  })

  it('never stacks on the editor: its halves open a column left or right', () => {
    expect(dropTargetAt('editor', rect, 200, 100)).toEqual({
      kind: 'beside',
      panel: 'editor',
      side: 'left'
    })
    expect(dropTargetAt('editor', rect, 300, 500)).toEqual({
      kind: 'beside',
      panel: 'editor',
      side: 'right'
    })
  })
})
