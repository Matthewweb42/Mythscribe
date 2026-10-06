import { getMarkRange, Mark, mergeAttributes, type Editor } from '@tiptap/core'
import type { Attrs, Mark as PmMark, Node as PmNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Tag } from '@shared/ipc/contract'
import { TAG_RANGE_MARK } from '@shared/tagRanges'
import type { TagAliases } from '@shared/tagExchange'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { tokenTag } from './InlineTag'

/** The DOM attribute every range span carries; the right-click handler and the e2e test select on it. */
export const TAG_RANGE_SELECTOR = '[data-tag-range]'
/** The class of a decorated text run: the stylesheet sizes the stacked lines its inline style paints. */
export const TAG_RANGE_RUN_CLASS = 'tag-range-run'
/** The class of a top-level block holding a range: the stylesheet draws the gutter bar. */
export const TAG_RANGE_BLOCK_CLASS = 'tag-range-block'
/** The gap between two stacked range lines under a run, and each line's thickness, in pixels. */
const LINE_STEP = 3
const LINE_WIDTH = 2

export interface TagRangeOptions {
  /** Runs on Mod+Alt+T with a non-empty selection: the editor opens the tag picker for it. */
  onTagSelection: ((editor: Editor) => void) | null
}

/** A stretch of text carrying the same set of range marks, by stored tag id in mark order. */
export interface TagRun {
  from: number
  to: number
  tagIds: string[]
}

/** A top-level block holding at least one range: its tags in first-appearance order. */
export interface BlockTags {
  from: number
  to: number
  tagIds: string[]
}

export const TAG_RANGE_KEY = new PluginKey<DecorationSet>('tagRange')

/** The transaction metadata that asks for a repaint without a document change (the bank changed). */
const REFRESH = 'refresh'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    tagRange: {
      /** Tag the selected text with `tagId` (F-4.8); false for an empty selection. */
      setTagRange: (tagId: string) => ReturnType
      /** Remove every tag range from the selected text; false for an empty selection. */
      clearTagRanges: () => ReturnType
      /** Remove, whole, every tag range covering the text at `pos` (a right-click without a selection). */
      clearTagRangesAt: (pos: number) => ReturnType
    }
  }
}

/** The stored tag id of a range mark, guarded: ProseMirror types `attrs` loosely. */
function readTagId(attrs: Attrs): string {
  const tagId: unknown = attrs.tagId
  return typeof tagId === 'string' ? tagId : ''
}

const isRange = (mark: PmMark): boolean => mark.type.name === TAG_RANGE_MARK

/** The stored tag ids on a text node, in mark order, without empties. */
function tagIdsOf(node: PmNode): string[] {
  return node.marks
    .filter(isRange)
    .map((mark) => readTagId(mark.attrs))
    .filter((id) => id !== '')
}

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i])

/**
 * Every run of text under at least one range (F-4.8), in document order; neighbouring text nodes
 * with the same tags (split only by bold or italic) form one run. Ids are as stored, not resolved.
 */
export function tagRunsOf(doc: PmNode): TagRun[] {
  const runs: TagRun[] = []
  doc.descendants((node, pos) => {
    if (!node.isText) return true
    const tagIds = tagIdsOf(node)
    if (tagIds.length === 0) return false
    const last = runs[runs.length - 1]
    if (last?.to === pos && sameIds(last.tagIds, tagIds)) last.to = pos + node.nodeSize
    else runs.push({ from: pos, to: pos + node.nodeSize, tagIds })
    return false
  })
  return runs
}

/** Every top-level block holding a range, with its stored tag ids in first-appearance order. */
export function blockTagsOf(doc: PmNode): BlockTags[] {
  const blocks: BlockTags[] = []
  doc.forEach((block, offset) => {
    const seen = new Set<string>()
    block.descendants((node) => {
      if (!node.isText) return true
      for (const id of tagIdsOf(node)) seen.add(id)
      return false
    })
    if (seen.size > 0) blocks.push({ from: offset, to: offset + block.nodeSize, tagIds: [...seen] })
  })
  return blocks
}

/**
 * The bank tags stored ids stand for now, without repeats: a merged tag paints as the tag it was
 * merged into (F-4.9), a deleted one paints nothing.
 */
function liveTags(ids: readonly string[], byId: Record<string, Tag>, aliases: TagAliases): Tag[] {
  const tags = new Map<string, Tag>()
  for (const id of ids) {
    const tag = tokenTag(id, byId, aliases)
    if (tag) tags.set(tag.id, tag)
  }
  return [...tags.values()]
}

/** One 2px line per tag under the run, stacked downwards, as an inline style. */
function runStyle(colors: readonly string[]): string {
  const images = colors.map((color) => `linear-gradient(${color}, ${color})`).join(', ')
  const positions = colors.map((_, i) => `0 calc(100% - ${i * LINE_STEP}px)`).join(', ')
  const padding = (colors.length - 1) * LINE_STEP + LINE_WIDTH
  return `background-image: ${images}; background-position: ${positions}; padding-bottom: ${padding}px`
}

/** The gutter bar's colours, as equal bands from top to bottom. */
function barStyle(colors: readonly string[]): string {
  const share = 100 / colors.length
  const stops = colors.map((color, i) => `${color} ${i * share}% ${(i + 1) * share}%`).join(', ')
  return `--range-colors: linear-gradient(to bottom, ${stops})`
}

