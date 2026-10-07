import type { Node as PmNode } from '@tiptap/pm/model'
import { EditorState, type Transaction } from '@tiptap/pm/state'
import type { EditChange } from '@shared/editPass'
import { TiptapNode, type TiptapNodeT } from '@shared/tiptap'
import { markAiOrigin } from '@renderer/features/editor/aiOrigin'
import { manuscriptSchema } from '@renderer/features/editor/extensions'
import { insertProse } from '@renderer/features/editor/insertProse'
import { locateAll, type TextRange } from '@renderer/features/editor/locateText'

/**
 * The one way an edit-pass change (F-14.15) enters the manuscript: the passage at `range` is
 * replaced by the change's replacement (a cut deletes it) through an ordinary transaction, and
 * the inserted text carries the AI-origin mark of the change's proposal (F-14.6), so provenance,
 * autosave, and undo treat it like any accepted AI text. Returns false when there is nothing to
 * do (a note, or a range outside the document).
 */
export function applyEditChange(
  tr: Transaction,
  range: TextRange,
  change: Pick<EditChange, 'replacement' | 'proposalId'>
): boolean {
  if (change.replacement === null) return false
  if (range.from >= range.to || range.to > tr.doc.content.size) return false
  tr.delete(range.from, range.to)
  if (change.replacement === '') return true
  const end = insertProse(tr, range.from, change.replacement)
  if (change.proposalId !== null) {
    markAiOrigin(tr, range.from, end, {
      proposalId: change.proposalId,
      accepted: change.replacement.length
    })
  }
  return true
}

/** The outcome of applying a scene's changes outside an editor: the new document and what happened to each change. */
export interface AppliedChanges {
  doc: TiptapNodeT
  applied: string[]
  stale: string[]
}

/**
 * Applies changes to a stored document with no editor mounted (accept all from a report): each
 * change's passage is found again in the document as it stands (so an earlier change that moved
 * text is accounted for), applied, or reported stale when it is gone. The schema is the
 * manuscript's; the scene-break text is a render option, so any value parses the same.
 */
export function applyChangesToDoc(
  json: TiptapNodeT,
  changes: readonly Pick<EditChange, 'id' | 'original' | 'replacement' | 'proposalId'>[]
): AppliedChanges {
  const schema = manuscriptSchema('* * *')
  let state = EditorState.create({ schema, doc: schema.nodeFromJSON(json) })
  const applied: string[] = []
  const stale: string[] = []
  for (const change of changes) {
    const range = locateAll(state.doc, [change.original])[0] ?? null
    const tr = state.tr
    if (range === null || !applyEditChange(tr, range, change)) {
      stale.push(change.id)
      continue
    }
    state = state.apply(tr)
    applied.push(change.id)
  }
  return { doc: docJson(state.doc), applied, stale }
}

/** ProseMirror's JSON is the Tiptap document shape; parsed, not cast, like every stored document. */
function docJson(doc: PmNode): TiptapNodeT {
  return TiptapNode.parse(doc.toJSON())
}
