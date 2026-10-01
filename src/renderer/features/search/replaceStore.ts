import { create } from 'zustand'
import {
  isReplaceable,
  type ReplaceCommitResult,
  type ReplacePreview,
  type ReplaceRequest,
  type ReplaceUndoResult
} from '@shared/replace'
import { useDocumentStore } from '@renderer/features/editor/documentStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { flushPendingSaves } from '@renderer/features/project/pendingSaves'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/** How long the fields rest before main is asked for a preview; an option change asks at once. */
export const REPLACE_DEBOUNCE_MS = 200

export type ReplaceStatus = 'idle' | 'searching' | 'done' | 'error'

/** The tree node the dialog was opened on: what "this and everything in it" means. */
export interface ReplaceScopeNode {
  id: string
  title: string
}

/** What the last commit did, kept while it can still be undone. */
export interface ReplaceOutcome {
  total: number
  documents: number
}

/**
 * The find and replace dialog (F-10.2): what is typed, the options, the scope, the preview main
 * last answered, and which of its documents the author unticked. Typing is debounced and a
 * generation counter drops an overtaken preview, as in the search store. Nothing is written
 * until `commit`, which sends exactly the request the preview on screen answered — never what
 * has been typed since — so the author gets what was shown.
 *
 * Main reads and writes the stored text, so every preview, commit, and undo first flushes the
 * pending saves; after a commit or an undo the rewritten documents that are loaded are read
 * again (`documentStore.reload`), which rebuilds their mounted editors, single or stacked.
 */
interface ReplaceState {
  open: boolean
  query: string
  replacement: string
  matchCase: boolean
  wholeWord: boolean
  /** Where to look: every document, or `scopeNode` and everything in it. */
  scope: 'all' | 'selection'
  /** The tree selection when the dialog opened; null when nothing was selected. */
  scopeNode: ReplaceScopeNode | null
  /** The last answer for the current fields; null before one arrived. */
  preview: ReplacePreview | null
  /** The request `preview` answers, which is the request a commit sends. */
  answered: ReplaceRequest | null
  /** The previewed documents the author unticked. */
  excluded: string[]
  status: ReplaceStatus
  /** Why the last preview failed; null unless `status` is `error`. */
  error: string | null
  /** True while a commit or an undo is writing. */
  busy: boolean
  /** The last commit, while `undo` can still take it back. */
  undoable: ReplaceOutcome | null
  /** Opens the dialog on the tree's selection, optionally with the find field prefilled. */
  openReplace: (query?: string) => void
  close: () => void
  setQuery: (query: string) => void
  setReplacement: (replacement: string) => void
  setMatchCase: (matchCase: boolean) => void
  setWholeWord: (wholeWord: boolean) => void
  setScope: (scope: 'all' | 'selection') => void
  toggleDocument: (id: string) => void
  /** Replaces in the ticked documents of the preview on screen; answers null when nothing ran. */
  commit: () => Promise<ReplaceCommitResult | null>
  /** Takes the last commit back; answers null when nothing ran. */
  undo: () => Promise<ReplaceUndoResult | null>
  /** Closes the dialog and forgets everything: the project closed. */
  reset: () => void
}

const initial = {
  open: false,
  query: '',
  replacement: '',
  matchCase: false,
  wholeWord: false,
  scope: 'all' as const,
  scopeNode: null,
  preview: null,
  answered: null,
  excluded: [] as string[],
  status: 'idle' as ReplaceStatus,
  error: null,
  busy: false,
  undoable: null
}

let generation = 0
let timer: ReturnType<typeof setTimeout> | null = null

function cancelTimer(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null
}

const plural = (count: number, noun: string): string =>
  `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`

/** "3 occurrences in 2 documents": the one wording for the footer, the confirm, and the toast. */
export function describeReplaceCounts(total: number, documents: number): string {
  return `${plural(total, 'occurrence')} in ${plural(documents, 'document')}`
}

/** The loaded documents among `written` are read again and the tree's word counts follow. */
async function refresh(written: readonly { id: string; wordCount: number }[]): Promise<void> {
  const tree = useTreeStore.getState()
  for (const { id, wordCount } of written) tree.setWordCount(id, wordCount)
  await useDocumentStore.getState().reload(written.map((each) => each.id))
}

