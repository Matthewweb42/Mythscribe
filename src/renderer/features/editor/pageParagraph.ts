import { Extension } from '@tiptap/core'
import { isHistoryTransaction } from '@tiptap/pm/history'
import type { Node as PmNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import type { z } from 'zod'
import {
  AI_FILED_ATTR,
  AI_MARK_ATTRS,
  AI_WRITTEN_ATTR,
  AiFiled,
  AiWritten,
  NOT_CANON_ATTR
} from '@shared/memory/pageMarks'
import { OriginParagraph } from './originParagraph'

/**
 * The page paragraph (F-16.6, F-16.8; plan P1 §2.3): the paragraph of every page story memory v2
 * keeps beside the manuscript (Research documents now; a record's Pinned and Ideas from slice
 * 3). It is the manuscript's `OriginParagraph` plus three attributes, so the manuscript schema
 * and every stored scene stay exactly as they were:
 * - `notCanon` (rendered `data-not-canon`): the author's mark that the paragraph is an idea or a
 *   maybe, never true; toggled with `toggleNotCanon`. Page headings carry it too
 *   (`PageHeadingMarks`).
 * - `aiFiled` ({ doc, para, quote }) and `aiWritten` ({ turn, date }): the paragraph came from a
 *   filed upload or from the chat. `clearAiMarks` drops both once the author changes its words;
 *   the app's own writes carry the `MEMORY_PROGRAMMATIC_META` meta and leave them alone.
 */

/** Transaction meta the app sets on its own writes to a page, so `clearAiMarks` leaves its marks. */
export const MEMORY_PROGRAMMATIC_META = 'memoryProgrammatic'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    pageParagraph: {
      /**
       * Marks the paragraphs and headings the selection touches Not canon, or, when every one of
       * them already is, takes the mark off.
       */
      toggleNotCanon: () => ReturnType
    }
  }
}

/** A JSON attribute read back from the HTML clipboard flavour; null when absent or unreadable. */
function jsonAttr<T>(raw: string | null, schema: z.ZodType<T>): T | null {
  if (raw === null) return null
  try {
    const parsed = schema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** The blocks a page can mark Not canon (F-16.6): paragraphs, and the headings an upload keeps. */
export const NOT_CANON_BLOCKS: ReadonlySet<string> = new Set(['paragraph', 'heading'])

/** The `notCanon` attribute, the same on a page paragraph and a page heading. */
const notCanonAttribute = {
  default: false,
  parseHTML: (element: HTMLElement) => element.hasAttribute('data-not-canon'),
  renderHTML: (attributes: Record<string, unknown>) =>
    attributes[NOT_CANON_ATTR] === true ? { 'data-not-canon': '' } : {}
}

/** Whether a block carries an `aiFiled` or `aiWritten` mark. */
const hasAiMark = (node: PmNode): boolean =>
  AI_MARK_ATTRS.some((attr) => node.attrs[attr] !== null && node.attrs[attr] !== undefined)

/**
 * The positions in `tr.doc` of the marked blocks near what `tr` replaced: each replaced range,
 * mapped forward through the rest of `tr`'s steps and widened by one on each side, so a block
 * the edit split, joined or reached the edge of is looked at. Attribute and mark steps replace
 * nothing, so toggling Not canon or making text bold has no candidates.
 */
function markedBlocksNear(tr: Transaction): number[] {
  const doc = tr.doc
  const found = new Set<number>()
  tr.mapping.maps.forEach((map, index) => {
    const rest = tr.mapping.slice(index + 1)
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      const from = Math.max(0, rest.map(newStart, -1) - 1)
      const to = Math.min(doc.content.size, rest.map(newEnd, 1) + 1)
      doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isTextblock) return true
        if (hasAiMark(node)) found.add(pos)
        return false
      })
    })
  })
  return [...found]
}

/** A block's words as the author reads them: its text, a line break as a newline, any other leaf a mark. */
const wordsOf = (node: PmNode): string =>
  node.textBetween(0, node.content.size, '\n', (leaf) =>
    leaf.type.name === 'hardBreak' ? '\n' : '\ufffc'
  )

/**
 * Whether the block `node` at `pos` of `tr.doc` holds the very words of one whole block of the
 * document before `tr`. Its content is mapped back through `tr`: an Enter at its end or start, or
 * a Backspace on an empty line after it, leaves it exactly one old block with the same text; an
 * edit inside it, a join with a neighbour, or a split through its words does not.
 */
function keptItsWords(tr: Transaction, node: PmNode, pos: number): boolean {
  const back = tr.mapping.invert()
  const from = back.map(pos + 1, 1)
  const to = back.map(pos + 1 + node.content.size, -1)
  const before = tr.before
  if (from > to || to > before.content.size) return false
  const $from = before.resolve(from)
  const old = $from.parent
  return (
    old.type === node.type &&
    $from.parentOffset === 0 &&
    to === from + old.content.size &&
    wordsOf(old) === wordsOf(node)
  )
}

