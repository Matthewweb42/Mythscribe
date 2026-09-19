import { beforeEach, describe, expect, it } from 'vitest'
import { contract, type Channel, type Output, type TreeNode } from '@shared/ipc/contract'
import { matterTemplate } from '@shared/matterTemplates'
import { countWords } from '@shared/wordCount'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { treeFixture } from './treeFixture'
import {
  buildIndex,
  descendantDocuments,
  duplicateIntoIndex,
  insertIntoIndex,
  moveInIndex,
  planRemoval,
  removeFromIndex,
  setWordCountInIndex,
  useTreeStore,
  sessionDelta
} from './treeStore'

/** Answers every channel with the fixture, validated by the channel's real output schema. */
function fakeClient(): { client: IpcClient; calls: [Channel, unknown][] } {
  const calls: [Channel, unknown][] = []
  const client: IpcClient = {
    async invoke(channel, input) {
      calls.push([channel, input])
      return contract[channel].output.parse(treeFixture) as Output<typeof channel>
    },
    on: () => () => {}
  }
  return { client, calls }
}

/** What main returns for `tree:duplicate` on `id`: the copy (ids suffixed `-copy`) then its subtree. */
function duplicateRows(
  index: { byId: Record<string, TreeNode>; childrenOf: Record<string, string[]> },
  id: string
): TreeNode[] {
  const rows: TreeNode[] = []
  const copy = (
    sourceId: string,
    parentId: string | null,
    position: number,
    title: string
  ): void => {
    const source = index.byId[sourceId]
    if (!source) throw new Error('missing')
    const copied: TreeNode = {
      ...source,
      id: `${sourceId}-copy`,
      parentId,
      position,
      title,
      created: 'c',
      modified: 'm'
    }
    rows.push(copied)
    ;(index.childrenOf[sourceId] ?? []).forEach((childId, i) => {
      copy(childId, copied.id, i, index.byId[childId]?.title ?? '')
    })
  }
  const source = index.byId[id]
  if (!source) throw new Error('missing')
  copy(id, source.parentId, source.position + 1, `${source.title} (Copy)`)
  return rows
}

/**
 * What main returns for `tree:move`: the row under its new parent at the position resolved from
 * the tri-state `afterId` against the gap-closed siblings (the node itself excluded).
 */
function movedRow(
  index: { byId: Record<string, TreeNode>; childrenOf: Record<string, string[]> },
  id: string,
  parentId: string,
  afterId: string | null | undefined
): TreeNode {
  const moving = index.byId[id]
  if (!moving) throw new Error('missing')
  const siblings = (index.childrenOf[parentId] ?? []).filter((childId) => childId !== id)
  let position: number
  if (afterId === undefined) position = siblings.length
  else if (afterId === null) position = 0
  else {
    const at = siblings.indexOf(afterId)
    if (at < 0) throw new Error('missing sibling')
    position = at + 1
  }
  return { ...moving, parentId, position, modified: 'moved' }
}

/** A client that answers `tree:create`, `tree:rename`, `tree:duplicate`, `tree:delete`, and `tree:move` like main would, recording inputs. */
function mutationClient(): { client: IpcClient; calls: [Channel, unknown][] } {
  const calls: [Channel, unknown][] = []
  const client: IpcClient = {
    async invoke(channel, input) {
      calls.push([channel, input])
      const state = useTreeStore.getState()
      if (channel === 'tree:create') {
        const req = contract['tree:create'].input.parse(input)
        const after = req.afterId === undefined ? undefined : state.byId[req.afterId]
        const position = after ? after.position + 1 : (state.childrenOf[req.parentId] ?? []).length
        const template = req.template === undefined ? null : matterTemplate(req.template)
        const created: TreeNode = {
          id: 'new',
          parentId: req.parentId,
          sectionType: null,
          kind: req.kind,
          hierarchyLevel: req.hierarchyLevel,
          title: req.title ?? template?.title ?? `Untitled ${req.hierarchyLevel ?? req.kind}`,
          position,
          wordCount: template ? countWords(template.content) : 0,
          matterType: template?.id ?? null,
          preset: null,
          created: 'c',
          modified: 'm'
        }
        return created as Output<typeof channel>
      }
      if (channel === 'tree:rename') {
        const req = contract['tree:rename'].input.parse(input)
        const node = state.byId[req.id]
        if (!node) throw new Error('missing')
        return { ...node, title: req.title, modified: 'renamed' } as Output<typeof channel>
      }
      if (channel === 'tree:duplicate') {
        const req = contract['tree:duplicate'].input.parse(input)
        return duplicateRows(state, req.id) as Output<typeof channel>
      }
      if (channel === 'tree:delete') {
        const req = contract['tree:delete'].input.parse(input)
        if (!state.byId[req.id]) throw new Error('missing')
        return null as Output<typeof channel>
      }
      if (channel === 'tree:move') {
        const req = contract['tree:move'].input.parse(input)
        return movedRow(state, req.id, req.parentId, req.afterId) as Output<typeof channel>
      }
      return contract[channel].output.parse(treeFixture) as Output<typeof channel>
    },
    on: () => () => {}
  }
  return { client, calls }
}

const newNode = (parentId: string, position: number): TreeNode => ({
  id: 'new',
  parentId,
  sectionType: null,
  kind: 'document',
  hierarchyLevel: 'scene',
  title: 'Untitled Scene',
  position,
  wordCount: 0,
  matterType: null,
  preset: null,
  created: 'c',
  modified: 'm'
})

beforeEach(() => {
  useTreeStore.getState().clear()
})

