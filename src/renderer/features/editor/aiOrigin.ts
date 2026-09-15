import { Mark, mergeAttributes } from '@tiptap/core'
import type { Attrs, Mark as PmMark, MarkType, Node as PmNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import {
  AI_ORIGIN_KEEP_RATIO,
  AI_ORIGIN_MARK,
  aiOriginAttrsOf,
  type AiOriginAttrs
} from '@shared/provenance'

/** The class every AI-origin span carries; the stylesheet underlines it and the e2e test reads it. */
export const AI_ORIGIN_CLASS = 'ai-origin'
/** The DOM attribute every AI-origin span carries. */
export const AI_ORIGIN_SELECTOR = '[data-ai-origin]'

/** The plugin's state: whether the document holds any AI-origin span, so unmarked documents pay nothing per edit. */
interface AiOriginPluginState {
  marked: boolean
}

/** The one meta this plugin reads: a transaction that inserted AI text through `markAiOrigin` vouches for its marks. */
interface AiOriginMeta {
  type: 'insert'
}

export const AI_ORIGIN_KEY = new PluginKey<AiOriginPluginState>('aiOrigin')

interface Range {
  from: number
  to: number
}

/** The stored attrs of a mark, guarded: ProseMirror types `attrs` loosely. */
function readAttrs(attrs: Attrs): AiOriginAttrs {
  const proposalId: unknown = attrs.proposalId
  const accepted: unknown = attrs.accepted
  return {
    proposalId: typeof proposalId === 'string' ? proposalId : '',
    accepted: typeof accepted === 'number' && Number.isFinite(accepted) ? accepted : 0
  }
}

/** The provenance attrs of a ProseMirror mark, or null for any other mark or a malformed one. */
export function aiOriginOf(mark: PmMark): AiOriginAttrs | null {
  return aiOriginAttrsOf({ type: mark.type.name, attrs: mark.attrs })
}

/**
 * Marks `[from, to)` as accepted from `proposalId` (F-14.6) and vouches for the transaction, so
 * the plugin's strip leaves this insertion alone. `accepted` is the running total of characters
 * the author has accepted from the proposal, this range included; a run the same proposal
 * marked right before `from` (an earlier word of the same suggestion) is re-marked with the
 * new total so word-by-word acceptance yields one span. Without the mark in the schema (notes)
 * nothing happens.
 */
export function markAiOrigin(
  tr: Transaction,
  from: number,
  to: number,
  attrs: AiOriginAttrs
): void {
  const type = tr.doc.type.schema.marks[AI_ORIGIN_MARK]
  if (!type || from >= to) return
  const before = tr.doc.resolve(from).nodeBefore
  const start =
    before?.isText && before.marks.some((m) => aiOriginOf(m)?.proposalId === attrs.proposalId)
      ? from - before.nodeSize
      : from
  tr.addMark(start, to, type.create(attrs))
  tr.setMeta(AI_ORIGIN_KEY, { type: 'insert' } satisfies AiOriginMeta)
}

/**
 * The ranges a transaction inserted, as positions in its final document: each step map's new
 * ranges, mapped through the steps that follow it.
 */
function insertedRanges(tr: Transaction): Range[] {
  const ranges: Range[] = []
  tr.mapping.maps.forEach((map, i) => {
    const rest = tr.mapping.slice(i + 1)
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      const from = rest.map(newStart, 1)
      const to = rest.map(newEnd, -1)
      if (from < to) ranges.push({ from, to })
    })
  })
  return ranges
}

/**
 * Whether the plugin should leave a transaction's marks as they are: the ghost's own insertion
 * (vouched through `markAiOrigin`), undo and redo (they restore a state that was already
 * consistent), and paste or drop (AI text moved or copied within the app is still AI text).
 */
function keepsMarks(tr: Transaction): boolean {
  if (tr.getMeta(AI_ORIGIN_KEY) !== undefined) return true
  // prosemirror-history's key ('history' + '$'), set on every undo and redo transaction.
  if (tr.getMeta('history$') !== undefined) return true
  const uiEvent: unknown = tr.getMeta('uiEvent')
  return uiEvent === 'paste' || uiEvent === 'drop'
}

interface ProposalRun {
  chars: number
  accepted: number
  ranges: Range[]
}

