import { Extension } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { create } from 'zustand'
import { passageParagraphs } from '@shared/mentions'
import type { UnderlineView } from '@shared/memory/underlines'
import { TiptapNode } from '@shared/tiptap'
import { locateEvery } from './locateText'

/**
 * Contradiction underlines in the editor (F-16.28; design §2.4 "Underlines", plan P4 §5.2,
 * P4-D15): story memory v2's open findings drawn as soft underlines on their quotes, from what
 * main picked for the scene (`SceneMemory.underlines`: at most 3, never in a paragraph with an
 * unread change). They are decorations only, never marks: nothing is saved in the document, the
 * undo history never sees them, and `getJSON` holds none. Each quote is found again inside its
 * paragraph (`passageParagraphs` numbering, `locateEvery`), so a quote that moved or changed is
 * simply not drawn. Never at the caret: while the editor has the focus, the paragraph holding the
 * selection head shows none. A paragraph the author edits loses its underlines until the next
 * refresh (an unread change, as main will also say); a refresh while the document still has
 * unsaved edits keeps those paragraphs bare. Hovering an underline (or clicking it, or Alt+Enter
 * with the caret in its paragraph) opens the hover card (`ContradictionCard`) with the other
 * quote. The extension draws and reports what it drew (`onDrawn`); `useContradictionMarks` feeds
 * it from the memory store. Story memory v2's manuscript editors only.
 */

/** The class an underlined quote carries; the stylesheet draws it and the e2e reads it. */
export const CONTRADICTION_CLASS = 'ms-contradiction'

export const CONTRADICTION_MARKS_KEY = new PluginKey<MarksState>('contradictionMarks')

/** How long the hover card stays once the pointer has left the underline and the card. */
export const CARD_CLOSE_DELAY_MS = 250

/** The hover card, open beside one underline (one at a time). */
export interface ContradictionCardOpen {
  underline: UnderlineView
  /** The scene whose underline it is. */
  nodeId: string
  /** Where it opens (viewport px): under the underline, or under the caret. */
  x: number
  y: number
  /** Opened by a click or the keyboard: stays until Escape, a click outside or an answer. */
  pinned: boolean
  /** Opened from the keyboard: the card takes the focus, and gives it back on Escape. */
  keyboard: boolean
  /** Puts the focus back in the editor (Escape after a keyboard open). */
  returnFocus: () => void
}

interface ContradictionCardState {
  card: ContradictionCardOpen | null
  open: (card: ContradictionCardOpen) => void
  close: () => void
  /** The pointer left the underline or the card: closes soon, unless it comes back or is pinned. */
  scheduleClose: () => void
  cancelClose: () => void
}

let closeTimer: ReturnType<typeof setTimeout> | null = null
const clearCloseTimer = (): void => {
  if (closeTimer !== null) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
}

export const useContradictionCardStore = create<ContradictionCardState>((set, get) => ({
  card: null,
  open: (card) => {
    clearCloseTimer()
    const was = get().card
    // A hover never unpins a card a click or the keyboard opened on the same underline.
    if (
      was !== null &&
      was.pinned &&
      !card.pinned &&
      was.underline.findingId === card.underline.findingId &&
      was.underline.side === card.underline.side
    ) {
      return
    }
    set({ card })
  },
  close: () => {
    clearCloseTimer()
    if (get().card !== null) set({ card: null })
  },
  scheduleClose: () => {
    if (get().card?.pinned !== false) return
    clearCloseTimer()
    closeTimer = setTimeout(() => {
      closeTimer = null
      if (get().card?.pinned === false) set({ card: null })
    }, CARD_CLOSE_DELAY_MS)
  },
  cancelClose: clearCloseTimer
}))

/** Closes the hover card. For tests only. */
export function resetContradictionCardStore(): void {
  clearCloseTimer()
  useContradictionCardStore.setState({ card: null })
}

/** What the editor tells its feeder. */
export interface ContradictionMarksStorage {
  /** The scene the editor shows (the card's `nodeId`). */
  nodeId: string
  /** The findings drawn now changed: their ids (`memory:underlinesShown` for the new ones). */
  onDrawn: ((findingIds: string[]) => void) | null
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    contradictionMarks: {
      /**
       * The scene's underlines as main picked them; an empty list clears them. `keepEdited`: the
       * document has unsaved edits, so the paragraphs edited since the last set stay bare.
       */
      setContradictionMarks: (
        underlines: readonly UnderlineView[],
        options?: { keepEdited?: boolean }
      ) => ReturnType
    }
  }

  interface Storage {
    /** Present only for story memory v2's manuscript editors. */
    contradictionMarks?: ContradictionMarksStorage
  }
}

/** One underline found in the document. */
interface Located {
  underline: UnderlineView
  from: number
  to: number
}

