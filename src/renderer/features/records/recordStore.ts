import { create } from 'zustand'
import type { RecordAliasInput, StoryRecordSummary } from '@shared/memory/records'
import type { TwinGateResult } from '@shared/memory/twinGate'
import { useEditPassViewStore } from '@renderer/features/editPass/editPassViewStore'
import { ipc, IpcRequestError } from '@renderer/lib/ipc'

/**
 * Records in the renderer (F-16.4, F-16.6; story memory v2): the one owner of every record's
 * summary (its names, category, image), the record open in the main pane, and the category the
 * creation dialog is open for. The pages (Pinned, Ideas) are the page store's. Loaded on a v2
 * open; every action merges what main answers, and `record:changed` refetches only the records it
 * names (made, renamed, merged, split, deleted, a page saved), never the whole list.
 */

/** The names a record is saved with by `setAliases`: its own and the others, in order. */
export interface AliasesInput {
  name: { text: string; caseRule?: RecordAliasInput['caseRule']; shared?: boolean }
  aliases: RecordAliasInput[]
}

/** What `create` answers: the record, or the twin gate's warning when it was not forced. */
export type CreateRecordResult =
  { record: StoryRecordSummary } | { gate: Extract<TwinGateResult, { outcome: 'blocked' }> }

interface RecordState {
  byId: Record<string, StoryRecordSummary>
  /** Every record id by name, then id (as `record:list` sorts). */
  ids: string[]
  loaded: boolean
  /** The record whose sheet the main pane shows; picking a document clears it (`treeStore.select`). */
  selectedId: string | null
  /** The category the creation dialog is open for, or null while it is closed. */
  creating: string | null
  load: () => Promise<void>
  clear: () => void
  /** Opens the one `record:changed` subscription (idempotent); call it where a v2 project opens. */
  subscribe: () => void
  /** Reads these records again: a gone one leaves the store (and the pane). */
  refetch: (ids: readonly string[]) => Promise<void>
  /** The twin gate for a name being typed (`exceptId`: the record being renamed). */
  gate: (name: string, exceptId?: string) => Promise<TwinGateResult>
  /** Creates a record; a blocked name answers the gate's warning and writes nothing unless `force`. */
  create: (input: {
    name: string
    categoryId: string
    aliases?: RecordAliasInput[]
    force?: boolean
  }) => Promise<CreateRecordResult>
  /** Moves a record to another category, or chooses (`choose`) or removes its image. */
  update: (
    id: string,
    patch: { categoryId?: string; image?: 'choose' | 'remove' }
  ) => Promise<StoryRecordSummary>
  /** Replaces a record's names (its own and the others). */
  setAliases: (id: string, input: AliasesInput) => Promise<StoryRecordSummary>
  /** Deletes a record with its names and mentions. */
  remove: (id: string) => Promise<void>
  /** *Same as…*: `mergeId` joins `keepId`, whose sheet stays open. */
  sameAs: (keepId: string, mergeId: string) => Promise<StoryRecordSummary>
  /** *Split*: these nicknames move to a new record (`intoId` null) or another one. */
  split: (
    id: string,
    aliasIds: string[],
    intoId: string | null
  ) => Promise<{ from: StoryRecordSummary; into: StoryRecordSummary }>
  select: (id: string | null) => void
  startCreate: (categoryId: string) => void
  cancelCreate: () => void
}

/** A record as the store keeps it: everything but its pages. */
export function summaryOf(record: StoryRecordSummary): StoryRecordSummary {
  return {
    id: record.id,
    categoryId: record.categoryId,
    kind: record.kind,
    name: record.name,
    image: record.image,
    origin: record.origin,
    aliases: record.aliases,
    created: record.created,
    modified: record.modified
  }
}

const orderedIds = (byId: Record<string, StoryRecordSummary>): string[] =>
  Object.values(byId)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((record) => record.id)

/** Bumped by `clear`, so an answer for a project that closed is dropped. */
let generation = 0
let unsubscribe: (() => void) | null = null

