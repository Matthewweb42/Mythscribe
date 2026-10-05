import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import type { SnapshotInfo, SnapshotRestore } from '@shared/snapshots'
import type { TiptapNodeT } from '@shared/tiptap'
import { resetDocumentStore, useDocumentStore } from '@renderer/features/editor/documentStore'
import { resetGoalsStore } from '@renderer/features/goals/goalsStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { registerPendingSave, resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetSnapshotStore, useSnapshotStore } from './snapshotStore'

const para = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

const snapshot = (id: string, name: string, over: Partial<SnapshotInfo> = {}): SnapshotInfo => ({
  id,
  name,
  note: '',
  kind: 'manual',
  scope: 'project',
  nodeId: null,
  nodeTitle: null,
  draftName: null,
  docCount: 7,
  wordCount: 4800,
  created: '2026-10-05T10:00:00.000Z',
  ...over
})

const ONE = [snapshot('s1', 'First')]
const TWO = [snapshot('s2', 'Second'), ...ONE]

let stored: Record<string, TiptapNodeT | null>
let answers: Partial<Record<string, unknown>>
let calls: string[]

function install(): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(async (channel: string, input: unknown) => {
    calls.push(channel)
    if (channel === 'document:get') {
      const { id } = input as { id: string }
      return { id, content: stored[id] ?? null }
    }
    if (channel in answers) {
      const v = answers[channel]
      if (v instanceof Error) throw v
      return v
    }
    throw new Error(`unexpected ${channel}`)
  })
  const client: IpcClient = {
    invoke: <C extends Channel>(channel: C, value: Input<C>) =>
      invoke(channel, value) as Promise<Output<C>>,
    on: () => () => undefined
  }
  setIpcClient(client)
  return invoke
}

const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)

beforeEach(() => {
  resetSnapshotStore()
  resetDocumentStore()
  resetGoalsStore()
  resetPendingSaves()
  useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
  useDialogStore.setState({ modals: [], toasts: [] })
  stored = {}
  answers = { 'snapshots:list': ONE }
  calls = []
})
afterEach(() => {
  resetSnapshotStore()
  resetDocumentStore()
  resetGoalsStore()
  resetPendingSaves()
  useTreeStore.getState().clear()
  setIpcClient(null)
})

describe('snapshotStore (F-8.6)', () => {
  it('loads the list', async () => {
    install()
    await useSnapshotStore.getState().load()
    expect(useSnapshotStore.getState().snapshots).toEqual(ONE)
  })

  it('takes a snapshot after flushing pending saves, keeping the list main answers', async () => {
    answers['snapshots:take'] = TWO
    const invoke = install()
    registerPendingSave(async () => {
      calls.push('flush')
    })
    await useSnapshotStore.getState().load()
    const input = {
      scope: 'document' as const,
      nodeId: 'sc-1',
      name: ' Second ',
      note: '',
      milestone: true
    }
    expect(await useSnapshotStore.getState().take(input)).toBe(true)
    expect(calls.indexOf('flush')).toBeLessThan(calls.indexOf('snapshots:take'))
    expect(invoke).toHaveBeenCalledWith('snapshots:take', input)
    expect(useSnapshotStore.getState().snapshots).toEqual(TWO)
    expect(useSnapshotStore.getState().busy).toBe(false)
    expect(toasts()).toEqual(['Took "Second".'])
  })

  it('does not take a snapshot when the flush fails, and toasts the cause', async () => {
    answers['snapshots:take'] = TWO
    install()
    registerPendingSave(async () => {
      throw new Error('disk full')
    })
    await useSnapshotStore.getState().load()
    expect(
      await useSnapshotStore
        .getState()
        .take({ scope: 'project', name: 'X', note: '', milestone: false })
    ).toBe(false)
    expect(calls).not.toContain('snapshots:take')
    expect(useSnapshotStore.getState().snapshots).toEqual(ONE)
    expect(toasts()).toEqual(['disk full'])
  })

  it('updates and deletes through main', async () => {
    const renamed = [snapshot('s1', 'Renamed', { kind: 'milestone' })]
    answers['snapshots:update'] = renamed
    answers['snapshots:delete'] = []
    const invoke = install()
    await useSnapshotStore.getState().load()
    expect(
      await useSnapshotStore.getState().update({ id: 's1', name: 'Renamed', milestone: true })
    ).toBe(true)
    expect(invoke).toHaveBeenCalledWith('snapshots:update', {
      id: 's1',
      name: 'Renamed',
      milestone: true
    })
    expect(useSnapshotStore.getState().snapshots).toEqual(renamed)
    expect(await useSnapshotStore.getState().remove('s1')).toBe(true)
    expect(invoke).toHaveBeenCalledWith('snapshots:delete', { id: 's1' })
    expect(useSnapshotStore.getState().snapshots).toEqual([])
    expect(toasts()).toEqual(['Deleted "Renamed".'])
  })

  it('toasts main’s refusal and keeps the list', async () => {
    answers['snapshots:delete'] = new Error('Snapshot not found.')
    install()
    await useSnapshotStore.getState().load()
    expect(await useSnapshotStore.getState().remove('s1')).toBe(false)
    expect(useSnapshotStore.getState().snapshots).toEqual(ONE)
    expect(toasts()).toEqual(['Snapshot not found.'])
  })

  it('restores one document or all, refreshing what main rewrote without counting it as writing', async () => {
    const auto = snapshot('s3', 'Before restoring "First"', { kind: 'auto' })
    const restored: SnapshotRestore = {
      snapshots: [auto, ...ONE],
      changed: [{ id: 'sc-2', wordCount: 7 }]
    }
    answers['snapshots:restore'] = restored
    const invoke = install()
    await useSnapshotStore.getState().load()
    stored['sc-2'] = para('New text.')
    await useDocumentStore.getState().load('sc-2')
    stored['sc-2'] = para('The text it had back then, seven words.')
    useTreeStore.setState((s) => ({ sessionBaseline: { ...s.wordCountRollup } }))

    expect(await useSnapshotStore.getState().restore('s1', ['sc-2'])).toBe(true)
    expect(invoke).toHaveBeenCalledWith('snapshots:restore', { id: 's1', nodeIds: ['sc-2'] })
    expect(useSnapshotStore.getState().snapshots?.[0]?.kind).toBe('auto')
    expect(useTreeStore.getState().byId['sc-2']?.wordCount).toBe(7)
    // Not words written: the session baseline moves with the count.
    expect(useTreeStore.getState().sessionBaseline['sc-2']).toBe(7)
    expect(useDocumentStore.getState().docs['sc-2']?.content).toEqual(
      para('The text it had back then, seven words.')
    )
    expect(await useSnapshotStore.getState().restore('s1')).toBe(true)
    expect(invoke).toHaveBeenCalledWith('snapshots:restore', { id: 's1' })
    expect(toasts()).toEqual(['Restored the document from "First".', 'Restored "First".'])
  })

  it('drops an answer that arrives after the project closed', async () => {
    let release: (list: SnapshotInfo[]) => void = () => undefined
    answers['snapshots:list'] = new Promise<SnapshotInfo[]>((resolve) => {
      release = resolve
    })
    install()
    const loading = useSnapshotStore.getState().load()
    useSnapshotStore.getState().clear()
    release(ONE)
    await loading
    expect(useSnapshotStore.getState().snapshots).toBeNull()
  })
})
