import { isHistoryTransaction } from '@tiptap/pm/history'
import type { Node as PmNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import type { z } from 'zod'
import {
  AI_FILED_ATTR,
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
 *   maybe, never true; toggled with `toggleNotCanon`.
 * - `aiFiled` ({ doc, para, quote }) and `aiWritten` ({ turn, date }): the paragraph came from a
 *   filed upload or from the chat. `clearAiMarks` drops both once the author edits its text;
 *   the app's own writes carry the `MEMORY_PROGRAMMATIC_META` meta and leave them alone.
 */

/** Transaction meta the app sets on its own writes to a page, so `clearAiMarks` leaves its marks. */
export const MEMORY_PROGRAMMATIC_META = 'memoryProgrammatic'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    pageParagraph: {
      /**
       * Marks the paragraphs the selection touches Not canon, or, when every one of them already
       * is, takes the mark off.
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

/** The paragraphs (by position) whose text the range [from, to] of `doc` touches. */
function paragraphsTouched(doc: PmNode, from: number, to: number, into: Set<number>): void {
  const start = Math.max(0, Math.min(from, to) - 1)
  const end = Math.min(doc.content.size, Math.max(from, to) + 1)
  doc.nodesBetween(start, end, (node, pos) => {
    if (node.type.name === 'paragraph') {
      into.add(pos)
      return false
    }
    return true
  })
}

/**
 * The ranges of the final document that the author's own transactions (not marked
 * `MEMORY_PROGRAMMATIC_META`, not an undo or redo) replaced, each mapped forward through every
 * later step. Attribute and mark steps replace nothing, so toggling Not canon or making text bold
 * changes no text.
 */
function authorRanges(transactions: readonly Transaction[]): [number, number][] {
  let ranges: [number, number][] = []
  for (const tr of transactions) {
    ranges = ranges.map(([from, to]) => [tr.mapping.map(from, -1), tr.mapping.map(to, 1)])
    // An undo or redo puts back what was there, marks included; it is not a new edit.
    if (!tr.docChanged || tr.getMeta(MEMORY_PROGRAMMATIC_META) === true) continue
    if (isHistoryTransaction(tr)) continue
    tr.mapping.maps.forEach((map, index) => {
      const rest = tr.mapping.slice(index + 1)
      map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
        ranges.push([rest.map(newStart, -1), rest.map(newEnd, 1)])
      })
    })
  }
  return ranges
}

/**
 * `clearAiMarks`: after the author changes a paragraph's text, its `aiFiled` and `aiWritten`
 * marks go (it is hers now). Written as attribute steps, so the clearing changes no text, never
 * triggers itself, and undoes together with the edit that caused it.
 */
export function clearAiMarksTransaction(
  transactions: readonly Transaction[],
  state: EditorState
): Transaction | null {
  const ranges = authorRanges(transactions)
  if (ranges.length === 0) return null
  const touched = new Set<number>()
  for (const [from, to] of ranges) paragraphsTouched(state.doc, from, to, touched)
  let tr: Transaction | null = null
  for (const pos of [...touched].sort((a, b) => a - b)) {
    const node = state.doc.nodeAt(pos)
    if (node === null) continue
    for (const attr of [AI_FILED_ATTR, AI_WRITTEN_ATTR]) {
      if (node.attrs[attr] === null || node.attrs[attr] === undefined) continue
      tr ??= state.tr
      tr.setNodeAttribute(pos, attr, null)
    }
  }
  return tr
}

export const PageParagraph = OriginParagraph.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      [NOT_CANON_ATTR]: {
        default: false,
        parseHTML: (element: HTMLElement) => element.hasAttribute('data-not-canon'),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes[NOT_CANON_ATTR] === true ? { 'data-not-canon': '' } : {}
      },
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
            if (node.type.name === this.name) {
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
