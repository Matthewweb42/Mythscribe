import { describe, expect, it } from 'vitest'
import { threadGrid } from './threadGrid'

const rows = [
  { id: 'ch-1', depth: 0 },
  { id: 'a', depth: 1 },
  { id: 'b', depth: 1 },
  { id: 'ch-2', depth: 0 },
  { id: 'c', depth: 1 },
  { id: 'd', depth: 1 }
]
const isDocument = (id: string): boolean => !id.startsWith('ch-')

describe('threadGrid (F-11.1c)', () => {
  it('orders threads by first appearance, splits out unused ones, and marks gaps inside a span', () => {
    const grid = threadGrid(
      rows,
      isDocument,
      {
        a: ['romance', 'x'],
        b: [],
        c: ['mystery'],
        d: ['romance', 'mystery'],
        'ch-1': ['mystery']
      },
      ['mystery', 'romance', 'subplot']
    )
    expect(grid.threads).toEqual([
      { id: 'romance', scenes: 2, gaps: 2 },
      { id: 'mystery', scenes: 2, gaps: 0 }
    ])
    expect(grid.unused).toEqual(['subplot'])
    expect(grid.rows.map((r) => [r.id, r.isDocument, r.cells])).toEqual([
      ['ch-1', false, []],
      ['a', true, ['on', 'off']],
      ['b', true, ['gap', 'off']],
      ['ch-2', false, []],
      ['c', true, ['gap', 'on']],
      ['d', true, ['on', 'on']]
    ])
  })

  it('treats unloaded links as none and keeps depth', () => {
    const grid = threadGrid(rows, isDocument, {}, ['romance'])
    expect(grid.threads).toEqual([])
    expect(grid.unused).toEqual(['romance'])
    expect(grid.rows.map((r) => r.depth)).toEqual([0, 1, 1, 0, 1, 1])
    expect(grid.rows.every((r) => r.cells.length === 0)).toBe(true)
  })
})
