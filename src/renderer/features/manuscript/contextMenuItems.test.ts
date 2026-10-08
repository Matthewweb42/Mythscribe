import { describe, expect, it } from 'vitest'
import { matterTemplatesFor } from '@shared/matterTemplates'
import { templateIdOf, treeContextMenuItems } from './contextMenuItems'
import { treeFixture } from './treeFixture'
import { buildIndex } from './treeStore'

const index = buildIndex(treeFixture)
const ids = (nodeId: string): string[] =>
  treeContextMenuItems(index, nodeId, 'webnovel').map((item) => item.id)
const labels = (nodeId: string): string[] =>
  treeContextMenuItems(index, nodeId, 'webnovel').map((item) => item.label)
const templateIds = (section: 'front' | 'end'): string[] =>
  matterTemplatesFor(section).map((template) => `template:${template.id}`)

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
      { id: 'delete', label: 'Delete' },
      { id: 'set-target', label: 'Set word target…' }
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
      'delete',
      'set-target'
    ])
    expect(ids('manuscript')).toEqual([
      'new-part',
      'new-chapter',
      'new-scene',
      'new-generic-document',
      'new-generic-folder'
    ])
  })

  it('offers New scene on an arc with no chapters: it goes right inside (flexible nesting)', () => {
    const emptyArc = buildIndex(
      treeFixture.filter((node) => node.parentId !== 'arc-2' && node.parentId !== 'ch-4')
    )
    expect(treeContextMenuItems(emptyArc, 'arc-2', 'novel').map((item) => item.id)).toEqual([
      'new-part',
      'new-chapter',
      'new-scene',
      'new-generic-document',
      'new-generic-folder',
      'rename',
      'duplicate',
      'delete',
      'set-target'
    ])
  })

  it('offers the generic items, then the section templates, then rename, duplicate, and delete on a front-matter document (F-2.6)', () => {
    expect(ids('title-page')).toEqual([
      'new-generic-document',
      'new-generic-folder',
      ...templateIds('front'),
      'rename',
      'duplicate',
      'delete'
    ])
    expect(templateIds('front')).toHaveLength(7)
  })

  it('labels the templates "New <Title>" in spec order on the front and end roots (F-2.6)', () => {
    expect(labels('front')).toEqual([
      'New document',
      'New folder',
      'New Title Page',
      'New Copyright Page',
      'New Dedication',
      'New Epigraph',
      'New Foreword',
      'New Preface',
      'New Table of Contents'
    ])
    expect(labels('end')).toEqual([
      'New document',
      'New folder',
      'New Acknowledgments',
      'New About the Author',
      "New Author's Note",
      'New Afterword',
      'New Appendix',
      'New Glossary',
      'New Bibliography'
    ])
    expect(ids('end')).toEqual([
      'new-generic-document',
      'new-generic-folder',
      ...templateIds('end')
    ])
  })

  it('offers no templates on manuscript rows (F-2.6)', () => {
    for (const nodeId of ['manuscript', 'arc-1', 'ch-1', 'sc-1']) {
      expect(ids(nodeId).filter((id) => id.startsWith('template:'))).toEqual([])
    }
  })

  it('never offers rename, duplicate, or delete on a section root (F-2.3)', () => {
    for (const section of ['front', 'manuscript', 'end']) {
      expect(ids(section)).not.toContain('rename')
      expect(ids(section)).not.toContain('duplicate')
      expect(ids(section)).not.toContain('delete')
    }
  })

  it('offers Clear word target only on a manuscript row that has one, never on matter or sections (F-10.3)', () => {
    expect(
      treeContextMenuItems(index, 'sc-1', 'novel', true)
        .slice(-2)
        .map((item) => item.label)
    ).toEqual(['Set word target…', 'Clear word target'])
    expect(ids('sc-1')).not.toContain('clear-target')
    expect(ids('title-page')).not.toContain('set-target')
    for (const section of ['front', 'manuscript', 'end'])
      expect(ids(section)).not.toContain('set-target')
  })

  it('offers Include in compile as a checkbox on documents and folders once the ticks are known (F-12.4)', () => {
    expect(treeContextMenuItems(index, 'sc-1', 'novel', false, false).at(-1)).toEqual({
      id: 'include-compile',
      label: 'Include in compile',
      checked: false
    })
    expect(treeContextMenuItems(index, 'title-page', 'novel', false, true).at(-1)).toMatchObject({
      id: 'include-compile',
      checked: true
    })
    expect(ids('sc-1')).not.toContain('include-compile')
    expect(
      treeContextMenuItems(index, 'manuscript', 'novel', false, true).map((item) => item.id)
    ).not.toContain('include-compile')
  })

  it('returns nothing for an unknown row', () => {
    expect(ids('missing')).toEqual([])
  })
})

describe('templateIdOf', () => {
  it('parses the template items the menu produces and nothing else', () => {
    for (const template of matterTemplatesFor('front')) {
      expect(templateIdOf(`template:${template.id}`)).toBe(template.id)
    }
    expect(templateIdOf('template:glossary')).toBe('glossary')
    expect(templateIdOf('template:colophon')).toBeNull()
    expect(templateIdOf('template:')).toBeNull()
    expect(templateIdOf('rename')).toBeNull()
    expect(templateIdOf('new-generic-document')).toBeNull()
  })
})
