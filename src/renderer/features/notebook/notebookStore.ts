import { create } from 'zustand'
import { docToText } from '@shared/docText'
import type {
  NotebookImportResult,
  NotebookItem,
  NotebookKind,
  NotebookVersion
} from '@shared/notebook'
import { EMPTY_DOC, type TiptapNodeT } from '@shared/tiptap'
import { useEditPassViewStore } from '@renderer/features/editPass/editPassViewStore'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { useRecordStore } from '@renderer/features/records/recordStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { useNotebookPageStore } from './notebookPageStore'
import { useOpenNotebookPageStore } from './openPage'
import {
  buildNotebookIndex,
  isWithin,
  notebookTargetFolder,
  type NotebookIndex
} from './notebookIndex'

/**
 * The notebook in the renderer (notes redesign phase 1, slice 1): the one owner of the Notes
 * tree (every folder and page, without text), which row is selected, which page the main pane
 * shows, and Ms Scribe's latest edit on that page. Loaded when a project opens; every action
 * refetches `notebook:list` (a few hundred rows at most), and so does `notebook:changed`, which
 * main sends after any write, the author's or Ms Scribe's. The open page's text is the page
 * store's (`notebookPageStore`); when main changed it behind the editor (Ms Scribe), the editor
 * reloads it and the bar offers Show changes and Undo.
 */

/** Ms Scribe's latest edit on the open page: the version that holds the page as it was before it. */
export interface AiEdit {
  pageId: string
  versionId: string
  /** The page's text before her edit (the version's content). */
  before: TiptapNodeT | null
}

/** A dropped file for `importFiles`: its name, the folders it was dropped in, its bytes. */
export interface NotebookDroppedFile {
  name: string
  folders: string[]
  data: Uint8Array<ArrayBuffer>
}

interface NotebookState extends NotebookIndex {
  loaded: boolean
  /** The selected row: a new page or folder goes into it (a folder) or beside it (a page). */
  selectedId: string | null
  /** The page the main pane shows; picking a document, a sheet or an edit report closes it. */
  openId: string | null
  renamingId: string | null
  collapsed: Record<string, boolean>
  /** An import is under way. */
  busy: boolean
  /** Ms Scribe's edit on the open page that the author has not seen yet, or null. */
  aiEdit: AiEdit | null
  /** Whether the open page shows the changed lines of `aiEdit` above the editor. */
  showChanges: boolean
  load: () => Promise<void>
  clear: () => void
  /** The open project's id, which keys what the author has seen; set where the project opens. */
  project: string | null
  /** Opens the one `notebook:changed` subscription (idempotent) for project `project`. */
  subscribe: (project: string) => void
  refetch: () => Promise<void>
  select: (id: string | null) => void
  /** Opens a page in the main pane (a folder is only selected). */
  open: (id: string) => void
  close: () => void
  toggle: (id: string) => void
  startRename: (id: string) => void
  endRename: () => void
  /** A new page (opened, its title ready to type) or folder in the selected folder, or `parentId`. */
  create: (kind: NotebookKind, parentId?: string | null) => Promise<NotebookItem>
  rename: (id: string, title: string) => Promise<void>
  /** Deletes an item and what is inside it, with Undo on the toast. */
  remove: (id: string) => Promise<void>
  restore: (id: string) => Promise<void>
  move: (id: string, parentId: string | null, position: number) => Promise<void>
  /** Imports dropped files, or (none given) asks main to open the file dialog. */
  importFiles: (files?: NotebookDroppedFile[], parentId?: string | null) => Promise<void>
  /**
   * Notes redesign (fresh start): files picked on disk (the new-project wizard's) become pages in
   * a new top-level folder `folder`. Toasts what was skipped; opens nothing.
   */
  importPathsInto: (paths: string[], folder: string) => Promise<void>
  /** Reads the page's versions: a newest one by Ms Scribe the author has not seen raises the bar. */
  checkAiEdit: (pageId: string) => Promise<void>
  /** Puts the page back as it was before Ms Scribe's edit. */
  undoAiEdit: () => Promise<void>
  dismissAiEdit: () => void
  setShowChanges: (on: boolean) => void
}

/** New items' titles; a new page's is selected in the tree for the author to type over. */
export const NEW_PAGE_TITLE = 'Untitled page'
export const NEW_FOLDER_TITLE = 'New folder'

const SEEN_KEY = 'mythscribe.notebook.seen.'

/**
 * The newest version of each page the author has seen (by version id, so no clock is compared),
 * kept per project in local storage so a bar shown once does not come back on the next open.
 */
function readSeen(project: string | null): Record<string, string> {
  if (project === null) return {}
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SEEN_KEY + project) ?? '{}')
    if (typeof parsed !== 'object' || parsed === null) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string')
    )
  } catch {
    return {}
  }
}

