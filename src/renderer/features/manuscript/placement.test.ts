import { describe, expect, it } from 'vitest'
import type { TreeNode } from '@shared/ipc/contract'
import type { HierarchyLevel } from '@shared/labels'
import {
  resolveCreateTarget,
  resolveDropTarget,
  resolveGenericTarget,
  type CreateTarget,
  type DropTarget,
  type DropZone
} from './placement'
import { treeFixture } from './treeFixture'
import { buildIndex } from './treeStore'

const index = buildIndex(treeFixture)

/** Every cell of the placement rule table: level × target → expected placement. */
const table: { level: HierarchyLevel; target: string | null; expected: CreateTarget | null }[] = [
  // New Part
  { level: 'part', target: null, expected: { parentId: 'manuscript' } },
  { level: 'part', target: 'manuscript', expected: { parentId: 'manuscript' } },
  { level: 'part', target: 'arc-1', expected: { parentId: 'manuscript', afterId: 'arc-1' } },
  { level: 'part', target: 'ch-2', expected: { parentId: 'manuscript', afterId: 'arc-1' } },
  { level: 'part', target: 'sc-5', expected: { parentId: 'manuscript', afterId: 'arc-2' } },
  { level: 'part', target: 'front', expected: null },
  { level: 'part', target: 'title-page', expected: null },
  // New Chapter
  { level: 'chapter', target: null, expected: { parentId: 'arc-2' } },
  { level: 'chapter', target: 'manuscript', expected: { parentId: 'arc-2' } },
  { level: 'chapter', target: 'arc-1', expected: { parentId: 'arc-1' } },
  { level: 'chapter', target: 'ch-2', expected: { parentId: 'arc-1', afterId: 'ch-2' } },
  { level: 'chapter', target: 'sc-5', expected: { parentId: 'arc-2', afterId: 'ch-5' } },
  { level: 'chapter', target: 'front', expected: null },
  { level: 'chapter', target: 'title-page', expected: null },
  // New Scene
  { level: 'scene', target: null, expected: { parentId: 'ch-6' } },
  { level: 'scene', target: 'manuscript', expected: { parentId: 'ch-6' } },
  { level: 'scene', target: 'arc-1', expected: { parentId: 'ch-3' } },
  { level: 'scene', target: 'ch-2', expected: { parentId: 'ch-2' } },
  { level: 'scene', target: 'sc-5', expected: { parentId: 'ch-5', afterId: 'sc-5' } },
  { level: 'scene', target: 'front', expected: null },
  { level: 'scene', target: 'title-page', expected: null }
]

function node(
  id: string,
  parentId: string | null,
  position: number,
  kind: TreeNode['kind'],
  hierarchyLevel: HierarchyLevel | null,
  sectionType: TreeNode['sectionType'] = null
): TreeNode {
  return {
    id,
    parentId,
    sectionType,
    kind,
    hierarchyLevel,
    title: id,
    position,
    wordCount: 0,
    matterType: null,
    preset: null,
    created: '2026-09-10T12:00:00.000Z',
    modified: '2026-09-10T12:00:00.000Z'
  }
}

const sections = (): TreeNode[] => [
  node('front', null, 0, 'folder', null, 'front'),
  node('manuscript', null, 1, 'folder', null, 'manuscript'),
  node('end', null, 2, 'folder', null, 'end')
]

