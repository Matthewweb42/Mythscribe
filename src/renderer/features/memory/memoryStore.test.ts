import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Input } from '@shared/ipc/contract'
import type { Dismissed } from '@shared/memory/dismissed'
import { defaultAiSettings } from '@shared/aiSettings'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetDismissedStore, useDismissedStore } from '@renderer/features/thisScene/dismissedStore'
import { IpcRequestError, setIpcClient } from '@renderer/lib/ipc'
import {
  checkEstimateFixture,
  checkReportFixture,
  claimViewFixture,
  findingsViewFixture,
  findingViewFixture,
  installFakeMain,
  knowsGridFixture,
  looseEndFixture,
  looseEndsFixture,
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
    'memory:topicNotRight': () => ({ dismissed: [tombstone('d-gone', 'notRight')] }),
    'memory:findings': () =>
      findingsViewFixture({
        open: [findingViewFixture('f-1'), findingViewFixture('f-2', { slot: 'hair' })],
        unclear: [findingViewFixture('f-3', { state: 'unclear' })]
      }),
    'memory:looseEnds': () => looseEndsFixture({ items: [looseEndFixture()] }),
    'memory:checkReport': () => checkReportFixture(),
    'memory:checkEstimate': () => checkEstimateFixture(),
    'memory:checkBook': () => ({ ok: true, estimate: checkEstimateFixture() }),
    'memory:findingAction': (input) => {
      const action = input as Input<'memory:findingAction'>
      return {
        dismissed: tombstone(`d-${action.findingId}`, 'notRight'),
        other: action.action === 'right' ? { nodeId: 'sc-2', ref: '1.2' } : null
      }
    },
    'memory:looseEndAction': () => tombstone('d-loose', 'notRight'),
    'memory:answerNotice': () => [],
    'dismissed:undo': () => ({ restored: true })
  })
  useMemoryStore.getState().subscribe()
})
afterEach(() => {
  resetMemoryStore()
  resetDismissedStore()
  resetAiSettingsStore()
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

  it('F-16.23: reads the Threads and the Timeline again when the book’s order or a Pinned Born line moved', async () => {
    renderHook(() => useThreads(null))
    renderHook(() => useTimeline(null))
    renderHook(() => useSheetMemory('r-mara', null))
    await flush()
    main.calls.length = 0
    // Main says a scene was moved, renamed, made or deleted (or an Idea flipped): no record named.
    act(() => main.emit('memory:changed', { nodeIds: ['sc-2'], recordIds: [] }))
    await flush()
    expect(main.sent('memory:threads')).toEqual([{ asOf: null }])
    expect(main.sent('memory:timeline')).toEqual([{ recordId: null }])
    main.calls.length = 0
    // A Pinned "Born: 1792" saved on Mara's sheet: main names her and no scene.
    act(() => main.emit('memory:changed', { nodeIds: [], recordIds: ['r-mara'] }))
    await flush()
    expect(main.sent('memory:sheet')).toEqual([{ recordId: 'r-mara', asOf: null }])
    expect(main.sent('memory:timeline')).toEqual([{ recordId: null }])
  })

  it('F-16.23: reads a sheet’s Threads again when the name index moved (a nickname, Not a mention)', async () => {
    renderHook(() => useSheetMemory('r-harbour', null))
    renderHook(() => useSheetMemory('r-mara', null))
    await flush()
    main.calls.length = 0
    act(() => main.emit('names:changed', { nodeIds: ['sc-4'] }))
    await flush()
    // The harbour's Threads are matched by name; Mara's sheet has no Threads in this fixture.
    expect(main.sent('memory:sheet')).toEqual([{ recordId: 'r-harbour', asOf: null }])
  })

  it('F-16.23: keeps the Timeline’s Ages of choice until the project closes', () => {
    useMemoryStore.getState().setAgesOf('r-mara')
    expect(useMemoryStore.getState().agesOf).toBe('r-mara')
    useMemoryStore.getState().clear()
    expect(useMemoryStore.getState().agesOf).toBeNull()
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

describe('useMemoryStore: contradiction underlines (F-16.28)', () => {
  it('takes an answered finding’s underlines off every shown scene, and reads the shown scenes again when the findings move', async () => {
    const release = useMemoryStore.getState().watchScene('sc-2')
    await flush()
    const underline = {
      findingId: 'f-1',
      side: 'b' as const,
      para: 0,
      quote: "Mara's eyes were brown",
      finding: findingViewFixture('f-1')
    }
    const entry = useMemoryStore.getState().scenes['sc-2']
    if (entry === undefined) throw new Error('not loaded')
    useMemoryStore.setState({ scenes: { 'sc-2': { ...entry, underlines: [underline] } } })
    await useMemoryStore.getState().findingAction({ findingId: 'f-1', action: 'notProblem' })
    expect(useMemoryStore.getState().scenes['sc-2']?.underlines).toEqual([])
    main.calls.length = 0
    act(() => main.emit('memory:findingsChanged', { open: 1, unclear: 0, waiting: 0 }))
    await flush()
    expect(main.sent('memory:scene')).toEqual([{ nodeId: 'sc-2' }])
    release()
  })

  it('Panel only on the precision question sets Settings’ Show contradictions', async () => {
    useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 1 } })
    expect(await useMemoryStore.getState().answerNotice('underlinePrecision', 'panelOnly')).toBe(
      true
    )
    expect(main.sent('memory:answerNotice')).toEqual([
      { id: 'underlinePrecision', action: 'panelOnly' }
    ])
    expect(useAiSettingsStore.getState().settings?.reading.underlines).toBe('panel')
    // Keep underlines changes nothing.
    useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 1 } })
    await useMemoryStore.getState().answerNotice('underlinePrecision', 'keepUnderlines')
    expect(useAiSettingsStore.getState().settings?.reading.underlines).toBe('text')
  })
})

