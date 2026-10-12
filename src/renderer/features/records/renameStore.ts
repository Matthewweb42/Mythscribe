import { create } from 'zustand'
import {
  type RenameApplyResult,
  type RenamePreview,
  type RenameRequest
} from '@shared/memory/rename'
import { replaceInDoc } from '@shared/replace'
import { sameTiptap } from '@shared/tiptap'
import { editorFor, useActiveEditorStore } from '@renderer/features/editor/activeEditorStore'
import {
  renameInEditor,
  restoreInEditor,
  type EditorRename
} from '@renderer/features/editor/renameInEditor'
import { refreshRewrittenDocuments } from '@renderer/features/editor/rewrittenDocuments'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { flushPendingSaves } from '@renderer/features/project/pendingSaves'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/**
 * Rename in book (F-16.13; story memory v2) in the renderer: the preview the sheet shows, the
 * apply, and the one Undo (toast and sheet), in memory for the session like Replace in project's.
 * Main rewrites the stored scenes, the inactive drafts, the name and the Dismissed keys in one
 * transaction after an automatic snapshot; the scene open in the editor is rewritten here,
 * through the editor in one transaction (as `agentApply.ts` applies the chat's edits), so its
 * caret and history hold. Every step flushes the pending saves first, so main reads what is typed
 * and an edit made since the rename counts as an edit (the undo then leaves that scene alone).
 */

/** The last rename while it can be undone. */
export interface RenameOutcome {
  recordId: string
  from: string
  to: string
}

interface RenameState {
  /** The preview on screen and the request it answers; null before one arrived. */
  preview: RenamePreview | null
  previewFor: RenameRequest | null
  error: string | null
  busy: boolean
  undoable: RenameOutcome | null
  /** Asks main what renaming would change; an older answer than the last ask is dropped. */
  ask: (request: RenameRequest) => Promise<void>
  /** Forgets the preview (the form closed or its fields changed). */
  forget: () => void
  /** Applies the rename the preview on screen answers; answers whether it ran. */
  apply: () => Promise<boolean>
  /** Takes the last rename back where the text still reads as it left it. */
  undo: () => Promise<void>
  clear: () => void
}

/** The open scene as the rename left it, for the undo; null when the open scene had no match. */
let openRename: { nodeId: string; edit: EditorRename } | null = null
let generation = 0

const scenes = (count: number): string => `${count} scene${count === 1 ? '' : 's'}`
const matches = (count: number): string => `${count} match${count === 1 ? '' : 'es'}`

/** The live editor of `nodeId` when it is the one the author is in. */
function liveEditor(nodeId: string): ReturnType<typeof useActiveEditorStore.getState>['active'] {
  const active = useActiveEditorStore.getState().active
  return active !== null && active.id === nodeId && !active.editor.isDestroyed ? active : null
}

/**
 * The open scene when its editor went away between the flush and main's answer: its stored text
 * is rewritten with the same match, so no scene is left out, and its undo is kept the same way.
 */
async function renameStored(
  nodeId: string,
  match: RenameApplyResult['match']
): Promise<EditorRename | null> {
  const stored = (await ipc().invoke('document:get', { id: nodeId })).content
  if (stored === null) return null
  const replaced = replaceInDoc(stored, match)
  if (replaced.count === 0) return null
  const saved = await ipc().invoke('document:save', { id: nodeId, content: replaced.doc })
  await refreshRewrittenDocuments([{ id: nodeId, wordCount: saved.wordCount }])
  return { before: stored, after: replaced.doc, count: replaced.count }
}

/** The open scene put back: through its editor when it is the one open, else its stored text. */
async function restoreOpen(nodeId: string, edit: EditorRename): Promise<boolean> {
  const live = liveEditor(nodeId)
  if (live !== null) return restoreInEditor(live.editor, edit)
  const stored = (await ipc().invoke('document:get', { id: nodeId })).content
  if (stored === null || !sameTiptap(stored, edit.after)) return false
  const saved = await ipc().invoke('document:save', { id: nodeId, content: edit.before })
  await refreshRewrittenDocuments([{ id: nodeId, wordCount: saved.wordCount }])
  return true
}