/**
 * The positions in the final document of the marked blocks whose words the author's own
 * transactions (not marked `MEMORY_PROGRAMMATIC_META`, not an undo or redo) changed: each such
 * transaction's changed blocks, mapped forward through every later transaction.
 */
function blocksTheAuthorChanged(transactions: readonly Transaction[]): number[] {
  let changed: number[] = []
  for (const tr of transactions) {
    changed = changed.flatMap((pos) => {
      const mapped = tr.mapping.mapResult(pos, 1)
      return mapped.deleted ? [] : [mapped.pos]
    })
    // An undo or redo puts back what was there, marks included; it is not a new edit.
    if (!tr.docChanged || tr.getMeta(MEMORY_PROGRAMMATIC_META) === true) continue
    if (isHistoryTransaction(tr)) continue
    for (const pos of markedBlocksNear(tr)) {
      const node = tr.doc.nodeAt(pos)
      if (node !== null && !keptItsWords(tr, node, pos)) changed.push(pos)
    }
  }
  return [...new Set(changed)].sort((a, b) => a - b)
}

/**
 * `clearAiMarks`: after the author changes a block's words, its `aiFiled` and `aiWritten` marks go
 * (it is hers now; the rule main applies with `withoutAiMarks`). A block whose words stayed as
 * they were keeps them, so pressing Enter after a filed line, or Backspace on the empty line
 * below it, leaves its mark. Written as attribute steps, so the clearing changes no text, never
 * triggers itself, and undoes together with the edit that caused it.
 */
export function clearAiMarksTransaction(
  transactions: readonly Transaction[],
  state: EditorState
): Transaction | null {
  let tr: Transaction | null = null
  for (const pos of blocksTheAuthorChanged(transactions)) {
    const node = state.doc.nodeAt(pos)
    if (!node?.isTextblock) continue
    for (const attr of AI_MARK_ATTRS) {
      if (node.attrs[attr] === null || node.attrs[attr] === undefined) continue
      tr ??= state.tr
      tr.setNodeAttribute(pos, attr, null)
    }
  }
  return tr
}

/**
 * The page heading's Not canon mark (F-16.6): an upload keeps its headings, and a heading inside
 * a section the author marks Not canon is no more true than the paragraphs under it. Only the
 * page schema has it (`buildPageExtensions`), so manuscript headings are unchanged.
 */
export const PageHeadingMarks = Extension.create({
  name: 'pageHeadingMarks',
  addGlobalAttributes() {
    return [{ types: ['heading'], attributes: { [NOT_CANON_ATTR]: notCanonAttribute } }]
  }
})

export const PageParagraph = OriginParagraph.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      [NOT_CANON_ATTR]: notCanonAttribute,
      [AI_FILED_ATTR]: {
        default: null,
        keepOnSplit: false,
        parseHTML: (element: HTMLElement) =>
          jsonAttr(element.getAttribute('data-ai-filed'), AiFiled),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes[AI_FILED_ATTR] === null || attributes[AI_FILED_ATTR] === undefined
            ? {}
            : { 'data-ai-filed': JSON.stringify(attributes[AI_FILED_ATTR]) }
      },
      [AI_WRITTEN_ATTR]: {
        default: null,
        keepOnSplit: false,
        parseHTML: (element: HTMLElement) =>
          jsonAttr(element.getAttribute('data-ai-written'), AiWritten),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes[AI_WRITTEN_ATTR] === null || attributes[AI_WRITTEN_ATTR] === undefined
            ? {}
            : { 'data-ai-written': JSON.stringify(attributes[AI_WRITTEN_ATTR]) }
      }
    }
  },

  addCommands() {
    return {
      ...this.parent?.(),
      toggleNotCanon:
        () =>
        ({ state, tr, dispatch }) => {
          const { from, to } = state.selection
          const positions: number[] = []
          state.doc.nodesBetween(from, to, (node, pos) => {
            if (NOT_CANON_BLOCKS.has(node.type.name)) {
              positions.push(pos)
              return false
            }
            return true
          })
          if (positions.length === 0) return false
          const every = positions.every(
            (pos) => state.doc.nodeAt(pos)?.attrs[NOT_CANON_ATTR] === true
          )
          if (dispatch) {
            for (const pos of positions) tr.setNodeAttribute(pos, NOT_CANON_ATTR, !every)
          }
          return true
        }
    }
  },

  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      new Plugin({
        key: new PluginKey('clearAiMarks'),
        appendTransaction: (transactions, _oldState, newState) =>
          clearAiMarksTransaction(transactions, newState)
      })
    ]
  }
})