interface MarksState {
  /** The underlines found in the document now (mapped through edits; an edited paragraph's dropped). */
  located: Located[]
  /** A position inside each paragraph edited since the last set (mapped through edits). */
  edited: number[]
  /** The editor has the focus (Tiptap's focus and blur transactions say so). */
  focused: boolean
  decorations: DecorationSet
}

interface SetMeta {
  underlines: readonly UnderlineView[]
  keepEdited: boolean
}

/** The text block holding `pos`, as [start, end] content positions; null outside one. */
function blockAt(doc: PmNode, pos: number): [number, number] | null {
  if (pos < 0 || pos > doc.content.size) return null
  const $pos = doc.resolve(pos)
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).isTextblock) return [$pos.start(depth), $pos.end(depth)]
  }
  return null
}

const within = (block: [number, number] | null, pos: number): boolean =>
  block !== null && block[0] <= pos && pos <= block[1]

/** Each underline's quote found inside its paragraph (`passageParagraphs` numbering). */
function locate(doc: PmNode, underlines: readonly UnderlineView[]): Located[] {
  if (underlines.length === 0) return []
  const json = TiptapNode.safeParse(doc.toJSON())
  if (!json.success) return []
  const paragraphs = passageParagraphs(json.data)
  const located: Located[] = []
  for (const underline of underlines) {
    const paragraph = paragraphs[underline.para]
    if (paragraph === undefined) continue
    const range = locateEvery(doc, underline.quote).find(
      (each) => each.from >= paragraph.from && each.to <= paragraph.to
    )
    if (range === undefined) continue
    if (located.some((other) => range.from < other.to && other.from < range.to)) continue
    located.push({ underline, ...range })
  }
  return located.sort((a, b) => a.from - b.from)
}

/** The ranges a transaction changed, in the new document's positions. */
function changedRanges(tr: Transaction): [number, number][] {
  const ranges: [number, number][] = []
  tr.mapping.maps.forEach((map, index) => {
    const after = tr.mapping.slice(index + 1)
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      ranges.push([after.map(newStart, -1), after.map(newEnd, 1)])
    })
  })
  return ranges
}

/** The decorations to draw: every located underline but those in the caret's paragraph. */
function draw(state: Pick<MarksState, 'located' | 'focused'>, editorState: EditorState): DecorationSet {
  const { doc, selection } = editorState
  const caret = state.focused ? blockAt(doc, selection.head) : null
  const decorations = state.located
    .filter((each) => !within(caret, each.from))
    .map((each) =>
      Decoration.inline(
        each.from,
        each.to,
        {
          class: CONTRADICTION_CLASS,
          'data-finding': each.underline.findingId,
          'data-side': each.underline.side
        },
        { findingId: each.underline.findingId }
      )
    )
  return DecorationSet.create(doc, decorations)
}

function apply(tr: Transaction, prev: MarksState, state: EditorState): MarksState {
  let { located, edited, focused } = prev
  let moved = false
  if (tr.getMeta('focus') !== undefined) {
    focused = true
    moved = true
  }
  if (tr.getMeta('blur') !== undefined) {
    focused = false
    moved = true
  }
  if (tr.docChanged) {
    moved = true
    const changed = changedRanges(tr)
    const touched = (block: [number, number] | null): boolean =>
      block !== null && changed.some(([from, to]) => from <= block[1] && block[0] <= to)
    edited = edited.flatMap((pos) => {
      const mapped = tr.mapping.mapResult(pos)
      return mapped.deleted ? [] : [mapped.pos]
    })
    // One position per edited paragraph, so typing never grows the list.
    for (const [from] of changed) {
      const block = blockAt(tr.doc, from)
      if (block !== null && !edited.some((pos) => within(block, pos))) edited.push(from)
    }
    located = located.flatMap((each) => {
      const from = tr.mapping.mapResult(each.from, 1)
      const to = tr.mapping.mapResult(each.to, -1)
      if (from.deleted || to.deleted || to.pos <= from.pos) return []
      // An edit in the underline's paragraph: an unread change; it waits for the next refresh.
      if (touched(blockAt(tr.doc, from.pos))) return []
      return [{ ...each, from: from.pos, to: to.pos }]
    })
  }
  const meta = tr.getMeta(CONTRADICTION_MARKS_KEY) as SetMeta | undefined
  if (meta !== undefined) {
    moved = true
    if (!meta.keepEdited) edited = []
    const bare = edited.map((pos) => blockAt(tr.doc, pos))
    located = locate(tr.doc, meta.underlines).filter(
      (each) => !bare.some((block) => within(block, each.from))
    )
  }
  if (!moved && !tr.selectionSet) return prev
  const next = { located, edited, focused }
  return { ...next, decorations: draw(next, state) }
}