export const useRenameStore = create<RenameState>((set, get) => ({
  preview: null,
  previewFor: null,
  error: null,
  busy: false,
  undoable: null,

  async ask(request) {
    const mine = ++generation
    set({ preview: null, previewFor: null, error: null })
    try {
      // Main counts the stored text: what is typed in an editor must be stored first.
      await flushPendingSaves()
      if (mine !== generation) return
      const preview = await ipc().invoke('rename:preview', request)
      if (mine === generation) set({ preview, previewFor: request })
    } catch (err) {
      if (mine === generation) set({ error: describeError(err) })
    }
  },

  forget() {
    generation++
    set({ preview: null, previewFor: null, error: null })
  },

  async apply() {
    const { previewFor, busy } = get()
    if (busy || previewFor === null) return false
    generation++
    set({ busy: true })
    try {
      // An editor's unsaved draft reaches main first, or its next autosave would undo the rename.
      await flushPendingSaves()
      const active = useActiveEditorStore.getState().active
      const openId = active !== null && !active.editor.isDestroyed ? active.id : null
      const result = await ipc().invoke('rename:apply', { ...previewFor, openId })
      await refreshRewrittenDocuments(result.written)
      openRename = null
      if (result.openId !== null) {
        const editor = liveEditor(result.openId)?.editor ?? (await editorFor(result.openId))
        const edit =
          editor !== null && !editor.isDestroyed
            ? renameInEditor(editor, result.match)
            : await renameStored(result.openId, result.match)
        if (edit !== null) openRename = { nodeId: result.openId, edit }
      }
      const from = get().preview?.from ?? previewFor.to
      const to = result.match.replacement
      const total =
        result.written.reduce((sum, each) => sum + each.count, 0) + (openRename?.edit.count ?? 0)
      const count = result.written.length + (openRename === null ? 0 : 1)
      const drafts = result.drafts === 0 ? '' : ` (+${result.drafts} in other drafts)`
      set({
        undoable: { recordId: previewFor.recordId, from, to },
        preview: null,
        previewFor: null
      })
      toast.successWithAction(
        `Renamed “${from}” to “${to}”: ${matches(total)} in ${scenes(count)}${drafts}.`,
        { label: 'Undo', run: () => void get().undo() }
      )
      return true
    } catch (err) {
      toast.error(describeError(err))
      return false
    } finally {
      set({ busy: false })
    }
  },

  async undo() {
    const { undoable, busy } = get()
    if (busy || undoable === null) return
    set({ busy: true })
    try {
      // An edit made since the rename must be stored first, so it is seen and left alone.
      await flushPendingSaves()
      const result = await ipc().invoke('rename:undo', undefined)
      await refreshRewrittenDocuments(result.restored)
      const skipped = result.skipped.map((each) => each.title)
      let restored = result.restored.length
      const open = openRename
      openRename = null
      if (open !== null) {
        if (await restoreOpen(open.nodeId, open.edit)) restored += 1
        else skipped.push(useTreeStore.getState().byId[open.nodeId]?.title ?? 'The open scene')
      }
      set({ undoable: null })
      const parts = [`Put back ${scenes(restored)}.`]
      if (skipped.length > 0) parts.push(`Left as they are (changed since): ${skipped.join(', ')}.`)
      if (result.drafts.skipped > 0) {
        parts.push(
          `${result.drafts.skipped} text${result.drafts.skipped === 1 ? '' : 's'} in other drafts changed since and stayed.`
        )
      }
      if (!result.nameRestored) parts.push(`The name stays “${undoable.to}”: it changed since.`)
      const message = parts.join(' ')
      if (skipped.length === 0 && result.nameRestored && result.drafts.skipped === 0) {
        toast.success(message)
      } else {
        toast.warning(message)
      }
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      set({ busy: false })
    }
  },

  clear() {
    generation++
    openRename = null
    set({ preview: null, previewFor: null, error: null, busy: false, undoable: null })
  }
}))

/** Empties the store and forgets the undo. For tests and project close. */
export function resetRenameStore(): void {
  useRenameStore.getState().clear()
}