export const useReplaceStore = create<ReplaceState>((set, get) => {
  const request = (): ReplaceRequest => {
    const { query, replacement, matchCase, wholeWord, scope, scopeNode } = get()
    return {
      query,
      replacement,
      matchCase,
      wholeWord,
      scopeId: scope === 'selection' && scopeNode !== null ? scopeNode.id : null
    }
  }

  const run = async (): Promise<void> => {
    cancelTimer()
    const mine = ++generation
    const asked = request()
    if (!isReplaceable(asked)) {
      set({ preview: null, answered: null, excluded: [], status: 'idle', error: null })
      return
    }
    set({ status: 'searching', error: null })
    try {
      // Main previews the stored text: what is typed in an editor must be stored first.
      await flushPendingSaves()
      if (mine !== generation) return
      const preview = await ipc().invoke('replace:preview', asked)
      if (mine !== generation) return // a newer request, a commit, or a reset overtook this one
      // A document stays unticked across previews while it is still listed.
      const listed = new Set(preview.items.map((item) => item.id))
      set((s) => ({
        preview,
        answered: asked,
        excluded: s.excluded.filter((id) => listed.has(id)),
        status: 'done'
      }))
    } catch (err) {
      if (mine !== generation) return
      set({ preview: null, answered: null, status: 'error', error: describeError(err) })
    }
  }

  /** A typed field changed: the preview on screen is for older text and must not be committed. */
  const typed = (patch: Partial<Pick<ReplaceState, 'query' | 'replacement'>>): void => {
    cancelTimer()
    generation++
    set(patch)
    if (!isReplaceable(get())) {
      set({ preview: null, answered: null, excluded: [], status: 'idle', error: null })
      return
    }
    set({ preview: null, answered: null, status: 'searching', error: null })
    timer = setTimeout(() => void run(), REPLACE_DEBOUNCE_MS)
  }

  /** An option changed: ask at once, and until the answer lands there is nothing to commit. */
  const chosen = (patch: Partial<ReplaceState>): void => {
    generation++
    set({ ...patch, preview: null, answered: null })
    void run()
  }

  return {
    ...initial,

    openReplace(query) {
      const tree = useTreeStore.getState()
      const selected = tree.selectedId === null ? undefined : tree.byId[tree.selectedId]
      const scopeNode = selected ? { id: selected.id, title: selected.title } : null
      const was = get()
      const sameNode = scopeNode?.id === was.scopeNode?.id
      const prefill = query !== undefined && query !== '' && query !== was.query
      // A second arrival of the same chord (the listener and the accelerator) changes nothing.
      if (was.open && sameNode && !prefill) return
      // Opening asks again: the documents may have changed since the dialog was last shown.
      chosen({
        open: true,
        scopeNode,
        // "This and everything in it" is about the selection it was chosen for.
        scope: was.scope === 'selection' && sameNode ? 'selection' : 'all',
        ...(prefill ? { query } : {})
      })
    },

    close() {
      set({ open: false })
    },

    setQuery(query) {
      typed({ query })
    },

    setReplacement(replacement) {
      typed({ replacement })
    },

    setMatchCase(matchCase) {
      chosen({ matchCase })
    },

    setWholeWord(wholeWord) {
      chosen({ wholeWord })
    },

    setScope(scope) {
      chosen({ scope })
    },

    toggleDocument(id) {
      set((s) => ({
        excluded: s.excluded.includes(id) ? s.excluded.filter((e) => e !== id) : [...s.excluded, id]
      }))
    },

    async commit() {
      const { preview, answered, excluded, status, busy } = get()
      if (busy || status !== 'done' || preview === null || answered === null) return null
      const ids = preview.items.filter((item) => !excluded.includes(item.id)).map((item) => item.id)
      if (ids.length === 0) return null
      // The preview on screen is spent whatever happens next.
      generation++
      set({ busy: true })
      try {
        // An editor's unsaved draft must reach main before main rewrites the document, or the
        // draft's next autosave would put the old text back.
        await flushPendingSaves()
        const result = await ipc().invoke('replace:commit', { ...answered, ids })
        await refresh(result.changed)
        if (result.changed.length > 0) {
          const outcome = { total: result.total, documents: result.changed.length }
          set({ undoable: outcome })
          toast.success(`Replaced ${describeReplaceCounts(outcome.total, outcome.documents)}.`)
        } else {
          toast.info('Nothing was replaced: the text had changed since the preview.')
        }
        return result
      } catch (err) {
        toast.error(describeError(err))
        return null
      } finally {
        set({ busy: false })
        // What is left to replace (the unticked documents, or nothing).
        void run()
      }
    },

    async undo() {
      if (get().busy || get().undoable === null) return null
      generation++
      set({ busy: true })
      try {
        // An edit made since the commit must be stored first, so main sees the document changed
        // and leaves it alone instead of restoring over it.
        await flushPendingSaves()
        const result = await ipc().invoke('replace:undo', undefined)
        await refresh(result.restored)
        set({ undoable: null })
        const restored = `Restored ${plural(result.restored.length, 'document')}.`
        if (result.skipped.length === 0) toast.success(restored)
        else {
          toast.warning(
            `${restored} ${plural(result.skipped.length, 'document')} changed since the replace and ${result.skipped.length === 1 ? 'was' : 'were'} left as ${result.skipped.length === 1 ? 'it is' : 'they are'}.`
          )
        }
        return result
      } catch (err) {
        toast.error(describeError(err))
        return null
      } finally {
        set({ busy: false })
        void run()
      }
    },

    reset() {
      cancelTimer()
      generation++
      set({ ...initial, excluded: [] })
    }
  }
})

/** Back to the closed, empty dialog, with any pending request dropped. For tests and project close. */
export function resetReplaceStore(): void {
  useReplaceStore.getState().reset()
}