describe('insertIntoIndex', () => {
  const index = buildIndex(treeFixture)

  it('inserts at the head and shifts every sibling down', () => {
    const next = insertIntoIndex(index, newNode('arc-1', 0))
    expect(next.childrenOf['arc-1']).toEqual(['new', 'ch-1', 'ch-2', 'ch-3'])
    expect(next.byId['ch-1']?.position).toBe(1)
    expect(next.byId['ch-3']?.position).toBe(3)
    expect(next.byId.new?.position).toBe(0)
    // The source index is untouched.
    expect(index.childrenOf['arc-1']).toEqual(['ch-1', 'ch-2', 'ch-3'])
    expect(index.byId['ch-1']?.position).toBe(0)
  })

  it('inserts in the middle and shifts only later siblings', () => {
    const next = insertIntoIndex(index, newNode('arc-1', 1))
    expect(next.childrenOf['arc-1']).toEqual(['ch-1', 'new', 'ch-2', 'ch-3'])
    expect(next.byId['ch-1']?.position).toBe(0)
    expect(next.byId['ch-2']?.position).toBe(2)
    expect(next.byId['ch-3']?.position).toBe(3)
  })

  it('appends at the tail and fills in the derived maps', () => {
    const next = insertIntoIndex(index, newNode('ch-1', 1))
    expect(next.childrenOf['ch-1']).toEqual(['sc-1', 'new'])
    expect(next.byId['sc-1']?.position).toBe(0)
    expect(next.childrenOf.new).toEqual([])
    expect(next.sectionOf.new).toBe('manuscript')
    expect(next.wordCountRollup.new).toBe(0)
    expect(next.wordCountRollup['ch-1']).toBe(1200)
    expect(next.rootIds).toBe(index.rootIds)
  })
})

describe('duplicateIntoIndex', () => {
  const index = buildIndex(treeFixture)

  it('places a copied scene after the original and adds its words to the rollups', () => {
    const next = duplicateIntoIndex(index, duplicateRows(index, 'sc-1'))
    expect(next.childrenOf['ch-1']).toEqual(['sc-1', 'sc-1-copy'])
    expect(next.byId['sc-1-copy']).toMatchObject({
      title: 'Scene 1 (Copy)',
      position: 1,
      wordCount: 1200
    })
    expect(next.sectionOf['sc-1-copy']).toBe('manuscript')
    expect(next.wordCountRollup['ch-1']).toBe(2400)
    expect(next.wordCountRollup['arc-1']).toBe(3200)
    expect(next.wordCountRollup.manuscript).toBe(6000)
    // The source index is untouched.
    expect(index.childrenOf['ch-1']).toEqual(['sc-1'])
    expect(index.wordCountRollup['ch-1']).toBe(1200)
  })

  it("shifts later siblings and lands a copied folder's subtree under the new parent ids", () => {
    const next = duplicateIntoIndex(index, duplicateRows(index, 'ch-1'))
    expect(next.childrenOf['arc-1']).toEqual(['ch-1', 'ch-1-copy', 'ch-2', 'ch-3'])
    expect(next.byId['ch-1']?.position).toBe(0)
    expect(next.byId['ch-1-copy']?.position).toBe(1)
    expect(next.byId['ch-2']?.position).toBe(2)
    expect(next.byId['ch-3']?.position).toBe(3)
    expect(next.childrenOf['ch-1-copy']).toEqual(['sc-1-copy'])
    expect(next.byId['sc-1-copy']).toMatchObject({
      parentId: 'ch-1-copy',
      title: 'Scene 1',
      position: 0
    })
    expect(next.childrenOf['ch-1']).toEqual(['sc-1'])
    expect(next.rootIds).toEqual(['front', 'manuscript', 'end'])
    expect(next.byId['arc-2']?.position).toBe(1)
  })

  it('returns the index unchanged for an empty response', () => {
    expect(duplicateIntoIndex(index, [])).toBe(index)
  })
})

describe('planRemoval', () => {
  const index = buildIndex(treeFixture)

  it('keeps the selection when it is outside the deleted subtree', () => {
    expect(planRemoval(index, 'ch-2', 'sc-1')).toEqual({
      removed: new Set(['ch-2', 'sc-2']),
      selectedId: 'sc-1'
    })
    expect(planRemoval(index, 'ch-2', null)?.selectedId).toBeNull()
  })

  it('falls back to the next sibling for a selected middle sibling', () => {
    expect(planRemoval(index, 'ch-2', 'ch-2')?.selectedId).toBe('ch-3')
  })

  it('falls back to the previous sibling for a selected last child', () => {
    expect(planRemoval(index, 'ch-3', 'ch-3')?.selectedId).toBe('ch-2')
  })

  it('falls back to the parent for a selected only child, unless the parent is a section', () => {
    expect(planRemoval(index, 'sc-1', 'sc-1')?.selectedId).toBe('ch-1')
    expect(planRemoval(index, 'title-page', 'title-page')?.selectedId).toBeNull()
  })

  it('falls back from a selected descendant of the deleted folder', () => {
    const plan = planRemoval(index, 'arc-1', 'sc-2')
    expect(plan?.removed).toEqual(
      new Set(['arc-1', 'ch-1', 'ch-2', 'ch-3', 'sc-1', 'sc-2', 'sc-3'])
    )
    expect(plan?.selectedId).toBe('arc-2')
  })

  it('returns null for section roots and unknown ids', () => {
    expect(planRemoval(index, 'manuscript', 'sc-1')).toBeNull()
    expect(planRemoval(index, 'missing', 'sc-1')).toBeNull()
  })
})

