import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditPassSummary } from '@shared/editPass'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { IDLE_INDEX_QUEUE } from '@shared/jobs'
import { resetAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { resetContinuityStore, useContinuityStore } from '@renderer/features/ai/continuityStore'
import { resetIndexingStore, useIndexingStore } from '@renderer/features/ai/indexingStore'
import { resetEditPassStore, useEditPassStore } from '@renderer/features/editPass/editPassStore'
import {
  resetEditPassViewStore,
  useEditPassViewStore
} from '@renderer/features/editPass/editPassViewStore'
import { resetFocusStore, useFocusStore } from '@renderer/features/focus/focusStore'
import {
  resetConversionStore,
  useConversionStore
} from '@renderer/features/knowledge/conversionStore'
import { resetLibraryStore } from '@renderer/features/library/libraryStore'
import { resetOrganiseStore, useOrganiseStore } from '@renderer/features/organise/organiseStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { resetSideWorkPlace, useSideWorkPlaceStore } from '@renderer/features/sideWork/sideWork'
import { resetTodoStore, useTodoStore } from '@renderer/features/todo/todoStore'
import { setIpcClient } from '@renderer/lib/ipc'
import type { ActivityNote } from './activityJobs'
import { openNote, retryNote } from './activityRoutes'
import {
  FINISH_MS,
  FOCUS_NOTE_MS,
  resetActivityStore,
  startActivityWatch,
  useActivityStore
} from './activityStore'

let calls: [Channel, unknown][]
let stop: (() => void) | null = null

function pass(over: Partial<EditPassSummary> = {}): EditPassSummary {
  return {
    id: 'p1',
    type: 'line',
    instruction: null,
    status: 'running',
    nodeIds: ['a', 'b'],
    doneNodeIds: [],
    currentNodeId: 'a',
    model: 'm',
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    counts: { pending: 2, accepted: 0, rejected: 0, stale: 0 },
    dropped: 0,
    error: null,
    createdAt: '2026-10-10T10:00:00.000Z',
    finishedAt: null,
    ...over
  }
}

function resetAll(): void {
  resetActivityStore()
  resetOrganiseStore()
  resetLibraryStore()
  resetEditPassStore()
  resetEditPassViewStore()
  resetTodoStore()
  resetContinuityStore()
  resetConversionStore()
  resetIndexingStore()
  resetFocusStore()
  resetLayoutStore()
  resetSideWorkPlace()
  resetAiActivityStore()
}

beforeEach(() => {
  vi.useFakeTimers()
  calls = []
  setIpcClient({
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      switch (channel) {
        case 'window:setFullScreen':
          return { on: false } as Output<C>
        case 'jobs:resume':
          return { ...IDLE_INDEX_QUEUE, queued: 2 } as Output<C>
        case 'editPass:resume':
          return { ok: true, pass: pass() } as Output<C>
        default:
          return null as Output<C>
      }
    },
    on: () => () => {}
  })
  resetAll()
  stop = startActivityWatch()
})

afterEach(() => {
  stop?.()
  stop = null
  resetAll()
  vi.useRealTimers()
})

const notes = (): ActivityNote[] => useActivityStore.getState().notes
const firstNote = (): ActivityNote => {
  const note = notes()[0]
  if (note === undefined) throw new Error('no notification')
  return note
}
const shown = (): string[] =>
  notes()
    .filter((note) => !note.parked)
    .map((note) => note.title)

const runOrganise = (): void => {
  useOrganiseStore.setState({ open: true, phase: 'running', requestId: 'org-1' })
}
const finishOrganise = (): void => {
  useOrganiseStore.setState({ phase: 'ready', requestId: null })
}

