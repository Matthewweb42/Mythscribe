import { beforeEach, describe, expect, it } from 'vitest'
import { contract, type Channel, type Output } from '@shared/ipc/contract'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { treeFixture } from './treeFixture'
import { buildIndex, useTreeStore } from './treeStore'

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

beforeEach(() => {
  useTreeStore.getState().clear()
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
      loaded: true
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
      loaded: false
    })
  })
})
