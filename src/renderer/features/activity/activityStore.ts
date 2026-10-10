import { create } from 'zustand'
import { useContinuityStore } from '@renderer/features/ai/continuityStore'
import { useIndexingStore } from '@renderer/features/ai/indexingStore'
import { useEditPassStore } from '@renderer/features/editPass/editPassStore'
import { useEditPassViewStore } from '@renderer/features/editPass/editPassViewStore'
import { useFocusStore } from '@renderer/features/focus/focusStore'
import { useConversionStore } from '@renderer/features/knowledge/conversionStore'
import { useLibraryStore } from '@renderer/features/library/libraryStore'
import { useOrganiseStore } from '@renderer/features/organise/organiseStore'
import { useTodoStore } from '@renderer/features/todo/todoStore'
import {
  noteStale,
  outcomeOf,
  readJobs,
  type ActivityJob,
  type ActivityNote,
  type ActivitySnapshot,
  type JobTiming
} from './activityJobs'

/**
 * The background activity in the renderer (F-7.12). The job stores own every fact (Organise's
 * phase, the upload's flow and progress, the edit passes, the To do check, the consistency check,
 * the conversion's re-read); `startActivityWatch` derives the running jobs from them on every
 * change (`readJobs`) and keeps here only what none of them holds: when each job was first seen
 * and last moved (for the crawl), the jobs that just ended (the bar fills and fades), and the
 * drop notifications with their focus-mode parking. `jobs` is the watch's last reading, written
 * nowhere else.
 */

/** A job that just ended: the bar shows it full, then fades. */
export interface FinishingJob {
  key: string
  name: string
}

interface ActivityState {
  jobs: ActivityJob[]
  timing: Record<string, JobTiming>
  finishing: FinishingJob[]
  notes: ActivityNote[]
  /** × on a notification. */
  dismiss: (id: string) => void
  clear: () => void
}

/** How long a finished job stays full on the bar before it leaves (the fade is in the bar). */
export const FINISH_MS = 900
/** How long a notification shows in focus mode before it hides until focus mode ends. */
export const FOCUS_NOTE_MS = 6000

let counter = 0
const nextNoteId = (): string => `act-${++counter}`
const timers = new Set<ReturnType<typeof setTimeout>>()

function later(ms: number, run: () => void): void {
  const timer = setTimeout(() => {
    timers.delete(timer)
    run()
  }, ms)
  timers.add(timer)
}

export const useActivityStore = create<ActivityState>((set) => ({
  jobs: [],
  timing: {},
  finishing: [],
  notes: [],

  dismiss(id) {
    set((s) => ({ notes: s.notes.filter((note) => note.id !== id) }))
  },

  clear() {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    set({ jobs: [], timing: {}, finishing: [], notes: [] })
  }
}))

/** What the job stores hold now, as the activity reads it. */
export function readSnapshot(): ActivitySnapshot {
  const organise = useOrganiseStore.getState()
  const library = useLibraryStore.getState()
  const passes = useEditPassStore.getState()
  const todo = useTodoStore.getState()
  const continuity = useContinuityStore.getState()
  return {
    organise: {
      open: organise.open,
      shown: organise.shown,
      phase: organise.phase,
      requestId: organise.requestId,
      request: organise.request,
      error: organise.error,
      changes: organise.order.length
    },
    upload: { flow: library.flow, shown: library.shown },
    editPasses: { byId: passes.byId, ids: passes.ids },
    editView: useEditPassViewStore.getState().view,
    todo: { checking: todo.checking, checkResult: todo.checkResult },
    continuity: {
      running: continuity.running,
      outcome: continuity.outcome,
      error: continuity.error,
      viewOpen: continuity.viewOpen
    },
    conversion: { rereading: useConversionStore.getState().rereading },
    queue: useIndexingStore.getState().status
  }
}

const sameJobs = (a: readonly ActivityJob[], b: readonly ActivityJob[]): boolean =>
  a.length === b.length &&
  a.every((job, i) => {
    const other = b[i]
    return (
      other?.key === job.key &&
      job.steps?.done === other.steps?.done &&
      job.steps?.total === other.steps?.total
    )
  })

