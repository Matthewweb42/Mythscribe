import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Input } from '@shared/ipc/contract'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetDismissedStore, useDismissedStore } from '@renderer/features/thisScene/dismissedStore'
import { setIpcClient } from '@renderer/lib/ipc'
import {
  claimViewFixture,
  installFakeMain,
  memoryStatusFixture,
  sceneMemoryFixture,
  sheetMemoryFixture,
  type FakeMain
} from './memoryFixture'
import { resetMemoryStore, useMemoryStore, useSceneMemory, useSheetMemory } from './memoryStore'

/**
 * F-16.18 (plan P2a §4): the renderer's one owner of what the reader shows: scenes and sheets read
 * while shown and dropped after, lines kept by id, the pushes from main applied, *Not right*
 * taking a line away at once.
 */

let main: FakeMain
const flush = (): Promise<void> => act(async () => await Promise.resolve())

beforeEach(() => {
  resetMemoryStore()
  resetDismissedStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  main = installFakeMain({
    'memory:scene': (input) =>
      sceneMemoryFixture((input as Input<'memory:scene'>).nodeId, {
        claims: [claimViewFixture(`c-${(input as Input<'memory:scene'>).nodeId}`)],
        mentioned: [{ recordId: 'r-ella', count: 1 }]
      }),
    'memory:sheet': (input) => {
      const { recordId, asOf } = input as Input<'memory:sheet'>
      return sheetMemoryFixture(recordId, { asOf, later: asOf === null ? 0 : 2 })
    },
    'memory:status': () => memoryStatusFixture({ todayUsd: 0.01 }),
    'memory:notices': () => [],
    'memory:cardLines': () => ({}),
    'memory:notRight': () => ({
      ok: true,
      outcome: 'dismissed',
      dismissed: {
        id: 'd-1',
        kind: 'notRight',
        key: 'k',
        recordId: 'r-mara',
        nodeId: 'sc-1',
        label: 'Mara Vell: Eyes grey',
        quote: null,
        created: '2026-10-12T10:00:00.000Z'
      }
    }),
    'memory:readNow': () => ({ ok: true, read: true, reason: null, readingId: 'r', costUsd: 0 })
  })
  useMemoryStore.getState().subscribe()
})
afterEach(() => {
  resetMemoryStore()
  resetDismissedStore()
  setIpcClient(null)
})

describe('useMemoryStore (F-16.18)', () => {
  it('reads a scene while it is shown, keeps its lines by id, and drops it after', async () => {
    const { result, unmount } = renderHook(() => useSceneMemory('sc-1'))
    await flush()
    expect(result.current?.claimIds).toEqual(['c-sc-1'])
    expect(useMemoryStore.getState().claims['c-sc-1']?.value).toBe('grey')
    unmount()
    expect(useMemoryStore.getState().scenes).toEqual({})
    expect(useMemoryStore.getState().claims).toEqual({})
  })

  it('reads again only the shown scenes and sheets a change names', async () => {
    renderHook(() => useSceneMemory('sc-1'))
    renderHook(() => useSceneMemory('sc-2'))
    renderHook(() => useSheetMemory('r-mara', null))
    await flush()
    main.calls.length = 0
    act(() => main.emit('memory:changed', { nodeIds: ['sc-2'], recordIds: [] }))
    await flush()
    expect(main.sent('memory:scene')).toEqual([{ nodeId: 'sc-2' }])
    main.calls.length = 0
    // A record a shown scene mentions, and the sheet of that record.
    act(() => main.emit('memory:changed', { nodeIds: [], recordIds: ['r-ella', 'r-mara'] }))
    await flush()
    expect(main.sent('memory:scene')).toEqual([{ nodeId: 'sc-1' }, { nodeId: 'sc-2' }])
    expect(main.sent('memory:sheet')).toEqual([{ recordId: 'r-mara', asOf: null }])
    main.calls.length = 0
    act(() => main.emit('names:changed', { nodeIds: ['sc-1'] }))
    await flush()
    expect(main.sent('memory:scene')).toEqual([{ nodeId: 'sc-1' }])
  })

  it('takes the status and the notices main pushes', async () => {
    await act(async () => await useMemoryStore.getState().load())
    expect(useMemoryStore.getState().status?.todayUsd).toBe(0.01)
    act(() => main.emit('memory:statusChanged', memoryStatusFixture({ todayUsd: 0.02 })))
    act(() =>
      main.emit('memory:noticesChanged', [
        { id: 'backlog', kind: 'backlog', scenes: 6, priceUsd: 0.01 }
      ])
    )
    expect(useMemoryStore.getState().status?.todayUsd).toBe(0.02)
    expect(useMemoryStore.getState().notices).toHaveLength(1)
  })

  it('keeps a sheet per record and as-of scene', async () => {
    const { result, rerender } = renderHook(({ asOf }) => useSheetMemory('r-mara', asOf), {
      initialProps: { asOf: null as string | null }
    })
    await flush()
    expect(result.current?.later).toBe(0)
    rerender({ asOf: 'sc-1' })
    await flush()
    expect(result.current).toMatchObject({ asOf: 'sc-1', later: 2 })
    expect(Object.keys(useMemoryStore.getState().sheets)).toEqual(['r-mara|sc-1'])
  })

  it('Not right takes the line away at once and adds the Dismissed row', async () => {
    renderHook(() => useSceneMemory('sc-1'))
    await flush()
    await act(async () => {
      await useMemoryStore.getState().notRight('c-sc-1', { kind: 'wrongValue' })
    })
    expect(main.sent('memory:notRight')).toEqual([
      { claimId: 'c-sc-1', choice: { kind: 'wrongValue' }, requestId: expect.any(String) as string }
    ])
    expect(useMemoryStore.getState().scenes['sc-1']?.claimIds).toEqual([])
    expect(useMemoryStore.getState().claims['c-sc-1']).toBeUndefined()
    expect(useDismissedStore.getState().items.map((row) => row.id)).toEqual(['d-1'])
  })

  it('Read now asks main to read the scene', async () => {
    const result = await useMemoryStore.getState().readNow('sc-1')
    expect(result).toMatchObject({ ok: true, read: true })
    expect(main.sent('memory:readNow')).toEqual([
      { nodeId: 'sc-1', requestId: expect.any(String) as string }
    ])
  })

  it('forgets everything on clear, and a late answer lands nowhere', async () => {
    renderHook(() => useSceneMemory('sc-1'))
    useMemoryStore.getState().clear()
    await flush()
    expect(useMemoryStore.getState().scenes).toEqual({})
  })
})
