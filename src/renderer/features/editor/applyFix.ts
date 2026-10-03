import type { Editor } from '@tiptap/core'
import { locateText } from './locateText'
import { passageText } from './rewriteTarget'
import { useRewriteStore } from './rewriteStore'

/** Why Apply is refused while the rewrite panel owns the editor's target. */
export const REWRITE_BUSY_MESSAGE = 'Finish the rewrite first'

/**
 * How an AI fix for a quoted passage landed: `applied` (the passage now reads as the fix),
 * `gone` (the quote is no longer in the document, so nothing was changed), `busy` (a rewrite in
 * progress owns the editor's one rewrite target; nothing was changed).
 */
export type ApplyFixOutcome = 'applied' | 'gone' | 'busy'

/**
 * The one way a fix that quotes a passage enters the manuscript (the editor's notes of F-14.8,
 * the continuity findings of F-13.4): the quote is located in the live document and exactly that
 * range is replaced through the rewrite-target commands, so the text is AI-origin marked from
 * `proposalId` (F-14.6) and undoes as one step.
 */
export function applyFixToPassage(
  editor: Editor,
  quote: string,
  fix: string,
  proposalId: string
): ApplyFixOutcome {
  // The rewrite target is one per editor: a rewrite in progress owns it.
  if (useRewriteStore.getState().session !== null) return 'busy'
  const range = locateText(editor.state.doc, quote)
  if (range === null) return 'gone'
  const { from, to } = range
  // Two commands, not one chain: `acceptRewrite` reads the target from the state the chain
  // started in, so the target has to be set in its own transaction first.
  if (!editor.commands.setRewriteTarget(from, to, passageText(editor.state.doc, from, to))) {
    return 'gone'
  }
  if (!editor.chain().focus().acceptRewrite(fix, proposalId).run()) {
    editor.commands.clearRewriteTarget()
    return 'gone'
  }
  return 'applied'
}