describe('activity watch (F-7.12)', () => {
  it('times a job while it runs, fills the bar as it ends, then lets it go', () => {
    runOrganise()
    const { jobs, timing } = useActivityStore.getState()
    expect(jobs.map((job) => job.key)).toEqual(['organise:org-1'])
    expect(timing['organise:org-1']).toBeDefined()
    finishOrganise()
    expect(useActivityStore.getState().jobs).toEqual([])
    expect(useActivityStore.getState().finishing).toEqual([
      { key: 'organise:org-1', name: 'Organise' }
    ])
    expect(shown()).toEqual(['Organise is ready to review'])
    vi.advanceTimersByTime(FINISH_MS)
    expect(useActivityStore.getState().finishing).toEqual([])
    // Outside focus mode the notification stays until opened or dismissed.
    vi.advanceTimersByTime(60_000)
    expect(shown()).toEqual(['Organise is ready to review'])
    useActivityStore.getState().dismiss(notes()[0]?.id ?? '')
    expect(notes()).toEqual([])
  })

  it('re-times a job when its real steps move, and drops nothing on a cancel', () => {
    useEditPassStore.setState({ byId: { p1: pass() }, ids: ['p1'] })
    const first = useActivityStore.getState().timing['editPass:p1']
    vi.advanceTimersByTime(2000)
    useEditPassStore.setState({ byId: { p1: pass({ doneNodeIds: ['a'] }) } })
    const second = useActivityStore.getState().timing['editPass:p1']
    expect(second?.startedAt).toBe(first?.startedAt)
    expect(second?.stepAt).toBe((first?.stepAt ?? 0) + 2000)
    useEditPassStore.setState({ byId: { p1: pass({ status: 'cancelled' }) } })
    expect(notes()).toEqual([])
  })

  it('in focus mode shows a notification briefly, then brings it back for good when focus mode ends', () => {
    useFocusStore.setState({ active: true })
    runOrganise()
    finishOrganise()
    expect(shown()).toEqual(['Organise is ready to review'])
    vi.advanceTimersByTime(FOCUS_NOTE_MS)
    expect(shown()).toEqual([])
    expect(notes()).toHaveLength(1)
    useFocusStore.setState({ active: false })
    expect(shown()).toEqual(['Organise is ready to review'])
    vi.advanceTimersByTime(FOCUS_NOTE_MS * 3)
    expect(shown()).toEqual(['Organise is ready to review'])
  })

  it('hides what shows when focus mode begins', () => {
    runOrganise()
    finishOrganise()
    useFocusStore.setState({ active: true })
    expect(shown()).toEqual([])
    useFocusStore.setState({ active: false })
    expect(shown()).toEqual(['Organise is ready to review'])
  })

  it('drops the notification once the run is opened another way, or closed', () => {
    runOrganise()
    finishOrganise()
    useOrganiseStore.getState().show()
    expect(notes()).toEqual([])
    useOrganiseStore.getState().hide()
    runOrganise()
    finishOrganise()
    expect(notes()).toHaveLength(1)
    useOrganiseStore.getState().close()
    expect(notes()).toEqual([])
  })

  it('says a failure with its reason, and a new run of the job clears it', () => {
    runOrganise()
    useOrganiseStore.setState({
      phase: 'failed',
      requestId: null,
      error: 'Rate limited. Wait a minute.',
      request: { instruction: '', scope: [] }
    })
    expect(notes()).toMatchObject([
      {
        status: 'failed',
        title: 'Organise failed',
        detail: 'Rate limited. Wait a minute.',
        canRetry: true
      }
    ])
    useOrganiseStore.setState({ phase: 'running', requestId: 'org-2' })
    expect(notes()).toEqual([])
  })

  it('combines several jobs and says each when it ends', () => {
    runOrganise()
    useTodoStore.setState({ checking: true })
    expect(useActivityStore.getState().jobs.map((job) => job.name)).toEqual([
      'Organise',
      'Book check'
    ])
    useTodoStore.setState({
      checking: false,
      checkResult: { status: 'done', message: 'The check found nothing new.' }
    })
    expect(useActivityStore.getState().jobs.map((job) => job.name)).toEqual(['Organise'])
    expect(notes()).toMatchObject([
      { title: 'Book check finished', detail: 'The check found nothing new.' }
    ])
  })

  it('follows the conversion re-read until the queue settles', async () => {
    useIndexingStore.setState({ status: { ...IDLE_INDEX_QUEUE, queued: 3 } })
    useConversionStore.setState({ rereading: true })
    expect(useActivityStore.getState().jobs.map((job) => job.kind)).toEqual(['conversion'])
    await useConversionStore.getState().retryReread()
    expect(useConversionStore.getState().rereading).toBe(true)
    useIndexingStore.setState({ status: { ...IDLE_INDEX_QUEUE } })
    expect(useConversionStore.getState().rereading).toBe(false)
    expect(notes()).toMatchObject([{ title: 'Scene cards are up to date', canOpen: false }])
  })
})

describe('Open and Retry (F-7.12)', () => {
  it('opens Organise and the upload in the big review dialog, and the notification goes', async () => {
    runOrganise()
    finishOrganise()
    const note = firstNote()
    await openNote(note)
    expect(useSideWorkPlaceStore.getState().place).toBe('dialog')
    expect(useOrganiseStore.getState().shown).toBe(true)
    expect(notes()).toEqual([])
  })

  it('opens an edit pass’s report', async () => {
    useEditPassStore.setState({ byId: { p1: pass() }, ids: ['p1'] })
    useEditPassStore.setState({ byId: { p1: pass({ status: 'done' }) } })
    const note = firstNote()
    expect(note).toMatchObject({ title: 'Edit pass finished', detail: 'Line edit · 2 to review' })
    await openNote(note)
    expect(useEditPassViewStore.getState().view).toEqual({ kind: 'report', passId: 'p1' })
    expect(calls.some(([channel]) => channel === 'editPass:get')).toBe(true)
  })

  it('opens the To do list in the sidebar, and the findings view for a consistency check', async () => {
    useTodoStore.setState({ checking: true })
    useTodoStore.setState({ checking: false, checkResult: { status: 'done', message: 'x' } })
    await openNote(firstNote())
    expect(useLayoutStore.getState().layout.sidebar.tab).toBe('todo')
    expect(useLayoutStore.getState().layout.sidebar.open).toBe(true)

    useContinuityStore.setState({ running: { nodeId: 'a', requestId: 'c1' } })
    useContinuityStore.setState({
      running: null,
      outcome: {
        nodeId: 'a',
        found: 2,
        references: 3,
        truncated: false,
        dropped: 0,
        model: 'm',
        costUsd: 0,
        usage: { inputTokens: 1, outputTokens: 1 },
        cached: false
      }
    })
    const check = firstNote()
    expect(check).toMatchObject({ title: 'Consistency check finished', detail: '2 findings' })
    await openNote(check)
    expect(useContinuityStore.getState().viewOpen).toBe(true)
  })

  it('retries a stopped edit pass by resuming it', async () => {
    useEditPassStore.setState({ byId: { p1: pass() }, ids: ['p1'] })
    useEditPassStore.setState({ byId: { p1: pass({ status: 'failed', error: 'Quota.' }) } })
    const note = firstNote()
    expect(note).toMatchObject({ status: 'failed', canRetry: true })
    await retryNote(note)
    expect(calls.filter(([channel]) => channel === 'editPass:resume')).toEqual([
      ['editPass:resume', { id: 'p1' }]
    ])
  })
})
