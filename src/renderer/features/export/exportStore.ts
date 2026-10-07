import { create } from 'zustand'
import type {
  ExportFormat,
  ExportFormatting,
  ExportOptions,
  ExportProgress,
  ExportScope
} from '@shared/bookExport'
import { useDocumentStore } from '@renderer/features/editor/documentStore'
import { useSceneMetaStore } from '@renderer/features/editor/sceneMetaStore'
import type { TreeIndex } from '@renderer/features/manuscript/treeStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

export type ExportScopeKind = ExportScope['kind']

/** The author's choices in the Export dialog, kept for the session so a second export starts from them. */
export interface ExportChoices {
  format: ExportFormat
  scope: ExportScopeKind
  /** The ticked chapters for `scope: 'chapters'`; kept while another scope is picked. */
  chapterIds: string[]
  includeFront: boolean
  includeEnd: boolean
  /** Null until the author changes one: the dialog then shows the defaults from the editor's scene break. */
  formatting: ExportFormatting | null
}

export type ExportStatus = 'idle' | 'running' | 'error'

/**
 * The one owner of the export (F-12.1) in the renderer: the dialog's choices for the session,
 * and the run in flight with its progress (`export:progress`, filtered by the run's request id).
 * A run flushes the document and scene metadata drafts the way the compiled preview does, asks
 * main (which shows the save dialog), and toasts the written path; a cancelled save dialog goes
 * back to idle silently, a failure keeps its message for the dialog's alert. Cleared when the
 * project closes (`App.tsx`).
 */
interface ExportState extends ExportChoices {
  status: ExportStatus
  /** The latest step main reported for the run in flight; null before the first one. */
  progress: ExportProgress | null
  error: string | null
  setFormat: (format: ExportFormat) => void
  setScope: (scope: ExportScopeKind) => void
  toggleChapter: (id: string, on: boolean) => void
  setIncludeFront: (on: boolean) => void
  setIncludeEnd: (on: boolean) => void
  setFormatting: (formatting: ExportFormatting) => void
  /** Runs one export; answers true when a file was written (false when cancelled or failed). */
  run: (options: ExportOptions) => Promise<boolean>
  clear: () => void
}

const INITIAL: ExportChoices & Pick<ExportState, 'status' | 'progress' | 'error'> = {
  format: 'pdf',
  scope: 'manuscript',
  chapterIds: [],
  includeFront: true,
  includeEnd: true,
  formatting: null,
  status: 'idle',
  progress: null,
  error: null
}

/** Bumped by every run and clear, so an answer from a superseded run is dropped. */
let generation = 0

export const useExportStore = create<ExportState>((set, get) => ({
  ...INITIAL,

  setFormat(format) {
    set({ format })
  },

  setScope(scope) {
    set({ scope })
  },

  toggleChapter(id, on) {
    set((s) => {
      const has = s.chapterIds.includes(id)
      if (on === has) return {}
      return { chapterIds: on ? [...s.chapterIds, id] : s.chapterIds.filter((c) => c !== id) }
    })
  },

  setIncludeFront(includeFront) {
    set({ includeFront })
  },

  setIncludeEnd(includeEnd) {
    set({ includeEnd })
  },

  setFormatting(formatting) {
    set({ formatting })
  },

  async run(options) {
    if (get().status === 'running') return false
    const mine = ++generation
    const requestId = crypto.randomUUID()
    set({ status: 'running', progress: null, error: null })
    const unsubscribe = ipc().on('export:progress', (progress) => {
      if (progress.requestId === requestId && mine === generation) set({ progress })
    })
    try {
      // A failed save is reported by the autosave itself; the stored text is still worth exporting.
      await Promise.all([
        useDocumentStore
          .getState()
          .flush()
          .catch(() => undefined),
        useSceneMetaStore
          .getState()
          .flush()
          .catch(() => undefined)
      ])
      const result = await ipc().invoke('export:run', { options, requestId })
      if (mine !== generation) return false
      set({ status: 'idle', progress: null })
      if (result === null) return false
      toast.success(`Exported to ${result.path}`)
      return true
    } catch (err) {
      if (mine === generation) set({ status: 'error', progress: null, error: describeError(err) })
      return false
    } finally {
      unsubscribe()
    }
  },

  clear() {
    generation++
    set(INITIAL)
  }
}))

/** Empties the store and drops any run in flight. For tests only. */
export function resetExportStore(): void {
  useExportStore.getState().clear()
}

/** A chapter of the manuscript, listed under the part that holds it (null: no part). */
export interface ChapterGroup {
  partId: string | null
  partTitle: string | null
  chapters: { id: string; title: string }[]
}

/**
 * The manuscript's chapters in reading order, grouped under their parts, for the "Selected
 * chapters" checklist. Chapters outside any part form a group of their own in place; a scene
 * placed at chapter level (right under the root or a part) is listed like a chapter.
 */
export function chapterGroups(
  index: Pick<TreeIndex, 'byId' | 'childrenOf' | 'rootIds'>
): ChapterGroup[] {
  const groups: ChapterGroup[] = []
  const root = index.rootIds.find((id) => index.byId[id]?.sectionType === 'manuscript')
  if (root === undefined) return groups
  const walk = (parentId: string, part: { id: string; title: string } | null): void => {
    for (const id of index.childrenOf[parentId] ?? []) {
      const node = index.byId[id]
      if (!node) continue
      // A scene placed at chapter level (a prologue right under the root or a part) is listed
      // like a chapter: it prints with its own heading.
      if (
        node.hierarchyLevel === 'chapter' ||
        (node.hierarchyLevel === 'scene' && (parentId === root || part?.id === parentId))
      ) {
        const last = groups.at(-1)
        const chapter = { id, title: node.title }
        // `undefined` (no group yet) never equals a part id or null.
        if (last?.partId === (part?.id ?? null)) last.chapters.push(chapter)
        else
          groups.push({
            partId: part?.id ?? null,
            partTitle: part?.title ?? null,
            chapters: [chapter]
          })
      } else if (node.hierarchyLevel === 'part') {
        walk(id, { id, title: node.title })
      } else if (node.kind === 'folder') {
        walk(id, part)
      }
    }
  }
  walk(root, null)
  return groups
}

/**
 * The `ExportOptions` the choices make, or null while they cannot run: no chapter ticked (of
 * those still in the manuscript), no open document for "Current document", or a blank scene break.
 */
export function buildExportOptions(
  choices: ExportChoices,
  defaults: ExportFormatting,
  context: { chapterIds: ReadonlySet<string>; openDocumentId: string | null }
): ExportOptions | null {
  const formatting = choices.formatting ?? defaults
  if (formatting.sceneBreak.trim() === '') return null
  let scope: ExportScope
  if (choices.scope === 'chapters') {
    const ids = choices.chapterIds.filter((id) => context.chapterIds.has(id))
    if (ids.length === 0) return null
    scope = { kind: 'chapters', ids }
  } else if (choices.scope === 'document') {
    if (context.openDocumentId === null) return null
    scope = { kind: 'document', id: context.openDocumentId }
  } else {
    scope = { kind: 'manuscript' }
  }
  return {
    format: choices.format,
    scope,
    includeFront: choices.includeFront,
    includeEnd: choices.includeEnd,
    formatting: { ...formatting, sceneBreak: formatting.sceneBreak.trim() }
  }
}
