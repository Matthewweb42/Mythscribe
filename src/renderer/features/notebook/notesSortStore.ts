import { create } from 'zustand'
import {
  notebookTitleFromFileName,
  type NotebookImportSplit,
  type NotebookItem
} from '@shared/notebook'
import type { NotesSortAppended } from '@shared/notesSort'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { notebookTargetFolder } from './notebookIndex'
import { useNotebookStore, type NotebookDroppedFile } from './notebookStore'

/**
 * Breaking an upload into smaller pages (notes structure part B, `structure.md` §B, 2026-10-16):
 * the one owner of the choice a drop or a pick into Notes asks before importing (One page each ·
 * Split at headings · Sort with Ms Scribe), the same Sort asked from a page's menu, and the sort
 * under way or just finished (which the activity bar reads, `activityJobs.ts` kind `notesSort`),
 * with its one Undo for the session: what it made deleted, the pages it appended to put back.
 */

/** How the files of one drop or pick come in. */
export type NotesImportMode = NotebookImportSplit | 'sort'

export type NotesSortChoice =
  | {
      kind: 'import'
      /** Dropped files as bytes, or null for picked `paths`. */
      files: NotebookDroppedFile[] | null
      paths: string[] | null
      names: string[]
      parentId: string | null
    }
  | { kind: 'page'; pageId: string; title: string }

/** A sort under way. */
export interface NotesSortJob {
  key: string
  title: string
}

/** A finished sort, with what its Undo takes back. */
export interface NotesSortDone extends NotesSortJob {
  pages: number
  made: NotebookItem[]
  appended: NotesSortAppended[]
  /** Why it stopped early, after writing some pages. */
  stopped: string | null
  undone: boolean
}

export interface NotesSortFailure extends NotesSortJob {
  message: string
}

interface NotesSortState {
  choice: NotesSortChoice | null
  running: NotesSortJob | null
  done: NotesSortDone | null
  failed: NotesSortFailure | null
  /**
   * A drop (`files`) or, with none, a pick in the open dialog into Notes: asks how they come in.
   * `parentId` absent: the selected folder.
   */
  askImport: (files?: NotebookDroppedFile[], parentId?: string | null) => Promise<void>
  /** Sort with Ms Scribe from a page's menu: asks with its price first. */
  askSort: (pageId: string) => void
  cancel: () => void
  /** The author's choice: imports the files that way, or sorts the page. */
  confirm: (mode: NotesImportMode) => Promise<void>
  /** Sorts note pages; the activity bar shows it running and then its line. */
  sort: (pageIds: string[], title: string) => Promise<void>
  /** The finished sort's one Undo. */
  undo: () => Promise<void>
  /** Shows the first page the finished sort made, in the Notes tab. */
  openResult: () => void
  clear: () => void
}

const baseName = (file: string): string => file.split(/[\\/]/).pop() ?? file

/** What the activity line calls the documents: the one file or page by its title, else a count. */
export function sortTitleOf(names: readonly string[]): string {
  const first = names[0]
  if (names.length === 1 && first !== undefined) return notebookTitleFromFileName(first)
  return `${names.length} files`
}

let counter = 0

export const useNotesSortStore = create<NotesSortState>((set, get) => ({
  choice: null,
  running: null,
  done: null,
  failed: null,

  async askImport(files, parentId) {
    const notebook = useNotebookStore.getState()
    const parent =
      parentId === undefined ? notebookTargetFolder(notebook, notebook.selectedId) : parentId
    if (files !== undefined) {
      if (files.length === 0) return
      set({
        choice: {
          kind: 'import',
          files,
          paths: null,
          names: files.map((file) => file.name),
          parentId: parent
        }
      })
      return
    }
    const paths = await ipc().invoke('library:choose', undefined)
    if (paths.length === 0) return
    set({
      choice: { kind: 'import', files: null, paths, names: paths.map(baseName), parentId: parent }
    })
  },

  askSort(pageId) {
    const page = useNotebookStore.getState().byId[pageId]
    if (page?.kind !== 'page') return
    set({ choice: { kind: 'page', pageId, title: page.title } })
  },

  cancel() {
    set({ choice: null })
  },

  async confirm(mode) {
    const choice = get().choice
    if (choice === null) return
    set({ choice: null })
    if (choice.kind === 'page') {
      await get().sort([choice.pageId], choice.title)
      return
    }
    const notebook = useNotebookStore.getState()
    const files = choice.files ?? undefined
    const paths = choice.paths ?? undefined
    // Sorted files come in as one page each first, and stay (a sort may leave things out).
    const result = await notebook.importFiles(
      files,
      choice.parentId,
      mode === 'sort' ? 'none' : mode,
      paths
    )
    if (mode !== 'sort' || result === null) return
    const pages = result.items.filter((item) => item.kind === 'page').map((item) => item.id)
    if (pages.length === 0) return
    await get().sort(pages, sortTitleOf(choice.names))
  },

  async sort(pageIds, title) {
    if (get().running !== null) {
      toast.warning('Ms Scribe is already sorting a document.')
      return
    }
    const key = `sort-${++counter}`
    set({ running: { key, title }, failed: null })
    try {
      const result = await ipc().invoke('notesSort:run', { pageIds })
      if (result.ok) {
        set({
          done: {
            key,
            title,
            pages: result.pages,
            made: result.made,
            appended: result.appended,
            stopped: result.stopped,
            undone: false
          }
        })
      } else {
        set({ failed: { key, title, message: `${result.message} ${result.nextStep}`.trim() } })
      }
    } catch (err) {
      set({ failed: { key, title, message: describeError(err) } })
    } finally {
      set({ running: null })
    }
    await useNotebookStore.getState().load()
  },

  async undo() {
    const done = get().done
    if (done === null || done.undone) return
    set({ done: { ...done, undone: true } })
    const made = new Set(done.made.map((item) => item.id))
    const notebook = useNotebookStore.getState()
    if (notebook.openId !== null && made.has(notebook.openId)) notebook.close()
    try {
      // A folder it made takes what is in it; a page it made in one of hers goes alone.
      for (const item of done.made) {
        if (item.parentId !== null && made.has(item.parentId)) continue
        await ipc().invoke('notebook:delete', { id: item.id })
      }
      for (const entry of done.appended) {
        await ipc().invoke('notebook:restoreVersion', { versionId: entry.versionId })
      }
      toast.success(`Undid the sort of ${done.title}`)
    } catch (err) {
      toast.error(describeError(err))
    }
    await useNotebookStore.getState().load()
  },

  openResult() {
    const done = get().done
    const first = done?.made.find((item) => item.kind === 'page') ?? done?.appended[0]
    if (first === undefined) return
    const layout = useLayoutStore.getState()
    layout.setSidebarTab('notes')
    if (!layout.layout.sidebar.open) layout.toggle('sidebar')
    const id = 'pageId' in first ? first.pageId : first.id
    useNotebookStore.getState().open(id)
  },

  clear() {
    set({ choice: null, running: null, done: null, failed: null })
  }
}))

/** Empties the store. For tests, and when a project closes. */
export function resetNotesSortStore(): void {
  useNotesSortStore.getState().clear()
}
