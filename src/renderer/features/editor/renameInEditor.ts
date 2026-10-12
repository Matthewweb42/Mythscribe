import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import type { RenameEdit } from '@shared/memory/rename'
import { sameTiptap, type TiptapNodeT } from '@shared/tiptap'
import { replaceRange } from './findReplace'

/**
 * Rename in book (F-16.13) in the open scene's live editor, as `agentApply.ts` applies the chat's
 * edits: one ordinary transaction, so autosave saves it, the caret stays, and Ctrl+Z takes it
 * back. The places are main's (the name scan's mentions of the record, at positions of the text
 * the renderer flushed just before), so the open scene changes exactly as the stored ones did; a
 * place that no longer holds its words (or spans a block or an inline token) is skipped.
 */

/** What a rename did to the open scene: its JSON before and after, and how many it replaced. */
export interface EditorRename {
  before: TiptapNodeT
  after: TiptapNodeT
  count: number
}

/** Applies main's places in one transaction; null when none still holds its words. */
export function renameInEditor(editor: Editor, edits: readonly RenameEdit[]): EditorRename | null {
  const doc = editor.state.doc
  const size = doc.content.size
  const live = edits
    .filter(
      (edit) =>
        edit.from < edit.to &&
        edit.to <= size &&
        // A block separator or a leaf in the range reads as a character the words cannot hold.
        doc.textBetween(edit.from, edit.to, '\n', '\u0000') === edit.text
    )
    .sort((a, b) => a.from - b.from)
    .filter((edit, index, all) => index === 0 || (all[index - 1]?.to ?? 0) <= edit.from)
  if (live.length === 0) return null
  const before = editor.getJSON()
  const tr = editor.state.tr
  // Last to first, so every earlier place keeps its positions.
  for (let index = live.length - 1; index >= 0; index--) {
    const edit = live[index]
    if (edit !== undefined) replaceRange(tr, edit.from, edit.to, edit.replacement)
  }
  const caret = tr.mapping.map(editor.state.selection.head)
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(caret, tr.doc.content.size))))
  editor.view.dispatch(tr)
  return { before, after: editor.getJSON(), count: live.length }
}

/**
 * Puts the open scene back as it was before the rename, in one transaction (so Ctrl+Z can take
 * the undo back too), only while it still reads exactly as the rename left it. Answers whether
 * it did.
 */
export function restoreInEditor(editor: Editor, rename: EditorRename): boolean {
  if (!sameTiptap(editor.getJSON(), rename.after)) return false
  const doc = editor.schema.nodeFromJSON(rename.before)
  const caret = editor.state.selection.head
  const tr = editor.state.tr.replaceWith(0, editor.state.doc.content.size, doc.content)
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(caret, tr.doc.content.size))))
  editor.view.dispatch(tr)
  return true
}
