import type { Editor } from '@tiptap/core'
import { Fragment, type Node as PmNode } from '@tiptap/pm/model'
import { TextSelection, type Transaction } from '@tiptap/pm/state'
import type { TiptapNodeT } from '@shared/tiptap'
import { AI_ORIGIN_KEY, markAiOrigin } from './aiOrigin'
import { insertProse } from './insertProse'
import { locateUniqueText, type TextRange } from './locateText'

/**
 * The chat agent's text edits in a live editor (F-5.22): every change is one ordinary
 * transaction, so autosave saves it, Ctrl+Z takes it back, and prose the AI wrote carries the
 * AI-origin mark of its proposal (F-14.6). Each edit names its passage by text, which must be in
 * the document exactly once; each returns what its undo needs, and the undo is again a passage
 * search, so it works after unrelated typing and refuses when the changed text itself is gone.
 */

/** Why an edit or its undo could not be applied; the message is for the author. */
export class AgentEditError extends Error {}

/** How much text before a cut the undo looks for to put the cut back. */
const CUT_CONTEXT_CHARS = 60

function locate(doc: PmNode, passage: string, what: string): TextRange {
  const range = locateUniqueText(doc, passage)
  if (range === 'missing') throw new AgentEditError(`${what} is no longer in the scene`)
  if (range === 'ambiguous') throw new AgentEditError(`${what} now occurs more than once`)
  return range
}

function finish(editor: Editor, tr: Transaction, caret: number): void {
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(caret, tr.doc.content.size))))
  tr.scrollIntoView()
  editor.view.dispatch(tr)
}

/** Text moved within the book keeps its AI-origin marks: the transaction vouches for them. */
function keepMarks(tr: Transaction): void {
  tr.setMeta(AI_ORIGIN_KEY, { type: 'insert' })
}

/** What undoing a replacement needs: the text it took out, the text it put in, and what preceded it. */
export interface PassageUndo {
  removed: string
  inserted: string
  before: string
}

/** Replaces `find` with `replace` (empty: cuts it), marking new prose with `proposalId`. */
export function replacePassage(
  editor: Editor,
  find: string,
  replace: string,
  proposalId: string
): PassageUndo {
  const { doc } = editor.state
  const range = locate(doc, find, 'The passage')
  // A cut takes one space before the passage with it when a space or a stop follows, so
  // "ridge alone." loses "alone" without leaving "ridge ." behind.
  if (replace === '' && range.from > 1 && doc.textBetween(range.from - 1, range.from) === ' ') {
    const next = doc.textBetween(range.to, Math.min(range.to + 1, doc.content.size))
    if (next === '' || /^[\s.,;:!?)]/.test(next)) range.from -= 1
  }
  const removed = doc.textBetween(range.from, range.to, '\n\n')
  const before = doc.textBetween(
    Math.max(0, range.from - CUT_CONTEXT_CHARS * 2),
    range.from,
    ' ',
    ' '
  )
  const tr = editor.state.tr.delete(range.from, range.to)
  let caret = range.from
  if (replace !== '') {
    caret = insertProse(tr, range.from, replace)
    markAiOrigin(tr, range.from, caret, { proposalId, accepted: replace.length })
  }
  finish(editor, tr, caret)
  return { removed, inserted: replace, before: before.slice(-CUT_CONTEXT_CHARS) }
}

/** Puts back what `replacePassage` changed, as the author's own text. */
export function undoReplacePassage(editor: Editor, undo: PassageUndo): void {
  const { doc } = editor.state
  const tr = editor.state.tr
  let at: number
  if (undo.inserted !== '') {
    const range = locate(doc, undo.inserted, 'The changed passage')
    tr.delete(range.from, range.to)
    at = range.from
  } else {
    at = undo.before.trim() === '' ? 1 : locate(doc, undo.before, 'The text before the cut').to
  }
  finish(editor, tr, insertProse(tr, at, undo.removed))
}

/** The end of the last textblock's content, where text added "at the end" goes. */
function endOfText(doc: PmNode): number {
  let end = -1
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      end = pos + node.nodeSize - 1
      return false
    }
    return true
  })
  if (end < 0) throw new AgentEditError('The scene has no paragraph to add to')
  return end
}

/**
 * New paragraphs after the paragraph holding `after` (empty: after the last one; an empty last
 * paragraph is filled instead), marked with `proposalId`. Answers the text for the undo.
 */
export function insertParagraphs(
  editor: Editor,
  after: string,
  text: string,
  proposalId: string
): string {
  const { doc } = editor.state
  let pos: number
  if (after === '') {
    pos = endOfText(doc)
  } else {
    const $to = doc.resolve(locate(doc, after, 'The passage to add after').to)
    pos = $to.end($to.depth)
  }
  const tr = editor.state.tr
  let start = pos
  if (doc.resolve(pos).parent.content.size > 0) {
    tr.split(pos)
    start = pos + 2
  }
  const end = insertProse(tr, start, text)
  markAiOrigin(tr, start, end, { proposalId, accepted: text.length })
  finish(editor, tr, end)
  return text
}

/** Takes out the paragraphs `insertParagraphs` added, whole. */
export function undoInsertParagraphs(editor: Editor, text: string): void {
  const { doc } = editor.state
  const range = locate(doc, text, 'The added text')
  const $from = doc.resolve(range.from)
  const $to = doc.resolve(range.to)
  const tr = editor.state.tr.delete($from.before($from.depth), $to.after($to.depth))
  finish(editor, tr, $from.before($from.depth))
}

/** Where the top-level block holding `at` starts; refuses the first block (nothing would stay). */
function splitStart(doc: PmNode, at: string): number {
  const $at = doc.resolve(locate(doc, at, 'The passage to split at').from)
  const start = $at.before(1)
  if (start === 0) throw new AgentEditError('Splitting there would leave the scene empty')
  return start
}

/** The paragraph holding `at` and everything after it, as a document of its own; nothing changes. */
export function paragraphsFrom(editor: Editor, at: string): TiptapNodeT {
  const { doc } = editor.state
  const moved = doc.slice(splitStart(doc, at), doc.content.size).content
  return { type: 'doc', content: moved.toJSON() as TiptapNodeT[] }
}

/** Cuts the paragraph holding `at` and everything after it out of the document; answers what went. */
export function cutFromParagraph(editor: Editor, at: string): TiptapNodeT {
  const moved = paragraphsFrom(editor, at)
  const { doc } = editor.state
  const start = splitStart(doc, at)
  finish(editor, editor.state.tr.delete(start, doc.content.size), start)
  return moved
}

/** Appends the blocks of `content` at the end of the document, marks and all (a merge, an undone split). */
export function appendBlocks(editor: Editor, content: TiptapNodeT): void {
  const { doc, schema } = editor.state
  const blocks = Fragment.fromJSON(schema, content.content ?? [])
  if (blocks.size === 0) return
  const tr = editor.state.tr.insert(doc.content.size, blocks)
  keepMarks(tr)
  finish(editor, tr, tr.doc.content.size)
}
