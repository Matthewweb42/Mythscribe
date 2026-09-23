import { describe, expect, it } from 'vitest'
import type { TagMentions } from '@shared/mentions'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex } from '@renderer/features/manuscript/treeStore'
import { sceneRowsForTag } from './tagUsage'

const index = buildIndex(treeFixture)
const byId = index.byId

const mention = (nodeId: string, count: number, from = 4): TagMentions => ({
  tagId: 't-mara',
  nodeId,
  count,
  ranges: [[from, from + 4]]
})

describe('sceneRowsForTag (F-9.4)', () => {
  it('lists the linked documents in tree order with their folder', () => {
    const rows = sceneRowsForTag(
      index,
      byId,
      { 'sc-4': ['t-mara'], 'sc-2': ['t-forest', 't-mara'], 'title-page': ['t-mara'] },
      undefined,
      't-mara'
    )
    expect(rows).toEqual([
      {
        id: 'title-page',
        title: 'Title Page',
        // The parent is a section root, whose label is generic.
        parentTitle: null,
        tagged: true,
        mentionCount: 0,
        first: null
      },
      {
        id: 'sc-2',
        title: 'Scene 2',
        parentTitle: 'Chapter 2',
        tagged: true,
        mentionCount: 0,
        first: null
      },
      {
        id: 'sc-4',
        title: 'Scene 4',
        parentTitle: 'Chapter 4',
        tagged: true,
        mentionCount: 0,
        first: null
      }
    ])
  })

  it('merges the mentions into the same list, in the same order', () => {
    const rows = sceneRowsForTag(
      index,
      byId,
      { 'sc-4': ['t-mara'] },
      [mention('sc-1', 2, 6), mention('sc-4', 1)],
      't-mara'
    )
    expect(rows.map((row) => [row.id, row.tagged, row.mentionCount])).toEqual([
      ['sc-1', false, 2],
      ['sc-4', true, 1]
    ])
    expect(rows[0]?.first).toEqual([6, 10])
    // A document that is both linked and mentioned is one row, not two.
    expect(rows[1]).toMatchObject({ tagged: true, mentionCount: 1, first: [4, 8] })
  })

  it('reads a mention row with no range as a search from the start', () => {
    const rows = sceneRowsForTag(
      index,
      byId,
      {},
      [{ tagId: 't-mara', nodeId: 'sc-3', count: 1, ranges: [] }],
      't-mara'
    )
    expect(rows[0]?.first).toEqual([0, 0])
  })

  it('ignores links and mentions of other tags, and rows whose node is gone', () => {
    const rows = sceneRowsForTag(
      index,
      byId,
      { 'sc-1': ['t-forest'], gone: ['t-mara'] },
      [{ tagId: 't-mara', nodeId: 'also-gone', count: 3, ranges: [[0, 4]] }],
      't-mara'
    )
    expect(rows).toEqual([])
  })
})
