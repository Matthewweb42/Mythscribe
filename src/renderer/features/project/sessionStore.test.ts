import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { SESSION_POSITIONS_MAX, defaultProjectSession, type ProjectSession } from '@shared/session'
import { entityFixture } from '@renderer/features/entities/entityFixture'
import { resetEntityStore, useEntityStore } from '@renderer/features/entities/entityStore'
import { resetFocusStore, useFocusStore } from '@renderer/features/focus/focusStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import {
  resetOutlineViewStore,
  useOutlineViewStore
} from '@renderer/features/outline/outlineViewStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { tagFixture } from '@renderer/features/tags/tagFixture'
import { resetTagStore, useTagStore } from '@renderer/features/tags/tagStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { flushPendingSaves, resetPendingSaves } from './pendingSaves'
import { SESSION_SAVE_DELAY_MS, resetSessionStore, useSessionStore } from './sessionStore'

let stored: ProjectSession
let writes: Input<'session:set'>[]
let calls: string[]

function install(): void {
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push(channel)
      if (channel === 'session:get') return stored as Output<C>
      if (channel === 'session:set') {
        const value = input as Input<'session:set'>
        writes.push(value)
        return value as Output<C>
      }
      if (channel === 'layout:set') return input as Output<C>
      if (channel === 'window:setFullScreen') return input as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
}

const store = (): ReturnType<typeof useSessionStore.getState> => useSessionStore.getState()

/** The tree, the story bible, and the tag bank as `App` has them loaded. */
function seedProject(): void {
  useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
  useEntityStore.setState({
    byId: Object.fromEntries(entityFixture.map((e) => [e.id, e])),
    loaded: true
  })
  useTagStore.setState({ byId: Object.fromEntries(tagFixture.map((t) => [t.id, t])) })
}

async function load(): Promise<void> {
  await store().load(Promise.resolve())
}

