import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DraftChange, DraftInfo, DraftList } from '@shared/drafts'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import type { TiptapNodeT } from '@shared/tiptap'
import { resetDocumentStore, useDocumentStore } from '@renderer/features/editor/documentStore'
import { resetGoalsStore } from '@renderer/features/goals/goalsStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { registerPendingSave, resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import {
  activeDraftOf,
  draftNameProblem,
  nextDraftName,
  resetDraftStore,
  useDraftStore
} from './draftStore'

const para = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

const draft = (id: string, name: string, active: boolean, wordCount = 100): DraftInfo => ({
  id,
  name,
  wordCount,
  active,
  created: '2026-10-04T10:00:00.000Z',
  modified: '2026-10-04T10:00:00.000Z'
})

const ONE: DraftList = { drafts: [draft('d1', 'Draft 1', true)], activeId: 'd1' }
const TWO: DraftList = {
  drafts: [draft('d1', 'Draft 1', true), draft('d2', 'Draft 2', false)],
  activeId: 'd1'
}
const SWITCHED: DraftList = {
  drafts: [draft('d1', 'Draft 1', false), draft('d2', 'Draft 2', true, 7)],
  activeId: 'd2'
}

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
  resetDraftStore()
  resetDocumentStore()
  resetGoalsStore()
  resetPendingSaves()
  useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
  useDialogStore.setState({ modals: [], toasts: [] })
  stored = {}
  answers = { 'drafts:list': TWO }
  calls = []
})
afterEach(() => {
  resetDraftStore()
  resetDocumentStore()
  resetGoalsStore()
  resetPendingSaves()
  useTreeStore.getState().clear()
  setIpcClient(null)
})