describe('resolveCreateTarget', () => {
  it.each(table)('new $level with target $target', ({ level, target, expected }) => {
    expect(resolveCreateTarget(index, target, level)).toEqual(expected)
  })

  it('treats an unknown id like no selection', () => {
    expect(resolveCreateTarget(index, 'nope', 'part')).toEqual({ parentId: 'manuscript' })
    expect(resolveCreateTarget(index, 'nope', 'scene')).toEqual({ parentId: 'ch-6' })
  })

  it('does not append to the "end" section root when it is the target', () => {
    expect(resolveCreateTarget(index, 'end', 'part')).toBeNull()
  })

  describe('missing intermediate levels', () => {
    const emptyPart = buildIndex([
      ...sections(),
      node('p-1', 'manuscript', 0, 'folder', 'part'),
      node('p-2', 'manuscript', 1, 'folder', 'part')
    ])
    const noParts = buildIndex(sections())

    it('returns null for a scene under a part with no chapters', () => {
      expect(resolveCreateTarget(emptyPart, 'p-1', 'scene')).toBeNull()
      expect(resolveCreateTarget(emptyPart, null, 'scene')).toBeNull()
    })

    it('still places chapters and parts when only chapters are missing', () => {
      expect(resolveCreateTarget(emptyPart, 'p-1', 'chapter')).toEqual({ parentId: 'p-1' })
      expect(resolveCreateTarget(emptyPart, null, 'chapter')).toEqual({ parentId: 'p-2' })
      expect(resolveCreateTarget(emptyPart, 'p-1', 'part')).toEqual({
        parentId: 'manuscript',
        afterId: 'p-1'
      })
    })

    it('returns null for chapters and scenes when the manuscript has no parts', () => {
      expect(resolveCreateTarget(noParts, null, 'part')).toEqual({ parentId: 'manuscript' })
      expect(resolveCreateTarget(noParts, null, 'chapter')).toBeNull()
      expect(resolveCreateTarget(noParts, 'manuscript', 'scene')).toBeNull()
    })
  })

  describe('generic nodes as the target', () => {
    const withGeneric = buildIndex([
      ...treeFixture,
      node('notes', 'ch-2', 1, 'folder', null),
      node('note-1', 'notes', 0, 'document', null),
      node('loose', 'manuscript', 2, 'document', null),
      node('extra-scene', 'ch-2', 2, 'document', 'scene')
    ])

    it('uses the nearest leveled ancestor', () => {
      expect(resolveCreateTarget(withGeneric, 'note-1', 'chapter')).toEqual({
        parentId: 'arc-1',
        afterId: 'ch-2'
      })
      expect(resolveCreateTarget(withGeneric, 'notes', 'scene')).toEqual({ parentId: 'ch-2' })
      expect(resolveCreateTarget(withGeneric, 'note-1', 'part')).toEqual({
        parentId: 'manuscript',
        afterId: 'arc-1'
      })
    })

    it('falls back to the manuscript root when no leveled ancestor exists', () => {
      expect(resolveCreateTarget(withGeneric, 'loose', 'part')).toEqual({ parentId: 'manuscript' })
      expect(resolveCreateTarget(withGeneric, 'loose', 'scene')).toEqual({ parentId: 'ch-6' })
    })

    it('skips generic siblings when picking the last child at a level', () => {
      const withTrailingGeneric = buildIndex([
        ...treeFixture,
        node('trailing', 'manuscript', 5, 'folder', null),
        node('trailing-doc', 'ch-6', 5, 'document', null)
      ])
      expect(resolveCreateTarget(withTrailingGeneric, null, 'chapter')).toEqual({
        parentId: 'arc-2'
      })
      expect(resolveCreateTarget(withTrailingGeneric, null, 'scene')).toEqual({ parentId: 'ch-6' })
    })
  })
})

describe('resolveGenericTarget', () => {
  it('appends inside a folder', () => {
    expect(resolveGenericTarget(index, 'ch-2')).toEqual({ parentId: 'ch-2' })
    expect(resolveGenericTarget(index, 'arc-1')).toEqual({ parentId: 'arc-1' })
  })

  it('places after a document', () => {
    expect(resolveGenericTarget(index, 'sc-3')).toEqual({ parentId: 'ch-3', afterId: 'sc-3' })
    expect(resolveGenericTarget(index, 'title-page')).toEqual({
      parentId: 'front',
      afterId: 'title-page'
    })
  })

  it('appends inside any section root', () => {
    expect(resolveGenericTarget(index, 'front')).toEqual({ parentId: 'front' })
    expect(resolveGenericTarget(index, 'manuscript')).toEqual({ parentId: 'manuscript' })
    expect(resolveGenericTarget(index, 'end')).toEqual({ parentId: 'end' })
  })

  it('returns null for an unknown id', () => {
    expect(resolveGenericTarget(index, 'nope')).toBeNull()
  })
})