beforeEach(() => {
  vi.useFakeTimers()
  resetSessionStore()
  resetPendingSaves()
  resetLayoutStore()
  resetFocusStore()
  resetOutlineViewStore()
  resetEntityStore()
  resetTagStore()
  useTreeStore.getState().clear()
  useDialogStore.setState({ modals: [], toasts: [] })
  stored = defaultProjectSession()
  writes = []
  calls = []
  install()
  vi.stubGlobal('innerWidth', 1000)
})
afterEach(() => {
  resetSessionStore()
  resetLayoutStore()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useSessionStore (F-1.7)', () => {
  it('restores what still exists and drops stale ids silently', async () => {
    seedProject()
    stored = {
      ...defaultProjectSession(),
      selectedNodeId: 'sc-2',
      sidebarTab: 'tags',
      collapsed: ['ch-1', 'gone', 'sc-1'],
      tagFilter: 'tag-gone',
      folderView: 'cork',
      sceneDetailsOpen: true,
      positions: [
        { id: 'gone', scrollTop: 5, selection: null },
        { id: 'sc-2', scrollTop: 300, selection: { anchor: 3, head: 7 } }
      ]
    }
    await load()
    const tree = useTreeStore.getState()
    expect(tree.selectedId).toBe('sc-2')
    expect(tree.collapsed).toEqual({ 'ch-1': true })
    expect(tree.tagFilter).toBeNull()
    expect(useLayoutStore.getState().layout.sidebar.tab).toBe('tags')
    expect(useOutlineViewStore.getState().folderView).toBe('cork')
    expect(store().sceneDetailsOpen).toBe(true)
    expect(store().positions.map((p) => p.id)).toEqual(['sc-2'])
    expect(store().positionOf('sc-2')).toEqual({
      id: 'sc-2',
      scrollTop: 300,
      selection: { anchor: 3, head: 7 }
    })
    // Restoring is not a move: nothing is written back.
    await vi.advanceTimersByTimeAsync(SESSION_SAVE_DELAY_MS * 2)
    expect(writes).toEqual([])
  })

  it('reopens an entity page and keeps a tag filter whose tag is in the bank', async () => {
    seedProject()
    stored = {
      ...defaultProjectSession(),
      selectedNodeId: 'sc-1',
      selectedEntityId: 'e-mara',
      tagFilter: 't-forest'
    }
    await load()
    expect(useTreeStore.getState().selectedId).toBe('sc-1')
    expect(useEntityStore.getState().selectedId).toBe('e-mara')
    expect(useTreeStore.getState().tagFilter).toBe('t-forest')
    // The entity page is over the scene, so the editor under it does not take the focus.
    expect(store().takeCaretFocus('sc-1')).toBe(false)
  })

  it('ignores a section root, a missing node, and a missing entity', async () => {
    seedProject()
    stored = { ...defaultProjectSession(), selectedNodeId: 'manuscript', selectedEntityId: 'e-x' }
    await load()
    expect(useTreeStore.getState().selectedId).toBeNull()
    expect(useEntityStore.getState().selectedId).toBeNull()
    stored = { ...defaultProjectSession(), selectedNodeId: 'deleted' }
    await load()
    expect(useTreeStore.getState().selectedId).toBeNull()
  })

  it('leaves the app-wide sidebar tab alone for a project without a session', async () => {
    seedProject()
    useLayoutStore.getState().setSidebarTab('outline')
    await load()
    expect(useLayoutStore.getState().layout.sidebar.tab).toBe('outline')
  })

  it('hands the focus once to the restored document', async () => {
    seedProject()
    stored = { ...defaultProjectSession(), selectedNodeId: 'sc-1' }
    await load()
    expect(store().takeCaretFocus('sc-2')).toBe(false)
    // Any ready editor uses up the offer, so a later one never steals the focus.
    expect(store().takeCaretFocus('sc-1')).toBe(false)
    await load()
    expect(store().takeCaretFocus('sc-1')).toBe(true)
    expect(store().takeCaretFocus('sc-1')).toBe(false)
  })

  it('enters focus mode when the project closed in it', async () => {
    seedProject()
    stored = { ...defaultProjectSession(), focus: true }
    await load()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toContain('window:setFullScreen')
    expect(useFocusStore.getState().active).toBe(true)
  })

  it('still restores what it can when a load it waited for failed', async () => {
    seedProject()
    stored = { ...defaultProjectSession(), selectedNodeId: 'sc-3' }
    await store().load(Promise.reject(new Error('tags failed')))
    expect(useTreeStore.getState().selectedId).toBe('sc-3')
  })

  it('writes the moves after one debounce, read from the stores that own them', async () => {
    seedProject()
    await load()
    useTreeStore.getState().select('sc-4')
    useTreeStore.getState().toggle('ch-2')
    store().recordSelection('sc-4', { anchor: 2, head: 2 })
    store().recordScroll('sc-4', 120.4)
    useOutlineViewStore.getState().setFolderView('cork')
    store().setSceneDetailsOpen(true)
    expect(writes).toEqual([])
    await vi.advanceTimersByTimeAsync(SESSION_SAVE_DELAY_MS)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toEqual({
      ...defaultProjectSession(),
      selectedNodeId: 'sc-4',
      sidebarTab: 'manuscript',
      collapsed: ['ch-2'],
      folderView: 'cork',
      sceneDetailsOpen: true,
      positions: [{ id: 'sc-4', scrollTop: 120, selection: { anchor: 2, head: 2 } }]
    })
  })

  it('ignores tree changes that are not moves', async () => {
    seedProject()
    await load()
    useTreeStore.getState().setWordCount('sc-1', 99)
    await vi.advanceTimersByTimeAsync(SESSION_SAVE_DELAY_MS)
    expect(writes).toEqual([])
  })

  it('flushes a pending move through the pending-save registry', async () => {
    seedProject()
    await load()
    useTreeStore.getState().select('sc-5')
    await flushPendingSaves()
    expect(writes.map((w) => w.selectedNodeId)).toEqual(['sc-5'])
    await vi.advanceTimersByTimeAsync(SESSION_SAVE_DELAY_MS)
    expect(writes).toHaveLength(1)
    // Nothing pending: the next flush writes nothing.
    await flushPendingSaves()
    expect(writes).toHaveLength(1)
  })

  it('records nothing before a load or after clear, and clear drops the pending write', async () => {
    store().recordSelection('sc-1', { anchor: 1, head: 1 })
    store().recordScroll('sc-1', 10)
    expect(store().positions).toEqual([])
    seedProject()
    await load()
    useTreeStore.getState().select('sc-6')
    store().clear()
    useTreeStore.getState().select('sc-1')
    store().recordScroll('sc-1', 10)
    await vi.advanceTimersByTimeAsync(SESSION_SAVE_DELAY_MS * 2)
    await flushPendingSaves()
    expect(writes).toEqual([])
    expect(store().positions).toEqual([])
  })

  it('keeps the most recent documents first, capped', async () => {
    seedProject()
    await load()
    for (let i = 0; i < SESSION_POSITIONS_MAX + 3; i++) store().recordScroll(`d${i}`, i)
    store().recordSelection('d5', { anchor: 1, head: 4 })
    const positions = store().positions
    expect(positions).toHaveLength(SESSION_POSITIONS_MAX)
    expect(positions[0]).toEqual({ id: 'd5', scrollTop: 5, selection: { anchor: 1, head: 4 } })
    expect(positions[1]?.id).toBe(`d${SESSION_POSITIONS_MAX + 2}`)
  })

  it('toasts a failed write and tries again on the next flush', async () => {
    seedProject()
    await load()
    let fail = true
    setIpcClient({
      async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
        if (channel !== 'session:set') throw new Error(`unexpected ${channel}`)
        if (fail) throw new Error('disk full')
        const value = input as Input<'session:set'>
        writes.push(value)
        return value as Output<C>
      },
      on: () => () => {}
    })
    useTreeStore.getState().select('sc-2')
    await vi.advanceTimersByTimeAsync(SESSION_SAVE_DELAY_MS)
    expect(
      useDialogStore
        .getState()
        .toasts.map((t) => t.message)
        .join(' ')
    ).toContain('disk full')
    fail = false
    await flushPendingSaves()
    expect(writes.map((w) => w.selectedNodeId)).toEqual(['sc-2'])
  })
})
