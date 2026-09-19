import { describe, expect, it } from 'vitest'
import { tagFilterView } from './tagFilter'
import { treeFixture } from './treeFixture'
import { buildIndex } from './treeStore'

const index = buildIndex(treeFixture)

describe('tagFilterView (F-4.10)', () => {
  it('lists the matches in display order with their ancestors visible', () => {
    const view = tagFilterView(
      index,
      { 'sc-4': ['t-forest'], 'sc-2': ['t-mara', 't-forest'] },
      't-forest'
    )
    expect(view.matches).toEqual(['sc-2', 'sc-4'])
    expect([...view.visible].sort()).toEqual(
      ['arc-1', 'arc-2', 'ch-2', 'ch-4', 'manuscript', 'sc-2', 'sc-4'].sort()
    )
  })

  it('hides a section with no match inside it', () => {
    const view = tagFilterView(index, { 'title-page': ['t-forest'] }, 't-forest')
    expect(view.matches).toEqual(['title-page'])
    expect([...view.visible]).toEqual(['title-page', 'front'])
    expect(view.visible.has('manuscript')).toBe(false)
    expect(view.visible.has('end')).toBe(false)
  })

  it('shows a matching folder without its children', () => {
    const view = tagFilterView(index, { 'ch-1': ['t-forest'] }, 't-forest')
    expect(view.matches).toEqual(['ch-1'])
    expect(view.visible.has('ch-1')).toBe(true)
    expect(view.visible.has('sc-1')).toBe(false)
  })

  it('ignores links to unknown nodes and to other tags', () => {
    const view = tagFilterView(
      index,
      { gone: ['t-forest'], 'sc-1': ['t-mara'], 'sc-3': [] },
      't-forest'
    )
    expect(view.matches).toEqual([])
    expect(view.visible.size).toBe(0)
  })
})