describe('removeFromIndex', () => {
  const index = buildIndex(treeFixture)

  it('drops a middle sibling, closes the gap, and lowers the rollups', () => {
    const next = removeFromIndex(index, 'ch-2')
    expect(next.childrenOf['arc-1']).toEqual(['ch-1', 'ch-3'])
    expect(next.byId['ch-2']).toBeUndefined()
    expect(next.byId['sc-2']).toBeUndefined()
    expect(next.byId['ch-1']?.position).toBe(0)
    expect(next.byId['ch-3']?.position).toBe(1)
    expect(next.sectionOf['sc-2']).toBeUndefined()
    expect(next.wordCountRollup['arc-1']).toBe(1200)
    expect(next.wordCountRollup.manuscript).toBe(4000)
    // The source index is untouched.
    expect(index.childrenOf['arc-1']).toEqual(['ch-1', 'ch-2', 'ch-3'])
    expect(index.wordCountRollup['arc-1']).toBe(2000)
  })

  it('drops a folder with its whole subtree and leaves other branches alone', () => {
    const next = removeFromIndex(index, 'arc-1')
    expect(next.childrenOf.manuscript).toEqual(['arc-2'])
    expect(next.byId['arc-2']?.position).toBe(0)
    for (const id of ['arc-1', 'ch-1', 'ch-2', 'ch-3', 'sc-1', 'sc-2', 'sc-3']) {
      expect(next.byId[id]).toBeUndefined()
    }
    expect(next.childrenOf['arc-2']).toEqual(['ch-4', 'ch-5', 'ch-6'])
    expect(next.rootIds).toEqual(['front', 'manuscript', 'end'])
    expect(next.wordCountRollup.manuscript).toBe(2800)
  })

  it('returns the index unchanged for section roots and unknown ids', () => {
    expect(removeFromIndex(index, 'manuscript')).toBe(index)
    expect(removeFromIndex(index, 'missing')).toBe(index)
  })
})

describe('moveInIndex', () => {
  const index = buildIndex(treeFixture)

  it('moves a sibling one position down within the same parent', () => {
    const next = moveInIndex(index, movedRow(index, 'ch-1', 'arc-1', 'ch-2'))
    expect(next.childrenOf['arc-1']).toEqual(['ch-2', 'ch-1', 'ch-3'])
    expect(next.byId['ch-2']?.position).toBe(0)
    expect(next.byId['ch-1']?.position).toBe(1)
    expect(next.byId['ch-3']?.position).toBe(2)
    expect(next.byId['ch-1']?.modified).toBe('moved')
    // The subtree follows and the rollups are unchanged.
    expect(next.childrenOf['ch-1']).toEqual(['sc-1'])
    expect(next.wordCountRollup['arc-1']).toBe(2000)
    // The source index is untouched.
    expect(index.childrenOf['arc-1']).toEqual(['ch-1', 'ch-2', 'ch-3'])
    expect(index.byId['ch-1']?.position).toBe(0)
  })

  it('moves the last sibling to the head with afterId null', () => {
    const next = moveInIndex(index, movedRow(index, 'ch-3', 'arc-1', null))
    expect(next.childrenOf['arc-1']).toEqual(['ch-3', 'ch-1', 'ch-2'])
    expect(next.byId['ch-3']?.position).toBe(0)
    expect(next.byId['ch-1']?.position).toBe(1)
    expect(next.byId['ch-2']?.position).toBe(2)
  })

  it('moves the head to the tail when afterId is omitted', () => {
    const next = moveInIndex(index, movedRow(index, 'ch-1', 'arc-1', undefined))
    expect(next.childrenOf['arc-1']).toEqual(['ch-2', 'ch-3', 'ch-1'])
    expect(next.byId['ch-1']?.position).toBe(2)
  })

  it('reparents a chapter, closes the old gap, opens the new one, and moves the words', () => {
    const next = moveInIndex(index, movedRow(index, 'ch-1', 'arc-2', 'ch-4'))
    expect(next.childrenOf['arc-1']).toEqual(['ch-2', 'ch-3'])
    expect(next.byId['ch-2']?.position).toBe(0)
    expect(next.byId['ch-3']?.position).toBe(1)
    expect(next.childrenOf['arc-2']).toEqual(['ch-4', 'ch-1', 'ch-5', 'ch-6'])
    expect(next.byId['ch-1']).toMatchObject({ parentId: 'arc-2', position: 1 })
    expect(next.byId['ch-5']?.position).toBe(2)
    expect(next.byId['ch-6']?.position).toBe(3)
    expect(next.childrenOf['ch-1']).toEqual(['sc-1'])
    expect(next.sectionOf['sc-1']).toBe('manuscript')
    expect(next.wordCountRollup['arc-1']).toBe(800)
    expect(next.wordCountRollup['arc-2']).toBe(4000)
    expect(next.wordCountRollup.manuscript).toBe(4800)
    expect(next.rootIds).toEqual(['front', 'manuscript', 'end'])
  })

  it('reparents a scene into an empty-looking chapter as its last child', () => {
    const next = moveInIndex(index, movedRow(index, 'sc-1', 'ch-3', undefined))
    expect(next.childrenOf['ch-1']).toBeUndefined() // buildIndex lists no entry for an empty folder
    expect(next.childrenOf['ch-3']).toEqual(['sc-3', 'sc-1'])
    expect(next.byId['sc-1']).toMatchObject({ parentId: 'ch-3', position: 1 })
    expect(next.wordCountRollup['ch-1']).toBe(0)
    expect(next.wordCountRollup['ch-3']).toBe(1200)
  })

  it('returns the index unchanged for section roots and unknown ids', () => {
    const manuscript = index.byId.manuscript
    if (!manuscript) throw new Error('missing')
    expect(moveInIndex(index, { ...manuscript, parentId: 'front', position: 0 })).toBe(index)
    expect(moveInIndex(index, newNode('ch-1', 0))).toBe(index)
  })
})

