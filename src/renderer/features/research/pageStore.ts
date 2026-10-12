import type { RecoveryKind } from '@shared/recovery'
import { EMPTY_DOC, type TiptapNodeT } from '@shared/tiptap'
import { useGoalsStore } from '@renderer/features/goals/goalsStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { ipc } from '@renderer/lib/ipc'
import { createAutosaveStore, type LoadedRecord } from '@renderer/features/editor/autosaveStore'

/**
 * The pages of story memory v2 (F-16.6, F-16.8; plan P1 §2.3): the one owner of every loaded
 * page and its autosave, keyed by its owner. A Research document is a node, read and written
 * through `document:get`/`document:save` (so its word count, `modified` and the crash-recovery
 * journal behave as any document's); a record's Pinned and Ideas pages (slice 3's sheets) go
 * through `record:get`/`record:savePage` and are journalled under their own recovery kinds. One autosave instance, so a page and the manuscript
 * document beside it save independently and a failure in one never blocks the other.
 */

/** Whose page: a Research document by node id, or a record's Pinned or Ideas page. */
export type PageOwner =
  { kind: 'research'; id: string } | { kind: 'pinned'; id: string } | { kind: 'ideas'; id: string }

const KINDS = ['research', 'pinned', 'ideas'] as const

/** The store key of a page: `<kind>:<id>`. */
export function pageKey(owner: PageOwner): string {
  return `${owner.kind}:${owner.id}`
}

/** The owner behind a store key; null for a key this store never made. */
export function pageOwnerOf(key: string): PageOwner | null {
  const at = key.indexOf(':')
  if (at <= 0) return null
  const kind = key.slice(0, at)
  const id = key.slice(at + 1)
  if (id === '') return null
  for (const known of KINDS) if (known === kind) return { kind: known, id }
  return null
}

const ownerOf = (key: string): PageOwner => {
  const owner = pageOwnerOf(key)
  if (owner === null) throw new Error(`Not a page key: ${key}`)
  return owner
}

/** Where a page's unsaved typing is journalled (F-8.3): its kind and id there. */
const journalEntryOf = (owner: PageOwner): { kind: RecoveryKind; id: string } => ({
  kind: owner.kind === 'research' ? 'document' : owner.kind,
  id: owner.id
})

/** One loaded page. */
export type LoadedPage = LoadedRecord<TiptapNodeT>

/** What a page save answers: a Research document's new word count, or none for a record page. */
type PageSaved = { wordCount: number } | null

const pageStore = createAutosaveStore<TiptapNodeT, PageSaved>({
  empty: EMPTY_DOC,
  get: async (key) => {
    const owner = ownerOf(key)
    if (owner.kind === 'research') {
      return (await ipc().invoke('document:get', { id: owner.id })).content
    }
    const record = await ipc().invoke('record:get', { id: owner.id })
    return owner.kind === 'pinned' ? record.pinned : record.ideas
  },
  save: async (key, content) => {
    const owner = ownerOf(key)
    if (owner.kind === 'research') {
      const { wordCount } = await ipc().invoke('document:save', { id: owner.id, content })
      return { wordCount }
    }
    await ipc().invoke('record:savePage', { id: owner.id, page: owner.kind, doc: content })
    return null
  },
  onSaved: (key, saved) => {
    const owner = pageOwnerOf(key)
    if (owner?.kind !== 'research' || saved === null) return
    useTreeStore.getState().setWordCount(owner.id, saved.wordCount)
    useGoalsStore.getState().refreshSoon()
  },
  // F-8.3: a Research page is a document, so its unsaved typing is journalled as one; a record's
  // Pinned and Ideas under their own kinds, by record id, so a crash loses no page's words.
  journal: {
    stash: (key, content) => {
      const owner = ownerOf(key)
      return ipc().invoke('recovery:stash', { ...journalEntryOf(owner), content })
    },
    clear: (key) => ipc().invoke('recovery:clear', journalEntryOf(ownerOf(key)))
  }
})

export const usePageStore = pageStore.useStore

/**
 * Reads the open Research pages among `nodeIds` again after main rewrote them (Replace in
 * project, crash recovery), as the document store does for scenes; ids with no open page are
 * ignored.
 */
export function reloadResearchPages(nodeIds: readonly string[]): Promise<void> {
  return usePageStore.getState().reload(nodeIds.map((id) => pageKey({ kind: 'research', id })))
}

/** Drops the pending jobs, timers, in-flight write, load tokens, and registration, then empties the store. For tests only. */
export const resetPageStore = pageStore.reset
