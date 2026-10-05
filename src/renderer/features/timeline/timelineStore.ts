import { create } from 'zustand'
import {
  TIMELINE_EVENTS_MAX,
  addEvent,
  moveEvent,
  removeEvent,
  timelineProblem,
  updateEvent,
  type TimelineEvent
} from '@shared/timeline'
import { useSceneMetaStore } from '@renderer/features/editor/sceneMetaStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/**
 * The one owner of the project's timeline events (F-11.2), in story order. Loaded on project
 * open and cleared on close (`App.tsx`). Every change applies at once and writes at once: the
 * pending scene metadata is flushed first (so an edit typed into a pane is on disk before main
 * rewrites the linked scenes), then `timeline:set` stores the list and syncs the scenes, then the
 * scenes main rewrote are reloaded into `useSceneMetaStore`, so open panes show the new text and
 * no later autosave writes the old text back. A refused change (a duplicate label, checked here
 * first) or a failed write reverts to the previous list and toasts. Generation-guarded, so a
 * response for a closed project is dropped.
 */
interface TimelineState {
  events: readonly TimelineEvent[]
  /** False until `load` resolves; the Timeline tab and the picker wait for it. */
  loaded: boolean
  load: () => Promise<void>
  /** Stores `next`; true when it was stored (or nothing changed), false when refused or failed. */
  save: (next: readonly TimelineEvent[]) => Promise<boolean>
  add: (event: TimelineEvent) => Promise<boolean>
  update: (id: string, patch: Partial<Omit<TimelineEvent, 'id'>>) => Promise<boolean>
  remove: (id: string) => Promise<boolean>
  move: (from: number, to: number) => Promise<boolean>
  clear: () => void
}

/** Bumped by every load() and clear() so a response from a superseded request is dropped. */
let generation = 0
/** Bumped by every write, so only the latest write's answer (or revert) lands. */
let writes = 0

export const useTimelineStore = create<TimelineState>((set, get) => ({
  events: [],
  loaded: false,

  async load() {
    const mine = ++generation
    const value = await ipc().invoke('timeline:get', undefined)
    if (mine !== generation) return
    set({ events: value.events, loaded: true })
  },

  async save(next) {
    const previous = get().events
    if (!get().loaded || next === previous) return true
    const problem = timelineProblem(next)
    if (problem !== null) {
      toast.error(problem)
      return false
    }
    const mine = generation
    const write = ++writes
    set({ events: next })
    try {
      const metas = useSceneMetaStore.getState()
      await metas.flush()
      const result = await ipc().invoke('timeline:set', { events: [...next] })
      if (mine !== generation) return false
      if (write === writes) set({ events: result.timeline.events })
      await metas.reload(result.changedNodeIds)
      return true
    } catch (err) {
      if (mine !== generation) return false // the project closed meanwhile; nothing to revert
      if (write === writes) set({ events: previous })
      toast.error(describeError(err))
      return false
    }
  },

  async add(event) {
    const previous = get().events
    const next = addEvent(previous, event)
    if (next === previous) {
      toast.warning(`The timeline holds at most ${TIMELINE_EVENTS_MAX} events.`)
      return false
    }
    return get().save(next)
  },

  update(id, patch) {
    return get().save(updateEvent(get().events, id, patch))
  },

  remove(id) {
    return get().save(removeEvent(get().events, id))
  },

  move(from, to) {
    return get().save(moveEvent(get().events, from, to))
  },

  clear() {
    generation++
    writes++
    set({ events: [], loaded: false })
  }
}))

/** Empties the store and drops any response in flight. For tests only. */
export function resetTimelineStore(): void {
  useTimelineStore.getState().clear()
}