export const useRecordStore = create<RecordState>((set, get) => {
  const merge = (records: readonly StoryRecordSummary[], gone: readonly string[] = []): void => {
    const byId = { ...get().byId }
    for (const id of gone) delete byId[id]
    for (const record of records) byId[record.id] = summaryOf(record)
    const selectedId = get().selectedId
    set({
      byId,
      ids: orderedIds(byId),
      selectedId: selectedId !== null && byId[selectedId] === undefined ? null : selectedId
    })
  }

  return {
    byId: {},
    ids: [],
    loaded: false,
    selectedId: null,
    creating: null,

    async load() {
      const mine = generation
      const records = await ipc().invoke('record:list', undefined)
      if (mine !== generation) return
      const byId: Record<string, StoryRecordSummary> = {}
      for (const record of records) byId[record.id] = summaryOf(record)
      set({ byId, ids: orderedIds(byId), loaded: true })
    },

    clear() {
      generation++
      set({ byId: {}, ids: [], loaded: false, selectedId: null, creating: null })
    },

    subscribe() {
      unsubscribe ??= ipc().on('record:changed', ({ recordIds }) => {
        void get().refetch(recordIds)
      })
    },

    async refetch(ids) {
      const mine = generation
      const found: StoryRecordSummary[] = []
      const gone: string[] = []
      for (const id of ids) {
        try {
          found.push(await ipc().invoke('record:get', { id }))
        } catch (err) {
          // A record merged away or deleted elsewhere answers NOT_FOUND: it leaves the store.
          if (err instanceof IpcRequestError && err.code === 'NOT_FOUND') gone.push(id)
          else throw err
        }
      }
      if (mine !== generation) return
      merge(found, gone)
    },

    gate(name, exceptId) {
      return ipc().invoke('record:gate', exceptId === undefined ? { name } : { name, exceptId })
    },

    async create(input) {
      const mine = generation
      const made = await ipc().invoke('record:create', {
        name: input.name,
        categoryId: input.categoryId,
        aliases: input.aliases ?? [],
        force: input.force ?? false
      })
      if ('gate' in made) return made
      if (mine === generation) merge([made.record])
      return { record: summaryOf(made.record) }
    },

    async update(id, patch) {
      const mine = generation
      const updated = await ipc().invoke('record:update', { id, ...patch })
      if (mine === generation) merge([updated])
      return summaryOf(updated)
    },

    async setAliases(id, input) {
      const mine = generation
      const updated = await ipc().invoke('record:setAliases', { id, ...input })
      if (mine === generation) merge([updated])
      return summaryOf(updated)
    },

    async remove(id) {
      const mine = generation
      await ipc().invoke('record:delete', { id })
      if (mine === generation) merge([], [id])
    },

    async sameAs(keepId, mergeId) {
      const mine = generation
      const kept = await ipc().invoke('record:sameAs', { keepId, mergeId })
      if (mine === generation) merge([kept], [mergeId])
      return summaryOf(kept)
    },

    async split(id, aliasIds, intoId) {
      const mine = generation
      const { from, into } = await ipc().invoke('record:split', { id, aliasIds, intoId })
      if (mine === generation) merge([from, into])
      return { from: summaryOf(from), into: summaryOf(into) }
    },

    select(id) {
      // An open sheet takes the main pane back from the Edits workspace or a report.
      if (id !== null) useEditPassViewStore.getState().close()
      if (get().selectedId !== id) set({ selectedId: id })
    },

    startCreate(categoryId) {
      set({ creating: categoryId })
    },

    cancelCreate() {
      set({ creating: null })
    }
  }
})

/** The records of one category, by name. */
export function recordsIn(
  state: Pick<RecordState, 'byId' | 'ids'>,
  categoryId: string
): StoryRecordSummary[] {
  return state.ids.flatMap((id) => {
    const record = state.byId[id]
    return record?.categoryId === categoryId ? [record] : []
  })
}

/** Closes the subscription and empties the store. For tests and project close. */
export function resetRecordStore(): void {
  unsubscribe?.()
  unsubscribe = null
  useRecordStore.getState().clear()
}