describe('resolveDropTarget', () => {
  const drops: {
    name: string
    drag: string
    hover: string
    zone: DropZone
    expected: DropTarget | null
  }[] = [
    // Sibling reorders
    {
      name: 'before a sibling',
      drag: 'ch-3',
      hover: 'ch-1',
      zone: 'before',
      expected: { parentId: 'arc-1', afterId: null }
    },
    {
      name: 'after a sibling',
      drag: 'ch-1',
      hover: 'ch-3',
      zone: 'after',
      expected: { parentId: 'arc-1', afterId: 'ch-3' }
    },
    {
      name: 'before a later sibling',
      drag: 'ch-1',
      hover: 'ch-3',
      zone: 'before',
      expected: { parentId: 'arc-1', afterId: 'ch-2' }
    },
    // Re-parenting
    {
      name: 'into another chapter',
      drag: 'sc-1',
      hover: 'ch-2',
      zone: 'into',
      expected: { parentId: 'ch-2' }
    },
    {
      name: 'after a scene in another chapter',
      drag: 'sc-1',
      hover: 'sc-2',
      zone: 'after',
      expected: { parentId: 'ch-2', afterId: 'sc-2' }
    },
    {
      name: 'a chapter into the other arc',
      drag: 'ch-1',
      hover: 'arc-2',
      zone: 'into',
      expected: { parentId: 'arc-2' }
    },
    {
      name: 'a part into the manuscript root',
      drag: 'arc-1',
      hover: 'manuscript',
      zone: 'into',
      expected: { parentId: 'manuscript' }
    },
    {
      name: 'the last part into the manuscript root (no-op)',
      drag: 'arc-2',
      hover: 'manuscript',
      zone: 'into',
      expected: null
    },
    {
      name: 'a part before its sibling',
      drag: 'arc-2',
      hover: 'arc-1',
      zone: 'before',
      expected: { parentId: 'manuscript', afterId: null }
    },
    // Rejections
    { name: 'onto itself', drag: 'ch-1', hover: 'ch-1', zone: 'after', expected: null },
    { name: 'into its own descendant', drag: 'arc-1', hover: 'ch-2', zone: 'into', expected: null },
    {
      name: 'beside its own descendant',
      drag: 'arc-1',
      hover: 'sc-2',
      zone: 'after',
      expected: null
    },
    { name: 'across sections', drag: 'sc-1', hover: 'title-page', zone: 'after', expected: null },
    { name: 'into another section root', drag: 'sc-1', hover: 'end', zone: 'into', expected: null },
    {
      name: 'before a section root',
      drag: 'arc-1',
      hover: 'manuscript',
      zone: 'before',
      expected: null
    },
    {
      name: 'after a section root',
      drag: 'arc-1',
      hover: 'manuscript',
      zone: 'after',
      expected: null
    },
    { name: 'into a document', drag: 'sc-1', hover: 'sc-2', zone: 'into', expected: null },
    { name: 'a scene into a part', drag: 'sc-1', hover: 'arc-2', zone: 'into', expected: null },
    {
      name: 'a scene beside a chapter',
      drag: 'sc-1',
      hover: 'ch-4',
      zone: 'after',
      expected: null
    },
    {
      name: 'a chapter into the manuscript root',
      drag: 'ch-1',
      hover: 'manuscript',
      zone: 'into',
      expected: null
    },
    { name: 'a chapter into a chapter', drag: 'ch-1', hover: 'ch-4', zone: 'into', expected: null },
    { name: 'a section root', drag: 'front', hover: 'manuscript', zone: 'into', expected: null },
    { name: 'an unknown node', drag: 'nope', hover: 'ch-1', zone: 'after', expected: null },
    { name: 'onto an unknown node', drag: 'ch-1', hover: 'nope', zone: 'after', expected: null },
    // No-ops
    {
      name: 'after its previous sibling',
      drag: 'ch-2',
      hover: 'ch-1',
      zone: 'after',
      expected: null
    },
    {
      name: 'before its next sibling',
      drag: 'ch-2',
      hover: 'ch-3',
      zone: 'before',
      expected: null
    },
    {
      name: 'into its parent when already last',
      drag: 'ch-3',
      hover: 'arc-1',
      zone: 'into',
      expected: null
    },
    {
      name: 'into its parent when not last',
      drag: 'ch-1',
      hover: 'arc-1',
      zone: 'into',
      expected: { parentId: 'arc-1' }
    }
  ]

  it.each(drops)('$name', ({ drag, hover, zone, expected }) => {
    expect(resolveDropTarget(index, drag, hover, zone)).toEqual(expected)
  })

  it('lets generic nodes go anywhere within their section, but not beside a section root', () => {
    const withGeneric = buildIndex([
      ...treeFixture,
      node('notes', 'manuscript', 2, 'folder', null),
      node('note-1', 'notes', 0, 'document', null),
      node('back-1', 'end', 0, 'document', null)
    ])
    expect(resolveDropTarget(withGeneric, 'note-1', 'ch-2', 'into')).toEqual({ parentId: 'ch-2' })
    expect(resolveDropTarget(withGeneric, 'note-1', 'sc-4', 'before')).toEqual({
      parentId: 'ch-4',
      afterId: null
    })
    expect(resolveDropTarget(withGeneric, 'notes', 'arc-1', 'into')).toEqual({ parentId: 'arc-1' })
    expect(resolveDropTarget(withGeneric, 'note-1', 'manuscript', 'into')).toEqual({
      parentId: 'manuscript'
    })
    expect(resolveDropTarget(withGeneric, 'sc-1', 'notes', 'into')).toBeNull()
    expect(resolveDropTarget(withGeneric, 'back-1', 'notes', 'into')).toBeNull()
    expect(resolveDropTarget(withGeneric, 'back-1', 'end', 'before')).toBeNull()
  })
})
