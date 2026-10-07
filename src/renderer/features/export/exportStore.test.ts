import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultExportFormatting } from '@shared/bookExport'
import type { TreeNode } from '@shared/ipc/contract'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex } from '@renderer/features/manuscript/treeStore'
import { setIpcClient } from '@renderer/lib/ipc'
import {
  buildExportOptions,
  chapterGroups,
  resetExportStore,
  useExportStore,
  type ExportChoices
} from './exportStore'

const defaults = defaultExportFormatting('* * *')

const choices = (over: Partial<ExportChoices> = {}): ExportChoices => ({
  format: 'md',
  scope: 'manuscript',
  chapterIds: [],
  includeFront: true,
  includeEnd: false,
  formatting: null,
  ...over
})

const context: { chapterIds: ReadonlySet<string>; openDocumentId: string | null } = {
  chapterIds: new Set(['ch-1', 'ch-2']),
  openDocumentId: 'sc-1'
}

beforeEach(() => {
  resetExportStore()
  setIpcClient(null)
})
afterEach(() => {
  resetExportStore()
  setIpcClient(null)
})

describe('chapterGroups (F-12.1)', () => {
  it('lists the manuscript’s chapters in reading order under their parts', () => {
    expect(chapterGroups(buildIndex(treeFixture))).toEqual([
      {
        partId: 'arc-1',
        partTitle: 'Arc 1',
        chapters: [
          { id: 'ch-1', title: 'Chapter 1' },
          { id: 'ch-2', title: 'Chapter 2' },
          { id: 'ch-3', title: 'Chapter 3' }
        ]
      },
      {
        partId: 'arc-2',
        partTitle: 'Arc 2',
        chapters: [
          { id: 'ch-4', title: 'Chapter 4' },
          { id: 'ch-5', title: 'Chapter 5' },
          { id: 'ch-6', title: 'Chapter 6' }
        ]
      }
    ])
  })

  it('groups chapters outside a part on their own and looks through generic folders', () => {
    const extra: TreeNode[] = [
      {
        ...treeFixture.find((n) => n.id === 'ch-1')!,
        id: 'loose',
        parentId: 'manuscript',
        position: 5,
        title: 'Loose'
      },
      {
        ...treeFixture.find((n) => n.id === 'ch-1')!,
        id: 'box',
        parentId: 'manuscript',
        position: 6,
        title: 'Box',
        hierarchyLevel: null
      },
      {
        ...treeFixture.find((n) => n.id === 'ch-1')!,
        id: 'boxed',
        parentId: 'box',
        position: 0,
        title: 'Boxed'
      }
    ]
    const groups = chapterGroups(buildIndex([...treeFixture, ...extra]))
    expect(groups.at(-1)).toEqual({
      partId: null,
      partTitle: null,
      chapters: [
        { id: 'loose', title: 'Loose' },
        { id: 'boxed', title: 'Boxed' }
      ]
    })
  })

  it('lists a scene at chapter level (root or part) like a chapter, not one inside a chapter', () => {
    const scene = treeFixture.find((n) => n.id === 'sc-1')!
    const extra: TreeNode[] = [
      { ...scene, id: 'prologue', parentId: 'manuscript', position: -1, title: 'Prologue' },
      { ...scene, id: 'interlude', parentId: 'arc-1', position: 5, title: 'Interlude' }
    ]
    const groups = chapterGroups(buildIndex([...treeFixture, ...extra]))
    expect(groups[0]).toEqual({
      partId: null,
      partTitle: null,
      chapters: [{ id: 'prologue', title: 'Prologue' }]
    })
    expect(groups[1]?.chapters.map((c) => c.id)).toEqual(['ch-1', 'ch-2', 'ch-3', 'interlude'])
  })

  it('answers no groups without a manuscript section', () => {
    expect(chapterGroups({ byId: {}, childrenOf: {}, rootIds: [] })).toEqual([])
  })
})

describe('buildExportOptions (F-12.1)', () => {
  it('builds the whole-manuscript options with the default formatting', () => {
    expect(buildExportOptions(choices(), defaults, context)).toEqual({
      format: 'md',
      scope: { kind: 'manuscript' },
      includeFront: true,
      includeEnd: false,
      formatting: defaults
    })
  })

  it('sends only the ticked chapters still in the manuscript, and nothing when none is left', () => {
    expect(
      buildExportOptions(
        choices({ scope: 'chapters', chapterIds: ['gone', 'ch-2'] }),
        defaults,
        context
      )?.scope
    ).toEqual({ kind: 'chapters', ids: ['ch-2'] })
    expect(
      buildExportOptions(choices({ scope: 'chapters', chapterIds: ['gone'] }), defaults, context)
    ).toBeNull()
  })

  it('needs an open document for a single-document export', () => {
    expect(buildExportOptions(choices({ scope: 'document' }), defaults, context)?.scope).toEqual({
      kind: 'document',
      id: 'sc-1'
    })
    expect(
      buildExportOptions(choices({ scope: 'document' }), defaults, {
        ...context,
        openDocumentId: null
      })
    ).toBeNull()
  })

  it('trims the scene break and refuses a blank one', () => {
    const formatting = { ...defaults, sceneBreak: '  #  ' }
    expect(
      buildExportOptions(choices({ formatting }), defaults, context)?.formatting.sceneBreak
    ).toBe('#')
    expect(
      buildExportOptions(
        choices({ formatting: { ...defaults, sceneBreak: '   ' } }),
        defaults,
        context
      )
    ).toBeNull()
  })
})

describe('useExportStore (F-12.1)', () => {
  it('toggles chapters without duplicates and clears back to the defaults', () => {
    const store = useExportStore.getState()
    store.toggleChapter('ch-1', true)
    store.toggleChapter('ch-1', true)
    store.toggleChapter('ch-2', true)
    store.toggleChapter('ch-1', false)
    expect(useExportStore.getState().chapterIds).toEqual(['ch-2'])
    store.setFormat('epub')
    store.clear()
    expect(useExportStore.getState()).toMatchObject({
      format: 'pdf',
      chapterIds: [],
      scope: 'manuscript'
    })
  })
})