function markSeen(project: string | null, pageId: string, versionId: string): void {
  if (project === null) return
  const seen = readSeen(project)
  seen[pageId] = versionId
  try {
    window.localStorage.setItem(SEEN_KEY + project, JSON.stringify(seen))
  } catch {
    // Storage full or unavailable: the bar may show once more; nothing else depends on it.
  }
}

/** The edit to show for `versions` (newest first), or null: the newest is Ms Scribe's and unseen. */
export function unseenAiEdit(
  pageId: string,
  versions: readonly NotebookVersion[],
  seenVersionId: string | undefined
): AiEdit | null {
  const newest = versions[0]
  if (newest?.author !== 'ai' || newest.id === seenVersionId) return null
  return { pageId, versionId: newest.id, before: newest.content }
}

const failed = (err: unknown): void => {
  toast.error(describeError(err))
}

/** Bumped by `clear`, so an answer for a project that closed is dropped. */
let generation = 0
let unsubscribe: (() => void) | null = null

const EMPTY_INDEX: NotebookIndex = buildNotebookIndex([])

export const useNotebookStore = create<NotebookState>((set, get) => {
  /**
   * Main wrote the open page (Ms Scribe, an Undo): once the author's own typing is saved, the
   * editor reloads the stored text when it differs from what it shows, and the bar is checked.
   * Text is compared, not JSON, so the echo of the author's own save never rebuilds the editor.
   */
  const syncOpenPage = async (id: string): Promise<void> => {
    const pages = useNotebookPageStore.getState
    await pages().flush()
    const shown = pages().docs[id]
    if (shown?.content == null || shown.dirty) return
    const stored = await ipc().invoke('notebook:get', { id })
    const now = pages().docs[id]
    if (now?.content == null || now.dirty || get().openId !== id) return
    if (docToText(stored.content ?? EMPTY_DOC) !== docToText(now.content)) {
      await pages().reload([id])
    }
    await get().checkAiEdit(id)
  }

  return {
    ...EMPTY_INDEX,
    loaded: false,
    project: null,
    selectedId: null,
    openId: null,
    renamingId: null,
    collapsed: {},
    busy: false,
    aiEdit: null,
    showChanges: false,

    async load() {
      const mine = generation
      const items = await ipc().invoke('notebook:list', undefined)
      if (mine !== generation) return
      const index = buildNotebookIndex(items)
      const { openId, selectedId } = get()
      set({
        ...index,
        loaded: true,
        selectedId: selectedId !== null && index.byId[selectedId] ? selectedId : null,
        ...(openId !== null && index.byId[openId] === undefined
          ? { openId: null, aiEdit: null, showChanges: false }
          : {})
      })
    },

    refetch() {
      return get().load()
    },

    clear() {
      generation++
      set({
        ...EMPTY_INDEX,
        loaded: false,
        project: null,
        selectedId: null,
        openId: null,
        renamingId: null,
        collapsed: {},
        busy: false,
        aiEdit: null,
        showChanges: false
      })
    },

    subscribe(project) {
      set({ project })
      unsubscribe ??= ipc().on('notebook:changed', ({ ids }) => {
        get().refetch().catch(failed)
        const open = get().openId
        if (open !== null && ids.includes(open)) syncOpenPage(open).catch(failed)
      })
    },

    select(id) {
      set({ selectedId: id })
      if (id !== null && get().byId[id]?.kind === 'page') get().open(id)
    },

    open(id) {
      if (get().byId[id]?.kind !== 'page') return
      // The page takes the main pane from a sheet, a record or an edit report.
      useEntityStore.getState().select(null)
      useRecordStore.getState().select(null)
      useEditPassViewStore.getState().close()
      if (get().openId !== id) set({ openId: id, aiEdit: null, showChanges: false })
      if (get().selectedId !== id) set({ selectedId: id })
      get().checkAiEdit(id).catch(failed)
    },

    close() {
      if (get().openId !== null) set({ openId: null, aiEdit: null, showChanges: false })
    },

    toggle(id) {
      const collapsed = { ...get().collapsed }
      if (collapsed[id] === true) delete collapsed[id]
      else collapsed[id] = true
      set({ collapsed })
    },

    startRename(id) {
      set({ renamingId: id })
    },

    endRename() {
      set({ renamingId: null })
    },

    async create(kind, parentId) {
      const state = get()
      const parent =
        parentId === undefined ? notebookTargetFolder(state, state.selectedId) : parentId
      const made = await ipc().invoke('notebook:create', {
        parentId: parent,
        kind,
        title: kind === 'page' ? NEW_PAGE_TITLE : NEW_FOLDER_TITLE
      })
      await get().load()
      if (parent !== null && get().collapsed[parent] === true) get().toggle(parent)
      set({ selectedId: made.id, renamingId: made.id })
      if (kind === 'page') get().open(made.id)
      return made
    },

    async rename(id, title) {
      await ipc().invoke('notebook:update', { id, title })
      await get().load()
    },

    async remove(id) {
      const item = get().byId[id]
      if (item === undefined) return
      const open = get().openId
      const closing = open !== null && isWithin(get(), open, id)
      // The open page's last typing is saved before it goes, so its Undo brings it back whole.
      if (closing) await useNotebookPageStore.getState().flush()
      await ipc().invoke('notebook:delete', { id })
      if (closing) get().close()
      if (get().selectedId !== null && isWithin(get(), get().selectedId, id)) {
        set({ selectedId: null })
      }
      await get().load()
      toast.successWithAction(`Deleted “${item.title}”`, {
        label: 'Undo',
        run: () => {
          get().restore(id).catch(failed)
        }
      })
    },

    async restore(id) {
      await ipc().invoke('notebook:restore', { id })
      await get().load()
    },

    async move(id, parentId, position) {
      await ipc().invoke('notebook:move', { id, parentId, position })
      await get().load()
    },

    async importFiles(files, parentId) {
      const state = get()
      const parent =
        parentId === undefined ? notebookTargetFolder(state, state.selectedId) : parentId
      set({ busy: true })
      let result: NotebookImportResult | null
      try {
        result = await ipc().invoke(
          'notebook:import',
          files === undefined ? { parentId: parent } : { parentId: parent, files }
        )
      } finally {
        set({ busy: false })
      }
      if (result === null) return
      await get().load()
      const pages = result.items.filter((item) => item.kind === 'page')
      if (pages.length > 0) {
        toast.success(pages.length === 1 ? 'Imported 1 page' : `Imported ${pages.length} pages`)
      }
      for (const skip of result.skipped) toast.warning(`${skip.name}: ${skip.reason}`)
      const first = pages[0]
      if (pages.length === 1 && first !== undefined) get().open(first.id)
    },

    async importPathsInto(paths, folder) {
      if (paths.length === 0) return
      const made = await ipc().invoke('notebook:create', {
        parentId: null,
        kind: 'folder',
        title: folder
      })
      set({ busy: true })
      let result: NotebookImportResult | null
      try {
        result = await ipc().invoke('notebook:import', { parentId: made.id, paths })
      } finally {
        set({ busy: false })
      }
      await get().load()
      for (const skip of result?.skipped ?? []) toast.warning(`${skip.name}: ${skip.reason}`)
    },

    async checkAiEdit(pageId) {
      const mine = generation
      const versions = await ipc().invoke('notebook:versions', { id: pageId })
      if (mine !== generation || get().openId !== pageId) return
      const { project } = get()
      const edit = unseenAiEdit(pageId, versions, readSeen(project)[pageId])
      const newest = versions[0]
      if (newest !== undefined) markSeen(project, pageId, newest.id)
      // A bar already up for this page stays until Undo or ✕, even though the edit is now seen.
      if (edit !== null) set({ aiEdit: edit })
      else if (get().aiEdit?.pageId === pageId && get().aiEdit?.versionId !== newest?.id) {
        set({ aiEdit: null, showChanges: false })
      }
    },

    async undoAiEdit() {
      const edit = get().aiEdit
      if (edit === null) return
      const pages = useNotebookPageStore.getState
      await pages().flush()
      await ipc().invoke('notebook:restoreVersion', { versionId: edit.versionId })
      set({ aiEdit: null, showChanges: false })
      await pages().reload([edit.pageId])
      await get().load()
    },

    dismissAiEdit() {
      set({ aiEdit: null, showChanges: false })
    },

    setShowChanges(on) {
      set({ showChanges: on })
    }
  }
})

