import { create } from 'zustand'
import {
  CHANGES_PAGE,
  type ChangeEntry,
  type RecordChangesInput,
  type RecordedChange,
  type RecordedChangeSource
} from '@shared/changes'
import type { ChangeUndoReply } from '@shared/ipc/contract'
import { useNotesStore } from '@renderer/features/editor/notesStore'
import { useEntityDraftStore } from '@renderer/features/entities/entityDraftStore'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { useLibraryStore } from '@renderer/features/library/libraryStore'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { ipc } from '@renderer/lib/ipc'

/**
 * The Changes section (F-9.13): the renderer owner of the log of what the background reading
 * applied on its own, newest first, a page at a time. Main's `changes:changed` re-reads the pages
 * held. An undo merges the rows main marked undone, and drops the sheets and tags it deleted from
 * their stores (the other moves arrive as `fact:changed` and `documentTag:changed`).
 *
 * F-9.15: the one Undo of every story-bible change, whoever made it. Organise and the chat log
 * what they applied (`record`) and their own Undo buttons call `undo` here. An open sheet page
 * is saved before an undo and shows the sheet as put back after it, so its draft never writes
 * the undone text again.
 */
interface ChangesState {
  entries: ChangeEntry[]
  /** Whether older rows exist past the last page held. */
  more: boolean
  /** The ids of the rows and runs being undone, for the buttons. */
  pending: string[]
  /** Reads the newest page again, as many rows as are held (at least one page). */
  load: () => Promise<void>
  /** Reads the next older page. */
  loadMore: () => Promise<void>
  undo: (id: string) => Promise<void>
  undoRun: (runId: string) => Promise<void>
  /** F-9.15: logs changes applied through the stores; answers the rows (newest first in the list). */
  record: (input: RecordChangesInput) => Promise<ChangeEntry[]>
  clear: () => void
  /** Opens the one `changes:changed` subscription (idempotent); call it where the project opens. */
  subscribe: () => void
}

/** Bumped by every clear() so an answer for a closed project is dropped. */
let generation = 0
let latest = 0
let unsubscribe: (() => void) | null = null

export const useChangesStore = create<ChangesState>((set, get) => {
  const applyUndo = (result: ChangeUndoReply): void => {
    const undone = new Map(result.entries.map((entry) => [entry.id, entry]))
    set({ entries: get().entries.map((entry) => undone.get(entry.id) ?? entry) })
    const entities = useEntityStore.getState()
    // F-9.15: what was put back; an open page starts again from the sheet as it now stands.
    for (const entity of result.entities) entities.merge(entity)
    for (const tag of result.tags) useTagStore.getState().merge(tag)
    const draft = useEntityDraftStore.getState()
    const reopened = result.entities.find((entity) => entity.id === draft.draft?.id)
    if (reopened !== undefined) draft.open(reopened)
    forgetRecords(result.removedEntityIds, result.removedTagIds)
    // F-5.25: a clear's Undo also put back uploads and notes, which no event reports.
    if (result.entries.some((entry) => entry.kind === 'clear')) refreshLibraryAndNotes()
  }
  const track = async (key: string, task: () => Promise<ChangeUndoReply>): Promise<void> => {
    const mine = generation
    set({ pending: [...get().pending, key] })
    try {
      // The open page's typing is saved first, so the undo compares against what is on screen.
      await useEntityDraftStore.getState().flush()
      const result = await task()
      if (mine === generation) applyUndo(result)
    } finally {
      if (mine === generation) set({ pending: get().pending.filter((each) => each !== key) })
    }
  }

  return {
    entries: [],
    more: false,
    pending: [],

    async load() {
      const mine = generation
      const request = ++latest
      const limit = Math.max(CHANGES_PAGE, get().entries.length)
      const page = await ipc().invoke('changes:list', { limit })
      if (mine !== generation || request !== latest) return
      set({ entries: page.entries, more: page.more })
    },

    async loadMore() {
      const mine = generation
      const last = get().entries.at(-1)
      if (last === undefined) return
      const page = await ipc().invoke('changes:list', { before: last.id, limit: CHANGES_PAGE })
      if (mine !== generation) return
      const held = new Set(get().entries.map((entry) => entry.id))
      set({
        entries: [...get().entries, ...page.entries.filter((entry) => !held.has(entry.id))],
        more: page.more
      })
    },

    undo: (id) => track(id, () => ipc().invoke('changes:undo', { id })),

    undoRun: (runId) => track(runId, () => ipc().invoke('changes:undoRun', { runId })),

    async record(input) {
      const mine = generation
      const logged = await ipc().invoke('changes:record', input)
      if (mine === generation) {
        const held = new Set(logged.map((entry) => entry.id))
        set({
          entries: [...[...logged].reverse(), ...get().entries.filter((e) => !held.has(e.id))]
        })
      }
      return logged
    },

    clear() {
      generation++
      set({ entries: [], more: false, pending: [] })
    },

    subscribe() {
      unsubscribe ??= ipc().on('changes:changed', () => {
        // A failed re-read keeps the list as it was; the next event reads again.
        get()
          .load()
          .catch(() => undefined)
      })
    }
  }
})

