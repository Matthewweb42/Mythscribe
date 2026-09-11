import { describe, expect, it } from 'vitest'
import { treeContextMenuItems } from './contextMenuItems'
import { treeFixture } from './treeFixture'
import { buildIndex } from './treeStore'

const index = buildIndex(treeFixture)
const ids = (nodeId: string): string[] =>
  treeContextMenuItems(index, nodeId, 'webnovel').map((item) => item.id)

describe('treeContextMenuItems', () => {
  it('offers every level plus the generic items on a chapter, labelled by format', () => {
    expect(treeContextMenuItems(index, 'ch-1', 'webnovel')).toEqual([
      { id: 'new-part', label: 'New Arc' },
      { id: 'new-chapter', label: 'New Chapter' },
      { id: 'new-scene', label: 'New Scene' },
      { id: 'new-generic-document', label: 'New document' },
      { id: 'new-generic-folder', label: 'New folder' },
      { id: 'rename', label: 'Rename' },
      { id: 'duplicate', label: 'Duplicate' },
      { id: 'delete', label: 'Delete' }
    ])
    expect(treeContextMenuItems(index, 'ch-1', 'novel')[0]?.label).toBe('New Part')
  })

  it('offers every level on a scene and on the manuscript root', () => {
    expect(ids('sc-3')).toEqual([
      'new-part',
      'new-chapter',
      'new-scene',
      'new-generic-document',
      'new-generic-folder',
      'rename',
      'duplicate',
      'delete'
    ])
    expect(ids('manuscript')).toEqual([
      'new-part',
      'new-chapter',
      'new-scene',
      'new-generic-document',
      'new-generic-folder'
    ])
  })

  it('omits a level that cannot be placed under the row', () => {
    const emptyArc = buildIndex(
      treeFixture.filter((node) => node.parentId !== 'arc-2' && node.parentId !== 'ch-4')
    )
    expect(treeContextMenuItems(emptyArc, 'arc-2', 'novel').map((item) => item.id)).toEqual([
      'new-part',
      'new-chapter',
      'new-generic-document',
      'new-generic-folder',
      'rename',
      'duplicate',
      'delete'
    ])
  })

  it('offers only the generic items (plus rename, duplicate, and delete on documents) in front and end matter', () => {
    expect(ids('title-page')).toEqual([
      'new-generic-document',
      'new-generic-folder',
      'rename',
      'duplicate',
      'delete'
    ])
    expect(ids('front')).toEqual(['new-generic-document', 'new-generic-folder'])
    expect(ids('end')).toEqual(['new-generic-document', 'new-generic-folder'])
  })

  it('never offers rename, duplicate, or delete on a section root (F-2.3)', () => {
    for (const section of ['front', 'manuscript', 'end']) {
      expect(ids(section)).not.toContain('rename')
      expect(ids(section)).not.toContain('duplicate')
      expect(ids(section)).not.toContain('delete')
    }
  })

  it('returns nothing for an unknown row', () => {
    expect(ids('missing')).toEqual([])
  })
})