/**
 * The overlay and the margin indicator (F-4.8) for a document, painted from the bank: each run
 * gets one line per live tag and a tooltip with their names, each block holding a live range a
 * gutter bar in its tags' colours. Ranges whose tag is gone paint nothing.
 */
export function tagRangeDecorations(
  doc: PmNode,
  byId: Record<string, Tag>,
  aliases: TagAliases
): DecorationSet {
  const decorations: Decoration[] = []
  for (const run of tagRunsOf(doc)) {
    const tags = liveTags(run.tagIds, byId, aliases)
    if (tags.length === 0) continue
    decorations.push(
      Decoration.inline(run.from, run.to, {
        class: TAG_RANGE_RUN_CLASS,
        style: runStyle(tags.map((tag) => tag.color)),
        title: tags.map((tag) => `#${tag.name}`).join(' ')
      })
    )
  }
  for (const block of blockTagsOf(doc)) {
    const tags = liveTags(block.tagIds, byId, aliases)
    if (tags.length === 0) continue
    decorations.push(
      Decoration.node(block.from, block.to, {
        class: TAG_RANGE_BLOCK_CLASS,
        style: barStyle(tags.map((tag) => tag.color))
      })
    )
  }
  return decorations.length === 0 ? DecorationSet.empty : DecorationSet.create(doc, decorations)
}

function decorate(doc: PmNode): DecorationSet {
  const bank = useTagStore.getState()
  return tagRangeDecorations(doc, bank.byId, bank.aliases)
}

/**
 * The tag range mark (F-4.8): a tag on a stretch of the author's text, stored in the document
 * (`{ tagId }`) so ProseMirror maps it through every edit. Excludes nothing, so different tags
 * overlap, while the same tag over touching or overlapping text joins into one range (equal
 * marks merge); not inclusive, so typing at a range's edge stays outside it. Renders as a
 * `<span data-tag-range data-tag-id>` and parses back from it, so copy and paste inside the app
 * keep the range. The colours are a decoration painted from the bank (repainted when the bank
 * changes, through a `refresh` transaction that neither autosaves nor enters the undo history),
 * so the compiled preview, which uses only the schema, shows plain text.
 */
export const TagRange = Mark.create<TagRangeOptions>({
  name: TAG_RANGE_MARK,
  inclusive: false,
  excludes: '',
  spanning: true,

  addOptions() {
    return { onTagSelection: null }
  },

  addAttributes() {
    return {
      tagId: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-tag-id') ?? '',
        renderHTML: (attributes) => ({ 'data-tag-id': readTagId(attributes) })
      }
    }
  },

  parseHTML() {
    return [{ tag: `span${TAG_RANGE_SELECTOR}` }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ 'data-tag-range': '' }, HTMLAttributes), 0]
  },

  addCommands() {
    return {
      setTagRange:
        (tagId) =>
        ({ state, tr, dispatch }) => {
          const { from, to, empty } = state.selection
          if (empty || tagId === '') return false
          if (dispatch) tr.addMark(from, to, this.type.create({ tagId }))
          return true
        },
      clearTagRanges:
        () =>
        ({ state, tr, dispatch }) => {
          const { from, to, empty } = state.selection
          if (empty) return false
          if (dispatch) tr.removeMark(from, to, this.type)
          return true
        },
      clearTagRangesAt:
        (pos) =>
        ({ state, tr, dispatch }) => {
          if (pos < 0 || pos > state.doc.content.size) return false
          const $pos = state.doc.resolve(pos)
          const marks = (state.doc.nodeAt(pos)?.marks ?? []).filter(isRange)
          if (marks.length === 0) return false
          if (dispatch) {
            for (const mark of marks) {
              const range = getMarkRange($pos, this.type, mark.attrs)
              if (range) tr.removeMark(range.from, range.to, mark)
            }
          }
          return true
        }
    }
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Alt-t': () => {
        if (this.editor.state.selection.empty || !this.options.onTagSelection) return false
        this.options.onTagSelection(this.editor)
        return true
      }
    }
  },

  addProseMirrorPlugins() {
    const type = this.type
    return [
      new Plugin<DecorationSet>({
        key: TAG_RANGE_KEY,
        state: {
          init: (_config, state) => decorate(state.doc),
          apply: (tr, value) =>
            tr.docChanged || tr.getMeta(TAG_RANGE_KEY) === REFRESH ? decorate(tr.doc) : value
        },
        props: {
          decorations(state) {
            return TAG_RANGE_KEY.getState(state) ?? DecorationSet.empty
          }
        },
        view(view) {
          let { byId, aliases } = useTagStore.getState()
          const off = useTagStore.subscribe((bank) => {
            if (view.isDestroyed || (bank.byId === byId && bank.aliases === aliases)) return
            byId = bank.byId
            aliases = bank.aliases
            // A document without ranges has nothing to repaint; skipping the transaction keeps
            // bank traffic (usage counts after every save) from ever touching its selection.
            const { doc } = view.state
            if (!doc.rangeHasMark(0, doc.content.size, type)) return
            view.dispatch(
              view.state.tr.setMeta(TAG_RANGE_KEY, REFRESH).setMeta('addToHistory', false)
            )
          })
          return { destroy: off }
        }
      })
    ]
  }
})