describe('setWordCountInIndex', () => {
  const index = buildIndex(treeFixture)

  it('replaces the own count and moves every ancestor rollup by the delta', () => {
    const next = setWordCountInIndex(index, 'sc-2', 1000)
    expect(next.byId['sc-2']?.wordCount).toBe(1000)
    expect(next.wordCountRollup['sc-2']).toBe(1000)
    expect(next.wordCountRollup['ch-2']).toBe(1000)
    expect(next.wordCountRollup['arc-1']).toBe(2200)
    expect(next.wordCountRollup.manuscript).toBe(5000)
    const down = setWordCountInIndex(next, 'sc-2', 0)
    expect(down.wordCountRollup['ch-2']).toBe(0)
    expect(down.wordCountRollup['arc-1']).toBe(1200)
    expect(down.wordCountRollup.manuscript).toBe(4000)
  })

  it('leaves other nodes, structure, and the previous index untouched', () => {
    const next = setWordCountInIndex(index, 'sc-1', 1300)
    expect(index.byId['sc-1']?.wordCount).toBe(1200)
    expect(index.wordCountRollup.manuscript).toBe(4800)
    expect(next.byId['sc-2']).toBe(index.byId['sc-2'])
    expect(next.wordCountRollup['ch-2']).toBe(800)
    expect(next.wordCountRollup['arc-2']).toBe(2800)
    expect(next.wordCountRollup.front).toBe(12)
    expect(next.childrenOf).toBe(index.childrenOf)
    expect(next.rootIds).toBe(index.rootIds)
    expect(next.sectionOf).toBe(index.sectionOf)
  })

  it('is a no-op for unknown ids and unchanged counts', () => {
    expect(setWordCountInIndex(index, 'nope', 5)).toBe(index)
    expect(setWordCountInIndex(index, 'sc-1', 1200)).toBe(index)
  })

  it('setWordCount applies it to the store', async () => {
    setIpcClient(fakeClient().client)
    await useTreeStore.getState().load()
    useTreeStore.getState().setWordCount('title-page', 20)
    const state = useTreeStore.getState()
    expect(state.byId['title-page']?.wordCount).toBe(20)
    expect(state.wordCountRollup.front).toBe(20)
    expect(state.wordCountRollup.manuscript).toBe(4800)
  })
})

describe('buildIndex', () => {
  const index = buildIndex(treeFixture)

  it('indexes nodes by id and orders roots and children by position', () => {
    expect(Object.keys(index.byId)).toHaveLength(18)
    expect(index.byId['sc-4']?.title).toBe('Scene 4')
    expect(index.rootIds).toEqual(['front', 'manuscript', 'end'])
    expect(index.childrenOf.manuscript).toEqual(['arc-1', 'arc-2'])
    expect(index.childrenOf['arc-1']).toEqual(['ch-1', 'ch-2', 'ch-3'])
    expect(index.childrenOf['arc-2']).toEqual(['ch-4', 'ch-5', 'ch-6'])
    expect(index.childrenOf['ch-1']).toEqual(['sc-1'])
    expect(index.childrenOf.front).toEqual(['title-page'])
    expect(index.childrenOf.end).toBeUndefined()
  })

  it('records the owning section of every node', () => {
    expect(index.sectionOf['sc-6']).toBe('manuscript')
    expect(index.sectionOf['ch-2']).toBe('manuscript')
    expect(index.sectionOf['title-page']).toBe('front')
    expect(index.sectionOf.manuscript).toBe('manuscript')
    expect(index.sectionOf.end).toBe('end')
  })

  it('rolls word counts up from documents to folders and sections', () => {
    expect(index.wordCountRollup['sc-1']).toBe(1200)
    expect(index.wordCountRollup['sc-3']).toBe(0)
    expect(index.wordCountRollup['ch-1']).toBe(1200)
    expect(index.wordCountRollup['ch-3']).toBe(0)
    expect(index.wordCountRollup['arc-1']).toBe(2000)
    expect(index.wordCountRollup['arc-2']).toBe(2800)
    expect(index.wordCountRollup.manuscript).toBe(4800)
    expect(index.wordCountRollup.front).toBe(12)
    expect(index.wordCountRollup['title-page']).toBe(12)
    expect(index.wordCountRollup.end).toBe(0)
  })
})

describe('descendantDocuments (F-3.8)', () => {
  const index = buildIndex(treeFixture)

  it('lists every document under a folder depth-first in position order, across chapters', () => {
    expect(descendantDocuments(index, 'arc-1')).toEqual(['sc-1', 'sc-2', 'sc-3'])
    expect(descendantDocuments(index, 'manuscript')).toEqual([
      'sc-1',
      'sc-2',
      'sc-3',
      'sc-4',
      'sc-5',
      'sc-6'
    ])
    expect(descendantDocuments(index, 'front')).toEqual(['title-page'])
  })

  it('follows position order, not insertion order, when siblings are reordered', () => {
    const reordered = buildIndex([
      ...treeFixture.filter((n) => n.id !== 'ch-1' && n.id !== 'ch-3'),
      { ...treeFixture.find((n) => n.id === 'ch-1')!, position: 2 },
      { ...treeFixture.find((n) => n.id === 'ch-3')!, position: 0 }
    ])
    expect(descendantDocuments(reordered, 'arc-1')).toEqual(['sc-3', 'sc-2', 'sc-1'])
  })

  it('yields nothing for an empty folder or an unknown id', () => {
    expect(descendantDocuments(index, 'end')).toEqual([])
    const emptied = removeFromIndex(index, 'sc-1')
    expect(descendantDocuments(emptied, 'ch-1')).toEqual([])
    expect(descendantDocuments(index, 'missing')).toEqual([])
  })

  it('yields a document itself', () => {
    expect(descendantDocuments(index, 'sc-4')).toEqual(['sc-4'])
    expect(descendantDocuments(index, 'title-page')).toEqual(['title-page'])
  })
})