/** Hides a notification shown in focus mode once its few seconds are up (still in focus mode). */
function parkLater(id: string): void {
  later(FOCUS_NOTE_MS, () => {
    if (!useFocusStore.getState().active) return
    useActivityStore.setState((s) => ({
      notes: s.notes.map((note) => (note.id === id ? { ...note, parked: true } : note))
    }))
  })
}

/**
 * One reading of the job stores: new jobs are timed, moved ones re-timed, ended ones put on the
 * bar's finish and turned into a notification (`outcomeOf`), and notifications whose result
 * already shows or is gone are dropped (`noteStale`). A job starting again clears its kind's
 * earlier notifications. Exported for tests; the watch runs it on every change.
 */
export function syncActivity(now = Date.now()): void {
  const snap = readSnapshot()
  const jobs = readJobs(snap)
  const state = useActivityStore.getState()
  const before = new Map(state.jobs.map((job) => [job.key, job]))
  const keys = new Set(jobs.map((job) => job.key))

  const timing: Record<string, JobTiming> = {}
  for (const job of jobs) {
    const was = state.timing[job.key]
    const done = job.steps?.done ?? 0
    timing[job.key] =
      was === undefined
        ? { startedAt: now, stepAt: now, done }
        : was.done === done
          ? was
          : { ...was, stepAt: now, done }
  }

  const started = jobs.filter((job) => !before.has(job.key))
  const ended = state.jobs.filter((job) => !keys.has(job.key))
  const focus = useFocusStore.getState().active

  let notes = state.notes.filter(
    (note) => !started.some((job) => job.kind === note.kind && job.ref === note.ref)
  )
  const added: string[] = []
  for (const job of ended) {
    const draft = outcomeOf(job, snap)
    if (draft === null) continue
    const id = nextNoteId()
    // A newer word on the same job replaces the older one.
    notes = notes.filter((note) => !(note.kind === draft.kind && note.ref === draft.ref))
    notes.push({ ...draft, id, parked: false })
    added.push(id)
  }
  notes = notes.filter((note) => !noteStale(note, snap))

  const finishing = [...state.finishing, ...ended.map((job) => ({ key: job.key, name: job.name }))]
  const changed =
    !sameJobs(state.jobs, jobs) ||
    ended.length > 0 ||
    notes.length !== state.notes.length ||
    notes.some((note, i) => note !== state.notes[i])
  if (!changed) return
  useActivityStore.setState({ jobs, timing, finishing, notes })
  for (const job of ended) {
    later(FINISH_MS, () =>
      useActivityStore.setState((s) => ({
        finishing: s.finishing.filter((each) => each.key !== job.key)
      }))
    )
  }
  if (focus) {
    for (const id of added) {
      if (notes.some((note) => note.id === id)) parkLater(id)
    }
  }
}

/** Focus mode began: what shows hides now; it ended: everything hidden drops down again. */
function onFocusChange(active: boolean): void {
  useActivityStore.setState((s) => ({
    notes: s.notes.map((note) => (note.parked === active ? note : { ...note, parked: active }))
  }))
}

/**
 * Starts watching the job stores and focus mode; returns the stop, which also empties the store
 * (the project closed). Mounted once with the project screen.
 */
export function startActivityWatch(): () => void {
  const sync = (): void => syncActivity()
  const stops = [
    useOrganiseStore.subscribe(sync),
    useLibraryStore.subscribe(sync),
    useEditPassStore.subscribe(sync),
    useEditPassViewStore.subscribe(sync),
    useTodoStore.subscribe(sync),
    useContinuityStore.subscribe(sync),
    useConversionStore.subscribe(sync),
    useIndexingStore.subscribe(sync),
    useFocusStore.subscribe((state, prev) => {
      if (state.active !== prev.active) onFocusChange(state.active)
    })
  ]
  sync()
  return () => {
    for (const stop of stops) stop()
    useActivityStore.getState().clear()
  }
}

/** Empties the store and cancels its timers. For tests. */
export function resetActivityStore(): void {
  useActivityStore.getState().clear()
}