/** The underline at a position (drawn or hidden at the caret), if any. */
function underlineAt(view: EditorView, pos: number): Located | null {
  const state = CONTRADICTION_MARKS_KEY.getState(view.state)
  return state?.located.find((each) => each.from <= pos && pos <= each.to) ?? null
}

/** The underline in the paragraph holding the caret, if any (Alt+Enter). */
function underlineAtCaret(view: EditorView): Located | null {
  const state = CONTRADICTION_MARKS_KEY.getState(view.state)
  const block = blockAt(view.state.doc, view.state.selection.head)
  return state?.located.find((each) => within(block, each.from)) ?? null
}

/** Opens the hover card beside an underline. */
function openCard(
  view: EditorView,
  nodeId: string,
  at: Located,
  where: { x: number; y: number },
  mode: { pinned: boolean; keyboard: boolean }
): void {
  useContradictionCardStore.getState().open({
    underline: at.underline,
    nodeId,
    x: where.x,
    y: where.y,
    pinned: mode.pinned,
    keyboard: mode.keyboard,
    returnFocus: () => {
      if (!view.isDestroyed) view.focus()
    }
  })
}

/** The underline span under a DOM event, inside this editor. */
function spanOf(view: EditorView, target: EventTarget | null): HTMLElement | null {
  const span =
    target instanceof Element ? target.closest<HTMLElement>(`.${CONTRADICTION_CLASS}`) : null
  return span !== null && view.dom.contains(span) ? span : null
}

export const ContradictionMarks = Extension.create<{ nodeId: string }, ContradictionMarksStorage>({
  name: 'contradictionMarks',

  addOptions() {
    return { nodeId: '' }
  },

  addStorage() {
    return { nodeId: this.options.nodeId, onDrawn: null }
  },

  addCommands() {
    return {
      setContradictionMarks:
        (underlines, options) =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(CONTRADICTION_MARKS_KEY, {
              underlines,
              keepEdited: options?.keepEdited === true
            } satisfies SetMeta)
            tr.setMeta('addToHistory', false)
          }
          return true
        }
    }
  },

  addKeyboardShortcuts() {
    return {
      'Alt-Enter': () => {
        const view = this.editor.view
        const at = underlineAtCaret(view)
        if (at === null) return false
        const coords = view.coordsAtPos(view.state.selection.head)
        openCard(
          view,
          this.storage.nodeId,
          at,
          { x: coords.left, y: coords.bottom + 4 },
          { pinned: true, keyboard: true }
        )
        return true
      }
    }
  },

  addProseMirrorPlugins() {
    const storage = this.storage
    return [
      new Plugin<MarksState>({
        key: CONTRADICTION_MARKS_KEY,
        state: {
          init: (_config, state) => {
            const empty = { located: [], edited: [], focused: false }
            return { ...empty, decorations: draw(empty, state) }
          },
          apply: (tr, prev, _old, state) => apply(tr, prev, state)
        },
        props: {
          decorations(state) {
            return CONTRADICTION_MARKS_KEY.getState(state)?.decorations ?? DecorationSet.empty
          },
          handleClick(view, pos, event) {
            const at = underlineAt(view, pos)
            if (at === null) return false
            openCard(
              view,
              storage.nodeId,
              at,
              { x: event.clientX, y: event.clientY + 12 },
              { pinned: true, keyboard: false }
            )
            // The caret goes where she clicked, as ever.
            return false
          },
          handleDOMEvents: {
            mouseover: (view, event) => {
              const span = spanOf(view, event.target)
              if (span === null) return false
              const pos = view.posAtDOM(span, 0)
              const at = underlineAt(view, pos)
              if (at === null) return false
              const rect = span.getBoundingClientRect()
              openCard(
                view,
                storage.nodeId,
                at,
                { x: rect.left, y: rect.bottom + 4 },
                { pinned: false, keyboard: false }
              )
              return false
            },
            mouseout: (view, event) => {
              if (spanOf(view, event.target) === null) return false
              const to = event.relatedTarget
              if (to instanceof Element && to.closest('[data-contradiction-card]') !== null) {
                return false
              }
              useContradictionCardStore.getState().scheduleClose()
              return false
            }
          }
        },
        view() {
          let drawn = ''
          return {
            update(view) {
              const state = CONTRADICTION_MARKS_KEY.getState(view.state)
              const ids = [
                ...new Set(
                  (state?.decorations.find() ?? []).map(
                    (each) => (each.spec as { findingId: string }).findingId
                  )
                )
              ].sort()
              const key = ids.join('|')
              if (key === drawn) return
              drawn = key
              if (ids.length > 0) storage.onDrawn?.(ids)
            }
          }
        }
      })
    ]
  }
})