describe('treeStore', () => {
  it('load fetches tree:list, rebuilds the index and marks loaded', async () => {
    const { client, calls } = fakeClient()
    setIpcClient(client)
    useTreeStore.setState({ selectedId: 'sc-1', collapsed: { 'arc-1': true } })
    await useTreeStore.getState().load()
    expect(calls).toEqual([['tree:list', undefined]])
    const state = useTreeStore.getState()
    expect(state.loaded).toBe(true)
    expect(state.rootIds).toEqual(['front', 'manuscript', 'end'])
    expect(state.wordCountRollup.manuscript).toBe(4800)
    expect(state.selectedId).toBeNull()
    expect(state.collapsed).toEqual({})
    // F-3.3: the session baseline is a copy of the rollup at load time.
    expect(state.sessionBaseline).toEqual(state.wordCountRollup)
    expect(state.sessionBaseline).not.toBe(state.wordCountRollup)
  })

  it('sessionDelta measures from the baseline and treats new nodes as all-new words (F-3.3)', () => {
    const state = {
      wordCountRollup: { 'sc-1': 1300, 'ch-1': 1300, manuscript: 5100, fresh: 40 },
      sessionBaseline: { 'sc-1': 1200, 'ch-1': 1200, manuscript: 4800 }
    }
    expect(sessionDelta(state, 'sc-1')).toBe(100)
    expect(sessionDelta(state, 'manuscript')).toBe(300)
    expect(sessionDelta(state, 'fresh')).toBe(40)
    expect(sessionDelta(state, 'missing')).toBe(0)
  })

  // F-3.3 bug: sessionBaseline is a snapshot per node id taken at load, but a folder's rollup
  // also moves when a document is reparented under it (or out of it), even though no words were
  // written. The folder's session delta should stay at 0; instead it jumps by the moved
  // subtree's word count in both directions.
  it('a moved document keeps its own session delta; folders carry none (only documents show one)', () => {
    const index = buildIndex(treeFixture)
    const baseline = { ...index.wordCountRollup } // snapshot as of "load"
    const next = moveInIndex(index, movedRow(index, 'ch-1', 'arc-2', 'ch-4')) // moves sc-1 (1200 words)
    const state = { wordCountRollup: next.wordCountRollup, sessionBaseline: baseline }
    expect(sessionDelta(state, 'sc-1')).toBe(0)
    // A folder's rollup shifts with structure (here by the moved 1200 words), which is why the
    // stacked view shows a folder's combined count without a delta.
    expect(next.wordCountRollup['arc-1']).toBe((baseline['arc-1'] ?? 0) - 1200)
  })

  it('drops a load response that arrives after clear or a newer load', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow: IpcClient = {
      async invoke(channel) {
        await gate
        return contract[channel].output.parse(treeFixture) as Output<typeof channel>
      },
      on: () => () => {}
    }
    setIpcClient(slow)
    const stale = useTreeStore.getState().load()
    useTreeStore.getState().clear()
    release()
    await stale
    expect(useTreeStore.getState().loaded).toBe(false)
    expect(useTreeStore.getState().rootIds).toEqual([])
  })

  it('select ignores section roots and unknown ids but accepts documents and folders', () => {
    useTreeStore.setState(buildIndex(treeFixture))
    useTreeStore.getState().select('manuscript')
    expect(useTreeStore.getState().selectedId).toBeNull()
    useTreeStore.getState().select('missing')
    expect(useTreeStore.getState().selectedId).toBeNull()
    useTreeStore.getState().select('sc-2')
    expect(useTreeStore.getState().selectedId).toBe('sc-2')
    useTreeStore.getState().select('arc-1')
    expect(useTreeStore.getState().selectedId).toBe('arc-1')
    useTreeStore.getState().select(null)
    expect(useTreeStore.getState().selectedId).toBeNull()
  })

  it('toggle flips only the given folder or section and ignores documents', () => {
    useTreeStore.setState(buildIndex(treeFixture))
    useTreeStore.getState().toggle('arc-1')
    expect(useTreeStore.getState().collapsed).toEqual({ 'arc-1': true })
    useTreeStore.getState().toggle('front')
    expect(useTreeStore.getState().collapsed).toEqual({ 'arc-1': true, front: true })
    useTreeStore.getState().toggle('arc-1')
    expect(useTreeStore.getState().collapsed).toEqual({ 'arc-1': false, front: true })
    useTreeStore.getState().toggle('sc-1')
    useTreeStore.getState().toggle('missing')
    expect(useTreeStore.getState().collapsed).toEqual({ 'arc-1': false, front: true })
  })

  it('clear resets every field', () => {
    useTreeStore.setState({
      ...buildIndex(treeFixture),
      selectedId: 'sc-1',
      collapsed: { front: true },
      sessionBaseline: { 'sc-1': 5 },
      tagFilter: 't-forest',
      loaded: true,
      renamingId: 'sc-1',
      busy: true
    })
    useTreeStore.getState().clear()
    expect(useTreeStore.getState()).toMatchObject({
      byId: {},
      childrenOf: {},
      rootIds: [],
      sectionOf: {},
      wordCountRollup: {},
      sessionBaseline: {},
      selectedId: null,
      collapsed: {},
      tagFilter: null,
      loaded: false,
      renamingId: null,
      busy: false
    })
  })

  it('setTagFilter picks a tag and null clears it; load resets it (F-4.10)', async () => {
    const { client } = fakeClient()
    setIpcClient(client)
    expect(useTreeStore.getState().tagFilter).toBeNull()
    useTreeStore.getState().setTagFilter('t-forest')
    expect(useTreeStore.getState().tagFilter).toBe('t-forest')
    useTreeStore.getState().setTagFilter(null)
    expect(useTreeStore.getState().tagFilter).toBeNull()
    useTreeStore.getState().setTagFilter('t-mara')
    await useTreeStore.getState().load()
    expect(useTreeStore.getState().tagFilter).toBeNull()
  })

  it('startRename accepts documents and folders but not sections; endRename clears it', () => {
    useTreeStore.setState(buildIndex(treeFixture))
    useTreeStore.getState().startRename('manuscript')
    expect(useTreeStore.getState().renamingId).toBeNull()
    useTreeStore.getState().startRename('ch-1')
    expect(useTreeStore.getState().renamingId).toBe('ch-1')
    useTreeStore.getState().endRename()
    expect(useTreeStore.getState().renamingId).toBeNull()
  })

  it('createLevel(scene) with a scene selected inserts a sibling after it, selects it and opens rename', async () => {
    const { client, calls } = mutationClient()
    setIpcClient(client)
    useTreeStore.setState({
      ...buildIndex(treeFixture),
      loaded: true,
      selectedId: 'sc-1',
      collapsed: { 'ch-1': true, 'arc-1': true }
    })
    await useTreeStore.getState().createLevel('scene')
    expect(calls).toEqual([
      [
        'tree:create',
        { parentId: 'ch-1', afterId: 'sc-1', kind: 'document', hierarchyLevel: 'scene' }
      ]
    ])
    const state = useTreeStore.getState()
    expect(state.childrenOf['ch-1']).toEqual(['sc-1', 'new'])
    expect(state.byId.new?.title).toBe('Untitled scene')
    expect(state.selectedId).toBe('new')
    expect(state.renamingId).toBe('new')
    expect(state.collapsed).toEqual({ 'ch-1': false, 'arc-1': false, manuscript: false })
    expect(state.busy).toBe(false)
  })

  it('createLevel with keepSelection leaves the selection on the folder and still opens rename', async () => {
    const { client, calls } = mutationClient()
    setIpcClient(client)
    useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true, selectedId: 'ch-1' })
    await useTreeStore.getState().createLevel('scene', 'ch-1', { keepSelection: true })
    expect(calls).toHaveLength(1)
    const state = useTreeStore.getState()
    expect(state.childrenOf['ch-1']).toContain('new')
    expect(state.selectedId).toBe('ch-1')
    expect(state.renamingId).toBe('new')
  })

  it('createLevel does nothing when there is no valid placement', async () => {
    const { client, calls } = mutationClient()
    setIpcClient(client)
    useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true, selectedId: 'title-page' })
    await useTreeStore.getState().createLevel('scene')
    expect(calls).toEqual([])
    expect(useTreeStore.getState().renamingId).toBeNull()
  })

  it('createGeneric(folder, chapter) appends inside the chapter', async () => {
    const { client, calls } = mutationClient()
    setIpcClient(client)
    useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
    await useTreeStore.getState().createGeneric('folder', 'ch-1')
    expect(calls).toEqual([
      [
        'tree:create',
        { parentId: 'ch-1', afterId: undefined, kind: 'folder', hierarchyLevel: null }
      ]
    ])
    const state = useTreeStore.getState()
    expect(state.childrenOf['ch-1']).toEqual(['sc-1', 'new'])
    expect(state.byId.new?.position).toBe(1)
    expect(state.byId.new?.kind).toBe('folder')
    expect(state.selectedId).toBe('new')
    expect(state.renamingId).toBe('new')
  })

  it('createFromTemplate on the front root appends the templated document with its words, selects it, and skips rename (F-2.6)', async () => {
    const { client, calls } = mutationClient()
    setIpcClient(client)
    const index = buildIndex(treeFixture)
    useTreeStore.setState({
      ...index,
      loaded: true,
      selectedId: 'sc-1',
      collapsed: { front: true }
    })
    await useTreeStore.getState().createFromTemplate('dedication', 'front')
    expect(calls).toEqual([
      [
        'tree:create',
        {
          parentId: 'front',
          afterId: undefined,
          kind: 'document',
          hierarchyLevel: null,
          template: 'dedication'
        }
      ]
    ])
    const words = countWords(matterTemplate('dedication').content)
    expect(words).toBeGreaterThan(0)
    const state = useTreeStore.getState()
    expect(state.childrenOf.front).toEqual(['title-page', 'new'])
    expect(state.byId.new).toMatchObject({
      title: 'Dedication',
      kind: 'document',
      hierarchyLevel: null,
      matterType: 'dedication',
      wordCount: words,
      position: 1
    })
    expect(state.sectionOf.new).toBe('front')
    expect(state.wordCountRollup.new).toBe(words)
    expect(state.wordCountRollup.front).toBe((index.wordCountRollup.front ?? 0) + words)
    expect(state.wordCountRollup.manuscript).toBe(index.wordCountRollup.manuscript)
    expect(state.collapsed).toEqual({ front: false })
    expect(state.selectedId).toBe('new')
    expect(state.renamingId).toBeNull()
    expect(state.busy).toBe(false)
  })

  it('createFromTemplate inside a nested folder bumps every ancestor rollup and inserts after a document', async () => {
    const { client, calls } = mutationClient()
    setIpcClient(client)
    const folder: TreeNode = {
      ...newNode('front', 1),
      id: 'fm-folder',
      kind: 'folder',
      hierarchyLevel: null,
      title: 'Extras'
    }
    const index = buildIndex([...treeFixture, folder])
    useTreeStore.setState({ ...index, loaded: true })
    await useTreeStore.getState().createFromTemplate('epigraph', 'fm-folder')
    const words = countWords(matterTemplate('epigraph').content)
    let state = useTreeStore.getState()
    expect(state.childrenOf['fm-folder']).toEqual(['new'])
    expect(state.wordCountRollup['fm-folder']).toBe(words)
    expect(state.wordCountRollup.front).toBe((index.wordCountRollup.front ?? 0) + words)

    // Relative to a document: right after it, among its siblings.
    await useTreeStore.getState().createFromTemplate('copyright-page', 'title-page')
    expect(calls[1]).toEqual([
      'tree:create',
      {
        parentId: 'front',
        afterId: 'title-page',
        kind: 'document',
        hierarchyLevel: null,
        template: 'copyright-page'
      }
    ])
    state = useTreeStore.getState()
    expect(state.childrenOf.front).toEqual(['title-page', 'new', 'fm-folder'])
    expect(state.byId['fm-folder']?.position).toBe(2)
  })

  it('createFromTemplate does nothing for an unknown target', async () => {
    const { client, calls } = mutationClient()
    setIpcClient(client)
    const index = buildIndex(treeFixture)
    useTreeStore.setState({ ...index, loaded: true, selectedId: 'sc-1' })
    await useTreeStore.getState().createFromTemplate('glossary', 'missing')
    expect(calls).toEqual([])
    const state = useTreeStore.getState()
    expect(state.byId).toEqual(index.byId)
    expect(state.selectedId).toBe('sc-1')
    expect(state.renamingId).toBeNull()
  })

  it('rename replaces the record and clears a matching renamingId', async () => {
    const { client, calls } = mutationClient()
    setIpcClient(client)
    useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true, renamingId: 'sc-1' })
    await useTreeStore.getState().rename('sc-1', 'Opening')
    expect(calls).toEqual([['tree:rename', { id: 'sc-1', title: 'Opening' }]])
    const state = useTreeStore.getState()
    expect(state.byId['sc-1']?.title).toBe('Opening')
    expect(state.byId['sc-1']?.modified).toBe('renamed')
    expect(state.childrenOf['ch-1']).toEqual(['sc-1'])
    expect(state.renamingId).toBeNull()
    expect(state.busy).toBe(false)
  })

  it('duplicate merges the rows, selects the copy, and opens the ancestors without touching other collapse state', async () => {
    const { client, calls } = mutationClient()
    setIpcClient(client)
    useTreeStore.setState({
      ...buildIndex(treeFixture),
      loaded: true,
      selectedId: 'sc-2',
      collapsed: { 'ch-1': true, 'arc-1': true, 'arc-2': true }
    })
    await useTreeStore.getState().duplicate('sc-1')
    expect(calls).toEqual([['tree:duplicate', { id: 'sc-1' }]])
    const state = useTreeStore.getState()
    expect(state.childrenOf['ch-1']).toEqual(['sc-1', 'sc-1-copy'])
    expect(state.byId['sc-1-copy']?.title).toBe('Scene 1 (Copy)')
    expect(state.wordCountRollup['ch-1']).toBe(2400)
    expect(state.selectedId).toBe('sc-1-copy')
    expect(state.renamingId).toBeNull()
    expect(state.collapsed).toEqual({
      'ch-1': false,
      'arc-1': false,
      'arc-2': true,
      manuscript: false
    })
    expect(state.busy).toBe(false)
  })

  it('duplicate of a folder lands its subtree under the new parent ids', async () => {
    const { client } = mutationClient()
    setIpcClient(client)
    useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
    await useTreeStore.getState().duplicate('ch-1')
    const state = useTreeStore.getState()
    expect(state.childrenOf['arc-1']).toEqual(['ch-1', 'ch-1-copy', 'ch-2', 'ch-3'])
    expect(state.childrenOf['ch-1-copy']).toEqual(['sc-1-copy'])
    expect(state.byId['sc-1-copy']?.parentId).toBe('ch-1-copy')
    expect(state.byId['ch-3']?.position).toBe(3)
    expect(state.selectedId).toBe('ch-1-copy')
    expect(state.wordCountRollup['arc-1']).toBe(3200)
  })

  it('a rejected tree:duplicate leaves the index and selection untouched and propagates the error', async () => {
    const failing: IpcClient = {
      async invoke() {
        throw new Error('Sections cannot be duplicated')
      },
      on: () => () => {}
    }
    setIpcClient(failing)
    const index = buildIndex(treeFixture)
    useTreeStore.setState({ ...index, loaded: true, selectedId: 'sc-1' })
    await expect(useTreeStore.getState().duplicate('sc-1')).rejects.toThrow(
      'Sections cannot be duplicated'
    )
    const state = useTreeStore.getState()
    expect(state.byId).toEqual(index.byId)
    expect(state.childrenOf).toEqual(index.childrenOf)
    expect(state.selectedId).toBe('sc-1')
    expect(state.busy).toBe(false)
  })

  it('remove drops the subtree, moves the selection to the next sibling, and clears a removed renamingId', async () => {
    const { client, calls } = mutationClient()
    setIpcClient(client)
    useTreeStore.setState({
      ...buildIndex(treeFixture),
      loaded: true,
      selectedId: 'sc-2',
      renamingId: 'sc-2',
      collapsed: { 'ch-2': true, 'arc-2': true }
    })
    await useTreeStore.getState().remove('ch-2')
    expect(calls).toEqual([['tree:delete', { id: 'ch-2' }]])
    const state = useTreeStore.getState()
    expect(state.childrenOf['arc-1']).toEqual(['ch-1', 'ch-3'])
    expect(state.byId['ch-2']).toBeUndefined()
    expect(state.byId['sc-2']).toBeUndefined()
    expect(state.byId['ch-3']?.position).toBe(1)
    expect(state.selectedId).toBe('ch-3')
    expect(state.renamingId).toBeNull()
    expect(state.collapsed).toEqual({ 'arc-2': true })
    expect(state.wordCountRollup['arc-1']).toBe(1200)
    expect(state.busy).toBe(false)
  })

  it('remove clears renamingId when the deleted node itself was mid-rename', async () => {
    const { client } = mutationClient()
    setIpcClient(client)
    useTreeStore.setState({
      ...buildIndex(treeFixture),
      loaded: true,
      selectedId: 'sc-1',
      renamingId: 'sc-1'
    })
    await useTreeStore.getState().remove('sc-1')
    const state = useTreeStore.getState()
    expect(state.byId['sc-1']).toBeUndefined()
    expect(state.renamingId).toBeNull()
  })

  it('remove keeps a selection outside the subtree and a renamingId elsewhere', async () => {
    const { client } = mutationClient()
    setIpcClient(client)
    useTreeStore.setState({
      ...buildIndex(treeFixture),
      loaded: true,
      selectedId: 'sc-4',
      renamingId: 'sc-4'
    })
    await useTreeStore.getState().remove('sc-1')
    const state = useTreeStore.getState()
    expect(state.childrenOf['ch-1']).toBeUndefined() // buildIndex lists no entry for an empty folder
    expect(state.byId['sc-1']).toBeUndefined()
    expect(state.selectedId).toBe('sc-4')
    expect(state.renamingId).toBe('sc-4')
    expect(state.wordCountRollup['ch-1']).toBe(0)
  })

  it('a rejected tree:delete leaves the index and selection untouched and propagates the error', async () => {
    const failing: IpcClient = {
      async invoke() {
        throw new Error('Sections cannot be deleted')
      },
      on: () => () => {}
    }
    setIpcClient(failing)
    const index = buildIndex(treeFixture)
    useTreeStore.setState({ ...index, loaded: true, selectedId: 'sc-1' })
    await expect(useTreeStore.getState().remove('sc-1')).rejects.toThrow(
      'Sections cannot be deleted'
    )
    const state = useTreeStore.getState()
    expect(state.byId).toEqual(index.byId)
    expect(state.childrenOf).toEqual(index.childrenOf)
    expect(state.selectedId).toBe('sc-1')
    expect(state.busy).toBe(false)
  })

  it('move merges the returned row, opens the destination ancestors, and keeps the selection', async () => {
    const { client, calls } = mutationClient()
    setIpcClient(client)
    useTreeStore.setState({
      ...buildIndex(treeFixture),
      loaded: true,
      selectedId: 'sc-2',
      collapsed: { 'arc-2': true, 'ch-4': true, 'arc-1': true }
    })
    await useTreeStore.getState().move('ch-1', 'arc-2', 'ch-4')
    expect(calls).toEqual([['tree:move', { id: 'ch-1', parentId: 'arc-2', afterId: 'ch-4' }]])
    const state = useTreeStore.getState()
    expect(state.childrenOf['arc-1']).toEqual(['ch-2', 'ch-3'])
    expect(state.childrenOf['arc-2']).toEqual(['ch-4', 'ch-1', 'ch-5', 'ch-6'])
    expect(state.byId['ch-1']).toMatchObject({ parentId: 'arc-2', position: 1, modified: 'moved' })
    expect(state.wordCountRollup['arc-2']).toBe(4000)
    expect(state.selectedId).toBe('sc-2')
    expect(state.renamingId).toBeNull()
    expect(state.collapsed).toEqual({
      'arc-2': false,
      'ch-4': true,
      'arc-1': true,
      manuscript: false
    })
    expect(state.busy).toBe(false)
  })

  it('move reorders within the same parent and sends a null afterId for "first"', async () => {
    const { client, calls } = mutationClient()
    setIpcClient(client)
    useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
    await useTreeStore.getState().move('ch-3', 'arc-1', null)
    expect(calls).toEqual([['tree:move', { id: 'ch-3', parentId: 'arc-1', afterId: null }]])
    const state = useTreeStore.getState()
    expect(state.childrenOf['arc-1']).toEqual(['ch-3', 'ch-1', 'ch-2'])
    expect(state.byId['ch-1']?.position).toBe(1)
    expect(state.byId['ch-2']?.position).toBe(2)
  })

  it('move sets busy while in flight and drops the response after clear', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow: IpcClient = {
      async invoke(channel) {
        await gate
        return contract[channel].output.parse(
          movedRow(buildIndex(treeFixture), 'ch-1', 'arc-2', undefined)
        ) as Output<typeof channel>
      },
      on: () => () => {}
    }
    setIpcClient(slow)
    useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
    const pending = useTreeStore.getState().move('ch-1', 'arc-2')
    expect(useTreeStore.getState().busy).toBe(true)
    useTreeStore.getState().clear()
    release()
    await pending
    const state = useTreeStore.getState()
    expect(state.loaded).toBe(false)
    expect(state.byId).toEqual({})
    expect(state.busy).toBe(false)
  })

  it('a rejected tree:move leaves the index and selection untouched and propagates the error', async () => {
    const failing: IpcClient = {
      async invoke() {
        throw new Error('Moves are restricted to within a section')
      },
      on: () => () => {}
    }
    setIpcClient(failing)
    const index = buildIndex(treeFixture)
    useTreeStore.setState({ ...index, loaded: true, selectedId: 'sc-1' })
    await expect(useTreeStore.getState().move('title-page', 'ch-1')).rejects.toThrow(
      'Moves are restricted to within a section'
    )
    const state = useTreeStore.getState()
    expect(state.byId).toEqual(index.byId)
    expect(state.childrenOf).toEqual(index.childrenOf)
    expect(state.selectedId).toBe('sc-1')
    expect(state.busy).toBe(false)
  })

  it('a rejected tree:create leaves the index untouched and propagates the error', async () => {
    const failing: IpcClient = {
      async invoke() {
        throw new Error('Nodes can only be created inside a folder')
      },
      on: () => () => {}
    }
    setIpcClient(failing)
    const index = buildIndex(treeFixture)
    useTreeStore.setState({ ...index, loaded: true, selectedId: 'sc-1' })
    await expect(useTreeStore.getState().createLevel('scene')).rejects.toThrow(
      'Nodes can only be created inside a folder'
    )
    const state = useTreeStore.getState()
    expect(state.byId).toEqual(index.byId)
    expect(state.childrenOf).toEqual(index.childrenOf)
    expect(state.selectedId).toBe('sc-1')
    expect(state.renamingId).toBeNull()
    expect(state.busy).toBe(false)
  })
})