describe('draftStore (F-8.5)', () => {
  it('loads the list and knows the active draft', async () => {
    install()
    await useDraftStore.getState().load()
    expect(useDraftStore.getState().drafts).toEqual(TWO.drafts)
    expect(activeDraftOf(useDraftStore.getState())?.name).toBe('Draft 1')
  })

  it('switches after flushing, then refreshes word counts and open editors', async () => {
    const change: DraftChange = { list: SWITCHED, changed: [{ id: 'sc-2', wordCount: 7 }] }
    answers['drafts:switch'] = change
    const invoke = install()
    registerPendingSave(async () => {
      calls.push('flush')
    })
    await useDraftStore.getState().load()
    stored['sc-2'] = para('Old.')
    await useDocumentStore.getState().load('sc-2')
    stored['sc-2'] = para('The other draft has seven words here.')

    expect(await useDraftStore.getState().switchTo('d2')).toBe(true)
    expect(calls.indexOf('flush')).toBeLessThan(calls.indexOf('drafts:switch'))
    expect(invoke).toHaveBeenCalledWith('drafts:switch', { id: 'd2' })
    expect(useDraftStore.getState().activeId).toBe('d2')
    expect(useTreeStore.getState().byId['sc-2']?.wordCount).toBe(7)
    expect(useDocumentStore.getState().docs['sc-2']?.content).toEqual(
      para('The other draft has seven words here.')
    )
    expect(useDraftStore.getState().busy).toBe(false)
    expect(toasts()).toEqual(['Switched to "Draft 2".'])
  })

  it('does not ask main when switching to the active draft', async () => {
    install()
    await useDraftStore.getState().load()
    expect(await useDraftStore.getState().switchTo('d1')).toBe(true)
    expect(calls).toEqual(['drafts:list'])
  })

  it('does not switch when the flush fails, and toasts the cause', async () => {
    answers['drafts:switch'] = { list: SWITCHED, changed: [] }
    install()
    registerPendingSave(async () => {
      throw new Error('disk full')
    })
    await useDraftStore.getState().load()
    expect(await useDraftStore.getState().switchTo('d2')).toBe(false)
    expect(calls).not.toContain('drafts:switch')
    expect(useDraftStore.getState().activeId).toBe('d1')
    expect(toasts()).toEqual(['disk full'])
  })

  it('duplicates, renames, and deletes through main, keeping the list it answers', async () => {
    const three: DraftList = {
      drafts: [...TWO.drafts, draft('d3', 'Draft 3', false)],
      activeId: 'd1'
    }
    const renamed: DraftList = {
      drafts: [TWO.drafts[0]!, TWO.drafts[1]!, draft('d3', 'Final', false)],
      activeId: 'd1'
    }
    answers['drafts:duplicate'] = three
    answers['drafts:rename'] = renamed
    answers['drafts:delete'] = TWO
    const invoke = install()
    await useDraftStore.getState().load()

    expect(await useDraftStore.getState().duplicate('d1', ' Draft 3 ')).toBe(true)
    expect(invoke).toHaveBeenCalledWith('drafts:duplicate', { id: 'd1', name: ' Draft 3 ' })
    expect(useDraftStore.getState().drafts?.map((d) => d.name)).toEqual([
      'Draft 1',
      'Draft 2',
      'Draft 3'
    ])
    expect(await useDraftStore.getState().rename('d3', 'Final')).toBe(true)
    expect(useDraftStore.getState().drafts?.[2]?.name).toBe('Final')
    expect(await useDraftStore.getState().remove('d3')).toBe(true)
    expect(invoke).toHaveBeenCalledWith('drafts:delete', { id: 'd3' })
    expect(useDraftStore.getState().drafts).toHaveLength(2)
    expect(toasts()).toEqual(['Created "Draft 3".', 'Deleted "Final".'])
  })

  it('toasts main’s refusal and keeps the list', async () => {
    answers['drafts:rename'] = new Error('Another draft is already named "Draft 1".')
    install()
    await useDraftStore.getState().load()
    expect(await useDraftStore.getState().rename('d2', 'draft 1')).toBe(false)
    expect(useDraftStore.getState().drafts).toEqual(TWO.drafts)
    expect(toasts()).toEqual(['Another draft is already named "Draft 1".'])
  })

  it('reverts one scene or everything and refreshes what main rewrote', async () => {
    answers['drafts:revert'] = { list: TWO, changed: [{ id: 'sc-1', wordCount: 4 }] }
    const invoke = install()
    await useDraftStore.getState().load()
    expect(await useDraftStore.getState().revert('d2', ['sc-1'])).toBe(true)
    expect(invoke).toHaveBeenCalledWith('drafts:revert', { fromId: 'd2', nodeIds: ['sc-1'] })
    expect(useTreeStore.getState().byId['sc-1']?.wordCount).toBe(4)
    expect(await useDraftStore.getState().revert('d2')).toBe(true)
    expect(invoke).toHaveBeenCalledWith('drafts:revert', { fromId: 'd2' })
    expect(toasts()).toEqual(['Reverted the scene to "Draft 2".', 'Reverted to "Draft 2".'])
  })

  it('drops an answer that arrives after the project closed', async () => {
    let release: (list: DraftList) => void = () => undefined
    answers['drafts:list'] = new Promise<DraftList>((resolve) => {
      release = resolve
    })
    install()
    const loading = useDraftStore.getState().load()
    useDraftStore.getState().clear()
    release(ONE)
    await loading
    expect(useDraftStore.getState().drafts).toBeNull()
  })
})

describe('draft names', () => {
  it('offers "Draft N+1", counting on past a taken name', () => {
    expect(nextDraftName(ONE.drafts)).toBe('Draft 2')
    expect(nextDraftName([draft('a', 'Draft 1', true), draft('b', 'draft 3', false)])).toBe(
      'Draft 4'
    )
  })

  it('refuses empty, too long, and taken names, but not a draft’s own name', () => {
    expect(draftNameProblem('  ', TWO.drafts)).toBe('Enter a name.')
    expect(draftNameProblem('x'.repeat(61), TWO.drafts)).toBe('At most 60 characters.')
    expect(draftNameProblem(' DRAFT 2 ', TWO.drafts)).toBe('Another draft already has this name.')
    expect(draftNameProblem('Draft 2', TWO.drafts, 'd2')).toBeNull()
    expect(draftNameProblem('Final', TWO.drafts)).toBeNull()
  })
})