// A sheet, a record or an edit report picked anywhere takes the main pane back from the page.
useEntityStore.subscribe((state, previous) => {
  if (state.selectedId !== null && state.selectedId !== previous.selectedId) {
    useNotebookStore.getState().close()
  }
})
useRecordStore.subscribe((state, previous) => {
  if (state.selectedId !== null && state.selectedId !== previous.selectedId) {
    useNotebookStore.getState().close()
  }
})
useEditPassViewStore.subscribe((state, previous) => {
  if (state.view !== null && state.view !== previous.view) useNotebookStore.getState().close()
})

// Ms Scribe's sources and note edits ask for a page through `openNotebookPage`: show it, after a
// refetch when it is new (her `create_note` can land before `notebook:changed` is read).
useOpenNotebookPageStore.subscribe((state, previous) => {
  const id = state.openNotebookPageId
  if (id === null || state.requested === previous.requested) return
  const notebook = useNotebookStore.getState()
  if (notebook.byId[id] !== undefined) {
    notebook.open(id)
    return
  }
  notebook
    .refetch()
    .then(() => useNotebookStore.getState().open(id))
    .catch(failed)
})

/** Empties the store and drops the subscription. For tests only. */
export function resetNotebookStore(): void {
  unsubscribe?.()
  unsubscribe = null
  useNotebookStore.getState().clear()
}