/** Every AI-origin span in the document, grouped by proposal, with the surviving character count. */
function collectRuns(doc: PmNode): Map<string, ProposalRun> {
  const runs = new Map<string, ProposalRun>()
  doc.descendants((node, pos) => {
    if (!node.isText) return true
    const attrs = node.marks.map(aiOriginOf).find((a) => a !== null) ?? null
    if (attrs === null) return false
    const run = runs.get(attrs.proposalId) ?? { chars: 0, accepted: 0, ranges: [] }
    run.chars += node.text?.length ?? 0
    run.accepted = Math.max(run.accepted, attrs.accepted)
    run.ranges.push({ from: pos, to: pos + node.nodeSize })
    runs.set(attrs.proposalId, run)
    return false
  })
  return runs
}

const hasAny = (doc: PmNode, type: MarkType): boolean => doc.rangeHasMark(0, doc.content.size, type)

/**
 * The provenance plugin (F-14.6). After every edit that changed the document: strip the mark
 * from whatever the author inserted (typing inside an AI span splits it, the typed text is the
 * author's), then clear every span of a proposal whose surviving characters fell under
 * `AI_ORIGIN_KEEP_RATIO` of what was accepted (what remains is the author's rewrite). Both go
 * into one appended transaction, so undo takes them back together with the edit. The `marked`
 * flag gates all of it: a document without AI text never walks its content.
 */
function aiOriginPlugin(type: MarkType): Plugin<AiOriginPluginState> {
  return new Plugin<AiOriginPluginState>({
    key: AI_ORIGIN_KEY,
    state: {
      init: (_config, state) => ({ marked: hasAny(state.doc, type) }),
      apply: (tr, value) => {
        if (!tr.docChanged) return value
        if (value.marked) return { marked: hasAny(tr.doc, type) }
        // Unmarked so far: only what this transaction inserted can carry the mark.
        return { marked: insertedRanges(tr).some((r) => tr.doc.rangeHasMark(r.from, r.to, type)) }
      }
    },
    appendTransaction: (transactions, _oldState, newState) => {
      if (!AI_ORIGIN_KEY.getState(newState)?.marked) return null
      if (!transactions.some((tr) => tr.docChanged)) return null
      const appended = newState.tr
      transactions.forEach((tr, i) => {
        if (!tr.docChanged || keepsMarks(tr)) return
        for (const range of insertedRanges(tr)) {
          let { from, to } = range
          for (const later of transactions.slice(i + 1)) {
            from = later.mapping.map(from, 1)
            to = later.mapping.map(to, -1)
          }
          if (from < to && newState.doc.rangeHasMark(from, to, type)) {
            appended.removeMark(from, to, type)
          }
        }
      })
      // Mark steps never move positions, so the runs collected now stay valid while they are cleared.
      for (const run of collectRuns(appended.doc).values()) {
        if (run.chars >= run.accepted * AI_ORIGIN_KEEP_RATIO) continue
        for (const range of run.ranges) appended.removeMark(range.from, range.to, type)
      }
      return appended.steps.length > 0 ? appended : null
    }
  })
}

/**
 * The AI-origin mark (F-14.6): text the author accepted from an AI proposal, carrying the
 * proposal's id and the running count of characters accepted from it. Not inclusive, so typing
 * at a span's edge is the author's. Renders as `<span data-ai-origin data-proposal-id
 * data-accepted class="ai-origin">` (a dotted underline in the stylesheet, never loud) and
 * parses back from it, so copy and paste inside the app keep the provenance. The plugin keeps
 * the rule that author text is never marked; only `markAiOrigin` adds the mark.
 */
export const AiOrigin = Mark.create({
  name: AI_ORIGIN_MARK,
  inclusive: false,

  addAttributes() {
    return {
      proposalId: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-proposal-id') ?? '',
        renderHTML: (attributes) => ({ 'data-proposal-id': readAttrs(attributes).proposalId })
      },
      accepted: {
        default: 0,
        parseHTML: (element) => Number(element.getAttribute('data-accepted')) || 0,
        renderHTML: (attributes) => ({ 'data-accepted': String(readAttrs(attributes).accepted) })
      }
    }
  },

  parseHTML() {
    return [{ tag: `span${AI_ORIGIN_SELECTOR}` }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes({ 'data-ai-origin': '', class: AI_ORIGIN_CLASS }, HTMLAttributes),
      0
    ]
  },

  addProseMirrorPlugins() {
    return [aiOriginPlugin(this.type)]
  }
})
