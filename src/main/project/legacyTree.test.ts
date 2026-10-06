import { describe, expect, it } from 'vitest'
import { planLegacyTree, type LegacyDocument } from './legacyTree'

const NOW = '2026-10-06T12:00:00.000Z'
const SECTIONS = { front: 'F', manuscript: 'M', end: 'E' }

const doc = (over: Partial<LegacyDocument> & { id: string }): LegacyDocument => ({
  parent_id: null,
  name: over.id,
  type: 'document',
  content: null,
  doc_type: null,
  hierarchy_level: null,
  notes: null,
  position: 0,
  location: null,
  pov: null,
  timeline_position: null,
  section: null,
  matter_type: null,
  created: '2025-01-01T00:00:00.000Z',
  modified: '2025-01-01T00:00:00.000Z',
  ...over
})

function ids(): () => string {
  let n = 0
  return () => `n${++n}`
}

describe('planLegacyTree (F-1.6)', () => {
  it('puts orphans and rows caught in a cycle at the top level of the manuscript', () => {
    const plan = planLegacyTree(
      [
        doc({ id: 'orphan', parent_id: 'gone' }),
        doc({ id: 'a', parent_id: 'b', type: 'folder' }),
        doc({ id: 'b', parent_id: 'a', type: 'folder', position: 1 })
      ],
      SECTIONS,
      NOW,
      ids()
    )
    const parent = (v0: string): string | null | undefined =>
      plan.rows.find((row) => row.id === plan.ids.get(v0))?.parentId
    expect(parent('orphan')).toBe('M')
    expect(parent('a')).toBe('M')
    expect(parent('b')).toBe('M')
    expect(plan.rows.every((row) => row.parentId !== null)).toBe(true)
  })

  it('orders siblings by position then created, keeps known levels, and names the untitled', () => {
    const plan = planLegacyTree(
      [
        doc({ id: 'late', position: 1, created: '2025-01-02T00:00:00.000Z' }),
        doc({ id: 'early', position: 1, created: '2025-01-01T00:00:00.000Z', name: '  ' }),
        doc({ id: 'first', position: 0, hierarchy_level: 'novel', type: 'folder' }),
        doc({ id: 'scene', parent_id: 'first', hierarchy_level: 'scene' })
      ],
      SECTIONS,
      NOW,
      ids()
    )
    const top = plan.rows.filter((row) => row.parentId === 'M')
    expect(top.map((row) => [row.title, row.position, row.hierarchyLevel])).toEqual([
      ['first', 0, null],
      ['Untitled', 1, null],
      ['late', 2, null]
    ])
    expect(plan.rows.find((row) => row.title === 'scene')?.hierarchyLevel).toBe('scene')
  })

  it('makes no Notes folder when v0 had no notes', () => {
    const plan = planLegacyTree([doc({ id: 'x' })], SECTIONS, NOW, ids())
    expect(plan.rows.some((row) => row.title === 'Notes')).toBe(false)
  })
})
