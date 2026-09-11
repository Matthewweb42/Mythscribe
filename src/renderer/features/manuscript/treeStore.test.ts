import { beforeEach, describe, expect, it } from 'vitest'
import { contract, type Channel, type Output, type TreeNode } from '@shared/ipc/contract'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { treeFixture } from './treeFixture'
import { buildIndex, insertIntoIndex, useTreeStore } from './treeStore'

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

/** A client that answers `tree:create` and `tree:rename` like main would, recording inputs. */
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
        const created: TreeNode = {
          id: 'new',
          parentId: req.parentId,
          sectionType: null,
          kind: req.kind,
          hierarchyLevel: req.hierarchyLevel,
          title: req.title ?? `Untitled ${req.hierarchyLevel ?? req.kind}`,
          position,
          wordCount: 0,
          matterType: null,
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
      selectedId: null,
      collapsed: {},
      loaded: false,
      renamingId: null,
      busy: false
    })
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