describe('useMemoryStore: findings, loose ends and Check the book (F-16.27, F-16.29, F-16.30)', () => {
  it('keeps the findings by id in main’s order, and reads them again only once loaded', async () => {
    act(() => main.emit('memory:changed', { nodeIds: ['sc-1'], recordIds: [] }))
    await flush()
    // Never loaded: a reading asks for none of it.
    expect(main.sent('memory:findings')).toEqual([])
    expect(main.sent('memory:looseEnds')).toEqual([])
    await act(async () => {
      await useMemoryStore.getState().loadFindings()
      await useMemoryStore.getState().loadLooseEnds()
    })
    const findings = useMemoryStore.getState().findings
    expect(findings?.open).toEqual(['f-1', 'f-2'])
    expect(findings?.unclear).toEqual(['f-3'])
    expect(findings?.byId['f-2']?.slot).toBe('hair')
    expect(useMemoryStore.getState().looseEnds?.items).toHaveLength(1)
    main.calls.length = 0
    act(() => main.emit('memory:changed', { nodeIds: ['sc-1'], recordIds: [] }))
    await flush()
    expect(main.sent('memory:findings')).toEqual([{ nodeId: null }])
    expect(main.sent('memory:looseEnds')).toHaveLength(1)
    main.calls.length = 0
    act(() => main.emit('names:changed', { nodeIds: ['sc-3'] }))
    await flush()
    expect(main.sent('memory:looseEnds')).toHaveLength(1)
    expect(main.sent('memory:findings')).toEqual([])
  })

  it('reads the findings, and a loaded report, again when main says the findings moved', async () => {
    act(() => main.emit('memory:findingsChanged', { open: 2, unclear: 1, waiting: 0 }))
    await flush()
    expect(main.sent('memory:findings')).toEqual([{ nodeId: null }])
    expect(main.sent('memory:checkReport')).toEqual([])
    await act(async () => {
      await useMemoryStore.getState().loadCheckReport()
    })
    expect(useMemoryStore.getState().check.report?.confirmed).toBe(1)
    main.calls.length = 0
    act(() => main.emit('memory:findingsChanged', { open: 1, unclear: 1, waiting: 0 }))
    await flush()
    expect(main.sent('memory:checkReport')).toHaveLength(1)
  })

  it('reads the report when a check ends, once', async () => {
    const running = memoryStatusFixture({
      check: {
        startedAt: 'a',
        finishedAt: null,
        judged: 0,
        toJudge: 2,
        confirmed: 0,
        toConfirm: 2,
        stopped: false,
        reason: null
      }
    })
    act(() => main.emit('memory:statusChanged', running))
    await flush()
    expect(main.sent('memory:checkReport')).toEqual([])
    const done = memoryStatusFixture({
      check: {
        startedAt: 'a',
        finishedAt: 'b',
        judged: 2,
        toJudge: 2,
        confirmed: 2,
        toConfirm: 2,
        stopped: false,
        reason: null
      }
    })
    act(() => main.emit('memory:statusChanged', done))
    await flush()
    act(() => main.emit('memory:statusChanged', done))
    await flush()
    expect(main.sent('memory:checkReport')).toHaveLength(1)
  })

  it('takes an answered finding away at once, adds its Dismissed row, and keeps This one’s right’s line', async () => {
    await act(async () => {
      await useMemoryStore.getState().loadFindings()
    })
    const answered = await useMemoryStore
      .getState()
      .findingAction({ findingId: 'f-1', action: 'notProblem' })
    expect(answered?.dismissed?.id).toBe('d-f-1')
    expect(useMemoryStore.getState().findings?.open).toEqual(['f-2'])
    expect(useDismissedStore.getState().items.map((row) => row.id)).toEqual(['d-f-1'])
    expect(useMemoryStore.getState().rightMarks).toEqual([])

    // This one's right on grey (side a): brown (1.2) is the side marked not right.
    await useMemoryStore.getState().findingAction({ findingId: 'f-2', action: 'right', side: 'a' })
    expect(useMemoryStore.getState().findings?.open).toEqual([])
    expect(useMemoryStore.getState().rightMarks).toEqual([
      {
        findingId: 'f-2',
        value: 'brown',
        ref: '1.2',
        nodeId: 'sc-2',
        quote: "Mara's eyes were brown",
        dismissedId: 'd-f-2'
      }
    ])
    // Undo deletes its Dismissed row and closes the line.
    expect(await useMemoryStore.getState().undoRightMark('f-2')).toBe(true)
    expect(main.sent('dismissed:undo')).toEqual([{ id: 'd-f-2' }])
    expect(useMemoryStore.getState().rightMarks).toEqual([])
  })

  it('drops This one’s right’s line when its Dismissed row is undone from the Dismissed dialog', async () => {
    await act(async () => {
      await useMemoryStore.getState().loadFindings()
    })
    await useMemoryStore.getState().findingAction({ findingId: 'f-2', action: 'right', side: 'a' })
    expect(useMemoryStore.getState().rightMarks.map((mark) => mark.dismissedId)).toEqual(['d-f-2'])
    // The dialog's Undo: the row goes, and the line with it.
    expect(await useDismissedStore.getState().undo('d-f-2')).toBe(true)
    expect(useMemoryStore.getState().rightMarks).toEqual([])
    // A stale line (its row gone some other way) closes on its own Undo with nothing sent again.
    useMemoryStore.setState({
      rightMarks: [
        {
          findingId: 'f-9',
          value: 'blue',
          ref: '1.3',
          nodeId: 'sc-3',
          quote: 'blue',
          dismissedId: 'd-gone'
        }
      ]
    })
    main.calls.length = 0
    expect(await useMemoryStore.getState().undoRightMark('f-9')).toBe(true)
    expect(main.sent('dismissed:undo')).toEqual([])
    expect(useMemoryStore.getState().rightMarks).toEqual([])
  })

  it('reads loose ends again when main refuses a Not a problem on one gone since', async () => {
    await act(async () => {
      await useMemoryStore.getState().loadLooseEnds()
    })
    installFakeMain({
      'memory:looseEndAction': () => {
        throw new IpcRequestError({
          code: 'NOT_FOUND',
          message: 'That loose end is no longer there'
        })
      },
      'memory:looseEnds': () => looseEndsFixture({ items: [] })
    })
    expect(await useMemoryStore.getState().looseEndNotProblem(looseEndFixture())).toBe(false)
    await flush()
    expect(useMemoryStore.getState().looseEnds?.items).toEqual([])
    expect(useDialogStore.getState().toasts.map((toast) => toast.message)).toEqual([
      'That loose end is no longer there'
    ])
  })

  it('takes a loose end away on Not a problem, and prices and starts a check', async () => {
    await act(async () => {
      await useMemoryStore.getState().loadLooseEnds()
    })
    expect(await useMemoryStore.getState().looseEndNotProblem(looseEndFixture())).toBe(true)
    expect(main.sent('memory:looseEndAction')).toEqual([
      { kind: 'planned', id: 'sc-plan', lastNodeId: null }
    ])
    expect(useMemoryStore.getState().looseEnds?.items).toEqual([])
    expect(useDismissedStore.getState().items.map((row) => row.id)).toEqual(['d-loose'])

    expect((await useMemoryStore.getState().estimateCheck())?.confirms.about).toBe(2)
    expect(useMemoryStore.getState().check.estimate?.aboutUsd).toBe(0.0004)
    expect(await useMemoryStore.getState().startCheck('sc-1')).toMatchObject({ ok: true })
    expect(main.sent('memory:checkBook')).toEqual([{ nodeId: 'sc-1' }])
  })

  it('empties it all on clear', async () => {
    await act(async () => {
      await useMemoryStore.getState().loadFindings()
      await useMemoryStore.getState().loadCheckReport()
    })
    useMemoryStore.getState().setCheckOpen('report')
    useMemoryStore.getState().clear()
    const state = useMemoryStore.getState()
    expect(state.findings).toBeNull()
    expect(state.looseEnds).toBeNull()
    expect(state.check).toEqual({ estimate: null, report: null })
    expect(state.checkOpen).toBeNull()
  })
})
