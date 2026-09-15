import { Extension, type Editor } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction
} from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { REWRITE_CONTEXT_CHARS } from '@shared/rewrite'
import { markAiOrigin } from './aiOrigin'
import { insertProse } from './insertProse'
import { rangeText, type RangeTextOptions } from './selectedText'

/**
 * The passage a rewrite is pending for (F-14.10): the document range as it stands now (it maps
 * through every edit) and the text that was sent, rendered the way `captureRewriteText` reads
 * it. Never part of the document: the range draws as an inline decoration.
 */
export interface RewriteTarget {
  from: number
  to: number
  text: string
}

/** What `captureRewriteText` hands back: the tightened selection and its text (empty for no selection). */
export type RewriteCapture = RewriteTarget

type RewriteMeta = { type: 'set'; from: number; to: number; text: string } | { type: 'clear' }

export const REWRITE_TARGET_KEY = new PluginKey<RewriteTarget | null>('rewriteTarget')

/** The class the highlighted passage carries; the stylesheet tints it and the e2e test reads it. */
export const REWRITE_TARGET_CLASS = 'rewrite-target'

/**
 * How the passage and its context read: paragraphs separated by a blank line and a hard break
 * as a newline, which is what the prompt shows the model and what `insertProse` turns back
 * into paragraphs and breaks on accept.
 */
const PASSAGE_TEXT: RangeTextOptions = { blockSeparator: '\n\n', hardBreak: '\n' }

/** The passage text of `[from, to)`, as sent and as compared against on every edit. */
export function passageText(doc: PmNode, from: number, to: number): string {
  return rangeText(doc, from, to, PASSAGE_TEXT)
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    rewriteTarget: {
      /** Highlight `[from, to)` as the passage a rewrite is pending for; false for an empty range. */
      setRewriteTarget: (from: number, to: number, text: string) => ReturnType
      /** Drop the highlight without touching the document; false when none is set. */
      clearRewriteTarget: () => ReturnType
      /**
       * Replace the target passage with `text` (paragraphs from blank lines, hard breaks from
       * newlines), mark the result as accepted from `proposalId` (F-14.6), put the caret after
       * it, and drop the target, all in one transaction so it autosaves and undoes as one step.
       * False when no target is set (the passage changed since the request) or `text` is empty.
       */
      acceptRewrite: (text: string, proposalId: string) => ReturnType
    }
  }
}

/** The pending rewrite's passage, if any. */
export function rewriteTargetOf(state: EditorState): RewriteTarget | null {
  return REWRITE_TARGET_KEY.getState(state) ?? null
}

/** One position of the document as text with no separators: '' for a block boundary or a textless atom. */
function charAt(doc: PmNode, pos: number): string {
  return rangeText(doc, pos, pos + 1, { blockSeparator: '', hardBreak: '\n' })
}

/**
 * The editor's selection as a rewrite passage: the range tightened past leading and trailing
 * whitespace, breaks, and block boundaries (so the accept never swallows the space around
 * the passage), and its text rendered with a blank line between paragraphs, a hard break as
 * a newline, and an inline tag as `#name`. The text is empty for a caret or a blank selection.
 */
export function captureRewriteText(editor: Editor): RewriteCapture {
  const { doc } = editor.state
  let { from, to } = editor.state.selection
  while (from < to && charAt(doc, from).trim() === '') from++
  while (to > from && charAt(doc, to - 1).trim() === '') to--
  return { from, to, text: from < to ? passageText(doc, from, to) : '' }
}

/**
 * The manuscript text around a passage, `REWRITE_CONTEXT_CHARS` each side at most, so the
 * rewrite keeps its seams. The windows read a bounded run of positions (two characters per
 * position covers the block tokens) and cut to the character budget the contract allows.
 */
export function rewriteContext(
  doc: PmNode,
  from: number,
  to: number
): { before: string; after: string } {
  const reach = REWRITE_CONTEXT_CHARS * 2
  const before = passageText(doc, Math.max(0, from - reach), from).slice(-REWRITE_CONTEXT_CHARS)
  const after = passageText(doc, to, Math.min(doc.content.size, to + reach)).slice(
    0,
    REWRITE_CONTEXT_CHARS
  )
  return { before, after }
}

/**
 * The next state for a transaction. Our own metadata wins; otherwise the range maps through
 * the change (text typed exactly at either edge stays outside it) and survives only while the
 * passage still reads as it was sent: an edit inside it, or a deletion across it, drops the
 * target, so an accept can never replace text the model did not see.
 */
function apply(tr: Transaction, value: RewriteTarget | null): RewriteTarget | null {
  const meta = tr.getMeta(REWRITE_TARGET_KEY) as RewriteMeta | undefined
  if (meta !== undefined) {
    return meta.type === 'set' ? { from: meta.from, to: meta.to, text: meta.text } : null
  }
  if (value === null || !tr.docChanged) return value
  const from = tr.mapping.map(value.from, 1)
  const to = tr.mapping.map(value.to, -1)
  if (from >= to || passageText(tr.doc, from, to) !== value.text) return null
  return from === value.from && to === value.to ? value : { ...value, from, to }
}

/**
 * The pending rewrite's passage (F-14.10): a range in plugin state that maps through the
 * author's edits, drawn as an inline highlight, and invalidated the moment the passage itself
 * changes. `acceptRewrite` is the one way a rewrite enters the manuscript: the range is
 * replaced by the answer through an ordinary transaction (paragraph-aware, AI-origin marked,
 * F-14.6), so the document store, autosave, and undo treat it like typing. Nothing here talks
 * to main: the rewrite store does, and it calls these commands.
 */
export const RewriteTarget = Extension.create({
  name: 'rewriteTarget',

  addCommands() {
    return {
      setRewriteTarget:
        (from, to, text) =>
        ({ tr, dispatch }) => {
          if (from >= to || !text) return false
          if (dispatch)
            tr.setMeta(REWRITE_TARGET_KEY, { type: 'set', from, to, text } satisfies RewriteMeta)
          return true
        },
      clearRewriteTarget:
        () =>
        ({ state, tr, dispatch }) => {
          if (rewriteTargetOf(state) === null) return false
          if (dispatch) tr.setMeta(REWRITE_TARGET_KEY, { type: 'clear' } satisfies RewriteMeta)
          return true
        },
      acceptRewrite:
        (text, proposalId) =>
        ({ state, tr, dispatch }) => {
          const target = rewriteTargetOf(state)
          if (target === null || !text) return false
          if (dispatch) {
            tr.delete(target.from, target.to)
            const end = insertProse(tr, target.from, text)
            markAiOrigin(tr, target.from, end, { proposalId, accepted: text.length })
            tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(end, tr.doc.content.size))))
            tr.setMeta(REWRITE_TARGET_KEY, { type: 'clear' } satisfies RewriteMeta)
            tr.scrollIntoView()
          }
          return true
        }
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<RewriteTarget | null>({
        key: REWRITE_TARGET_KEY,
        state: { init: () => null, apply },
        props: {
          decorations(state) {
            const target = rewriteTargetOf(state)
            if (target === null) return DecorationSet.empty
            return DecorationSet.create(state.doc, [
              Decoration.inline(target.from, target.to, { class: REWRITE_TARGET_CLASS })
            ])
          }
        }
      })
    ]
  }
})
