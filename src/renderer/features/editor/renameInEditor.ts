import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { findInRun, type ReplaceOptions } from '@shared/replace'
import { sameTiptap, type TiptapNodeT } from '@shared/tiptap'
import { matchesIn, replaceRange } from './findReplace'

/**
 * Rename in book (F-16.13) in the open scene's live editor, as `agentApply.ts` applies the chat's
 * edits: one ordinary transaction, so autosave saves it, the caret stays, and Ctrl+Z takes it
 * back. The matches are main's (`findInRun` over the same runs `replaceInDoc` walks: a block
 * boundary, a hard break or an inline tag token ends a run), so the open scene changes exactly as
 * the stored ones did.
 */

/** What a rename did to the open scene: its JSON before and after, and how many it replaced. */
export interface EditorRename {
  before: TiptapNodeT
  after: TiptapNodeT
  count: number
}

/** Replaces every match of `options` in one transaction; null when there is none. */
export function renameInEditor(editor: Editor, options: ReplaceOptions): EditorRename | null {
  const matches = matchesIn(editor.state.doc, (text) =>
    findInRun(text, options).map(([from, to]) => ({ from, to }))
  )
  if (matches.length === 0) return null
  const before = editor.getJSON()
  const tr = editor.state.tr
  // Last to first, so every earlier match keeps its positions.
  for (let index = matches.length - 1; index >= 0; index--) {
    const match = matches[index]
    if (match !== undefined) replaceRange(tr, match.from, match.to, options.replacement)
  }
  const caret = tr.mapping.map(editor.state.selection.head)
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(caret, tr.doc.content.size))))
  editor.view.dispatch(tr)
  return { before, after: editor.getJSON(), count: matches.length }
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
