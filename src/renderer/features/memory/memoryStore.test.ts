import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Input } from '@shared/ipc/contract'
import type { Dismissed } from '@shared/memory/dismissed'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetDismissedStore, useDismissedStore } from '@renderer/features/thisScene/dismissedStore'
import { setIpcClient } from '@renderer/lib/ipc'
import {
  claimViewFixture,
  installFakeMain,
  knowsGridFixture,
  memoryStatusFixture,
  sceneMemoryFixture,
  sheetMemoryFixture,
  threadsMemoryFixture,
  timelineFixture,
  type FakeMain
} from './memoryFixture'
import {
  resetMemoryStore,
  useKnowsGrid,
  useMemoryStore,
  useSceneMemory,
  useSheetMemory,
  useThreads,
  useTimeline
} from './memoryStore'

/**
 * F-16.18 (plan P2a §4): the renderer's one owner of what the reader shows: scenes and sheets read
 * while shown and dropped after, lines kept by id, the pushes from main applied, *Not right*
 * taking a line away at once.
 */

let main: FakeMain
const tombstone = (id: string, kind: 'split' | 'notRight'): Dismissed => ({
  id,
  kind,
  key: id,
  recordId: null,
  nodeId: null,
  label: id,
  quote: null,
  created: '2026-10-13T10:00:00.000Z'
})
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
      return sheetMemoryFixture(recordId, {
        asOf,
        later: asOf === null ? 0 : 2,
        // A knower's sheet reads the whole book (F-16.22).
        knows:
          recordId === 'r-orrin' ? { lines: [], others: [], later: 0, checkedUpTo: null } : null,
        // A place's Threads read the whole book too (F-16.23).
        threads: recordId === 'r-harbour' ? { threads: [], checkedUpTo: null } : null
      })
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
    'memory:readNow': () => ({ ok: true, read: true, reason: null, readingId: 'r', costUsd: 0 }),
    'memory:knows': (input) => knowsGridFixture({ asOf: (input as Input<'memory:knows'>).asOf }),
    'memory:threads': (input) =>
      threadsMemoryFixture({ asOf: (input as Input<'memory:threads'>).asOf }),
    'memory:timeline': (input) =>
      timelineFixture({ recordId: (input as Input<'memory:timeline'>).recordId }),
    'memory:knewBefore': () => ({ changed: true }),
    'memory:splitTopic': () => ({ recordId: 's-new', dismissed: tombstone('d-split', 'split') }),
    'memory:topicNotRight': () => ({ dismissed: [tombstone('d-gone', 'notRight')] })
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

  it('reads every shown scene again on a memory change, and only the sheets it names', async () => {
    renderHook(() => useSceneMemory('sc-1'))
    renderHook(() => useSceneMemory('sc-2'))
    renderHook(() => useSheetMemory('r-mara', null))
    await flush()
    main.calls.length = 0
    // F-16.22: a scene's memory is as of it over the whole book, so another scene's reading (a
    // new secret no one Here has a line about, "checked up to" moving) reads both again.
    act(() => main.emit('memory:changed', { nodeIds: ['sc-9'], recordIds: ['s-new'] }))
    await flush()
    expect(main.sent('memory:scene')).toEqual([{ nodeId: 'sc-1' }, { nodeId: 'sc-2' }])
    expect(main.sent('memory:sheet')).toEqual([])
    main.calls.length = 0
    // The sheet of a record the change names.
    act(() => main.emit('memory:changed', { nodeIds: [], recordIds: ['r-ella', 'r-mara'] }))
    await flush()
    expect(main.sent('memory:scene')).toEqual([{ nodeId: 'sc-1' }, { nodeId: 'sc-2' }])
    expect(main.sent('memory:sheet')).toEqual([{ recordId: 'r-mara', asOf: null }])
    main.calls.length = 0
    act(() => main.emit('names:changed', { nodeIds: ['sc-1'] }))
    await flush()
    expect(main.sent('memory:scene')).toEqual([{ nodeId: 'sc-1' }])
  })

  it('F-16.22: reads a knower’s or a secret’s sheet again whenever a scene moved', async () => {
    renderHook(() => useSheetMemory('r-orrin', null))
    renderHook(() => useSheetMemory('r-quay', null))
    await flush()
    main.calls.length = 0
    act(() => main.emit('memory:changed', { nodeIds: ['sc-9'], recordIds: [] }))
    await flush()
    // Orrin's Knows and its "checked up to" may have moved; the Quay's From the book did not.
    expect(main.sent('memory:sheet')).toEqual([{ recordId: 'r-orrin', asOf: null }])
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

  it('F-16.22: keeps a who-knows-what grid per as-of scene, read again on any change', async () => {
    const { result, unmount } = renderHook(() => useKnowsGrid('sc-2'))
    await flush()
    expect(result.current?.asOf).toBe('sc-2')
    main.calls.length = 0
    act(() => main.emit('memory:changed', { nodeIds: ['sc-9'], recordIds: [] }))
    await flush()
    expect(main.sent('memory:knows')).toEqual([{ asOf: 'sc-2' }])
    unmount()
    expect(useMemoryStore.getState().knows).toEqual({})
  })

  it('F-16.23: keeps the Threads per as-of scene and the Timeline per "Ages of", read again on any change', async () => {
    const threads = renderHook(() => useThreads('sc-2'))
    const timeline = renderHook(() => useTimeline('r-mara'))
    const sheet = renderHook(() => useSheetMemory('r-harbour', null))
    await flush()
    expect(threads.result.current?.asOf).toBe('sc-2')
    expect(timeline.result.current?.recordId).toBe('r-mara')
    main.calls.length = 0
    // A story year typed in another scene names no record: everything that reads the whole book
    // is read again, the place's Threads among them.
    act(() => main.emit('memory:changed', { nodeIds: ['sc-9'], recordIds: [] }))
    await flush()
    expect(main.sent('memory:threads')).toEqual([{ asOf: 'sc-2' }])
    expect(main.sent('memory:timeline')).toEqual([{ recordId: 'r-mara' }])
    expect(main.sent('memory:sheet')).toEqual([{ recordId: 'r-harbour', asOf: null }])
    threads.unmount()
    timeline.unmount()
    sheet.unmount()
    expect(useMemoryStore.getState().threads).toEqual({})
    expect(useMemoryStore.getState().timeline).toEqual({})
  })

  it('F-16.22: sends Knew before, Split and Not a secret, adding their Dismissed rows', async () => {
    expect(await useMemoryStore.getState().knewBefore('s-map', 'r-mara', true)).toBe(true)
    expect(main.sent('memory:knewBefore')).toEqual([
      { secretId: 's-map', recordId: 'r-mara', knew: true }
    ])
    expect(await useMemoryStore.getState().splitTopic('tq-1')).toBe('s-new')
    expect(await useMemoryStore.getState().topicNotRight('s-new')).toBe(true)
    expect(useDismissedStore.getState().items.map((row) => row.id)).toEqual(['d-gone', 'd-split'])
  })
})