/**
 * Drops sheets and tags main deleted from their stores; a sheet whose tag went keeps no tag, as
 * main cleared it (F-9.4: the sheet outlives its tag). Used by an undo and by a clear (F-5.25).
 */
export function forgetRecords(entityIds: readonly string[], tagIds: readonly string[]): void {
  const entities = useEntityStore.getState()
  entities.forget(entityIds)
  const tags = new Set(tagIds)
  for (const id of useEntityStore.getState().ids) {
    const entity = useEntityStore.getState().byId[id]
    if (entity?.tagId != null && tags.has(entity.tagId)) {
      useEntityStore.getState().merge({ ...entity, tagId: null })
    }
  }
  useTagStore.getState().forget(tagIds)
}

/** F-5.25: reads the Library and the held notes again after a clear or its Undo. */
export function refreshLibraryAndNotes(): void {
  void useLibraryStore
    .getState()
    .load()
    .catch(() => undefined)
  const held = Object.keys(useNotesStore.getState().docs)
  if (held.length > 0) {
    void useNotesStore
      .getState()
      .reload(held)
      .catch(() => undefined)
  }
}

/** Where a store's applied change is logged: the source and the run (an Organise plan, a chat turn). */
export interface ChangeRun {
  source: RecordedChangeSource
  run: string
}

/**
 * Logs one change a store applied (F-9.15) and answers its Undo, which is the Changes log's: the
 * caller's own Undo button calls it, so there is one owner. Null for a change the log cannot
 * take back (a merge, a deletion). If the log refuses the entry (the project closed, the record
 * moved on meanwhile), the change stays applied and `fallback` is its Undo, as before F-9.15.
 */
export async function logAppliedChange(
  run: ChangeRun,
  change: RecordedChange,
  fallback: (() => Promise<void>) | null
): Promise<(() => Promise<void>) | null> {
  let entry: ChangeEntry | undefined
  try {
    ;[entry] = await useChangesStore.getState().record({ ...run, changes: [change] })
  } catch {
    // The change itself landed; only its line in the log is missing, so its own undo stays.
    return fallback
  }
  if (entry === undefined) return fallback
  if (!entry.undoable) return null
  const id = entry.id
  return () => useChangesStore.getState().undo(id)
}

/**
 * F-5.25: `logAppliedChange` for a bulk edit, many rows under one run (in pages of 100, the log's
 * cap per call); the Undo takes them back newest first. If the log refuses, `fallback` is the Undo.
 */
export async function logAppliedChanges(
  run: ChangeRun,
  changes: readonly RecordedChange[],
  fallback: (() => Promise<void>) | null
): Promise<(() => Promise<void>) | null> {
  const ids: string[] = []
  try {
    for (let at = 0; at < changes.length; at += RECORD_PAGE) {
      const logged = await useChangesStore
        .getState()
        .record({ ...run, changes: changes.slice(at, at + RECORD_PAGE) })
      for (const entry of logged) if (entry.undoable) ids.push(entry.id)
    }
  } catch {
    return ids.length === 0 ? fallback : undoAll(ids)
  }
  return ids.length === 0 ? null : undoAll(ids)
}

/** The most rows one `changes:record` call takes (`RecordChangesInput`). */
const RECORD_PAGE = 100

const undoAll = (ids: readonly string[]) => async (): Promise<void> => {
  for (const id of [...ids].reverse()) await useChangesStore.getState().undo(id)
}

/** Empties the store and drops the subscription. For tests only. */
export function resetChangesStore(): void {
  unsubscribe?.()
  unsubscribe = null
  useChangesStore.getState().clear()
}
