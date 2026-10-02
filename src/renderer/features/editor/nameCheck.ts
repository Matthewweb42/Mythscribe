import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { create } from 'zustand'
import type { Entity, Tag } from '@shared/ipc/contract'
import { buildNameIndex, nearName, wordsIn, type NameIndex } from '@shared/storyNames'
import type { TagCategory } from '@shared/tags'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { isWordMisspelled } from '@renderer/lib/spellcheck'
import { useDictionaryStore } from './dictionaryStore'

/**
 * The near-name menu (F-3.14): where the right-click landed, the word under it, the known
 * spelling it is offered, and how to put that spelling in its place. `SpellcheckMenu` renders it;
 * the plugin below opens it. Never more than one, and never beside the spelling menu.
 */
export interface NameMenu {
  x: number
  y: number
  /** The word as it stands in the manuscript. */
  word: string
  /** The story name it is one or two letters from, capitalized the way the word was typed. */
  spelling: string
  /** Replaces exactly that word with `spelling` and gives the editor the focus back. */
  replace: () => void
}

interface NameMenuState {
  menu: NameMenu | null
  open: (menu: NameMenu) => void
  close: () => void
}

export const useNameMenuStore = create<NameMenuState>((set) => ({
  menu: null,
  open: (menu) => set({ menu }),
  close: () => set({ menu: null })
}))

/** Closes the near-name menu. For tests only. */
export function resetNameMenuStore(): void {
  useNameMenuStore.setState({ menu: null })
}

export const NAME_CHECK_KEY = new PluginKey<DecorationSet>('nameCheck')

/** The class a near miss carries; the stylesheet draws the quiet underline. */
export const NAME_NEAR_MISS_CLASS = 'name-near-miss'

/** The transaction metadata that asks for a rescan without a document change. */
const REFRESH = 'refresh'

/** What a decoration remembers about its word, for the menu. */
interface NearMiss {
  word: string
  spelling: string
}

/** The tag categories whose tags name something in the story; the others are plain accepted words. */
const NAME_TAG_CATEGORIES: ReadonlySet<TagCategory> = new Set<TagCategory>([
  'character',
  'setting',
  'worldBuilding'
])

/** What the index was built from, by identity, with the answers given since. */
interface IndexCache {
  entities: Record<string, Entity>
  tags: Record<string, Tag>
  words: string[] | null
  notNames: string[] | null
  index: NameIndex
  /** Word as typed → the name it is near, or null. Dropped with the index. */
  near: Map<string, string | null>
}

let cache: IndexCache | null = null

/**
 * The name index for what the three stores hold now, shared by every open editor and rebuilt
 * only when the entities, the tags, or the dictionary changed identity. The per-word answers
 * live and die with it, so typing costs one lookup per word already seen.
 */
function currentIndex(): IndexCache {
  const entities = useEntityStore.getState().byId
  const tags = useTagStore.getState().byId
  const { words, notNames } = useDictionaryStore.getState()
  if (
    cache !== null &&
    cache.entities === entities &&
    cache.tags === tags &&
    cache.words === words &&
    cache.notNames === notNames
  ) {
    return cache
  }
  const nameTagNames: string[] = []
  const accepted: string[] = [...(words ?? []), ...(notNames ?? [])]
  for (const tag of Object.values(tags)) {
    if (NAME_TAG_CATEGORIES.has(tag.category)) nameTagNames.push(tag.name)
    else accepted.push(tag.name)
  }
  cache = {
    entities,
    tags,
    words,
    notNames,
    index: buildNameIndex({
      entityNames: Object.values(entities).map((entity) => entity.name),
      nameTagNames,
      accepted
    }),
    near: new Map()
  }
  return cache
}

/** Drops the shared index and its answers. For tests only. */
export function resetNameCheck(): void {
  cache = null
}

const LETTER = /[\p{L}\p{M}'’]/u

/**
 * Every near miss of the document as an inline decoration. Words are read per text node, so the
 * positions are exact and an inline tag token is never looked at; a word cut in two by a change
 * of marks is left alone rather than judged by its halves. A word counts when it is near a
 * story name and the spellchecker underlines it too: a real word of the language that happens
 * to sit one letter from a name ("mare", "Mara") stays as it is. The word the caret stands at the
 * end of is still being typed ("Marr" on the way to "Marra", or to "Mara"), so it is left alone
 * until the caret moves on: nothing is drawn or redrawn under the author's hands.
 */
function decorate({ doc, selection }: Pick<EditorState, 'doc' | 'selection'>): DecorationSet {
  const typingAt = selection.empty ? selection.head : -1
  const { index, near } = currentIndex()
  if (index.names.size === 0) return DecorationSet.empty
  const decorations: Decoration[] = []
  doc.descendants((node, pos, parent, at) => {
    const text = node.text
    if (!node.isText || text === undefined) return
    const before = at > 0 ? parent?.maybeChild(at - 1) : null
    const after = parent?.maybeChild(at + 1)
    const joinsBefore = before?.isText === true && LETTER.test(before.text?.slice(-1) ?? '')
    const joinsAfter = after?.isText === true && LETTER.test(after.text?.charAt(0) ?? '')
    for (const { from, to, word } of wordsIn(text)) {
      if ((from === 0 && joinsBefore) || (to === text.length && joinsAfter)) continue
      if (pos + to === typingAt) continue
      let spelling = near.get(word)
      if (spelling === undefined) {
        spelling = nearName(word, index)
        near.set(word, spelling)
      }
      // The spellchecker is asked every time, not remembered: its dictionary loads late.
      if (spelling === null || !isWordMisspelled(word)) continue
      decorations.push(
        Decoration.inline(
          pos + from,
          pos + to,
          { class: NAME_NEAR_MISS_CLASS, spellcheck: 'false', 'data-name': spelling },
          { word, spelling } satisfies NearMiss
        )
      )
    }
  })
  return DecorationSet.create(doc, decorations)
}

/** Opens the near-name menu for the decoration under a right-click; false when there is none. */
function openMenu(view: EditorView, event: MouseEvent): boolean {
  const span =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>(`.${NAME_NEAR_MISS_CLASS}`)
      : null
  if (!span || !view.dom.contains(span)) return false
  const pos = view.posAtDOM(span, 0)
  const found = NAME_CHECK_KEY.getState(view.state)
    ?.find(pos, pos + 1)
    .find((decoration) => decoration.from <= pos && pos < decoration.to)
  if (!found) return false
  const { word, spelling } = found.spec as NearMiss
  const { from, to } = found
  event.preventDefault()
  useNameMenuStore.getState().open({
    x: event.clientX,
    y: event.clientY,
    word,
    spelling,
    replace: () => {
      if (view.isDestroyed) return
      const { doc } = view.state
      // Only the word the menu was opened for: anything else there now is left alone.
      if (to > doc.content.size || doc.textBetween(from, to) !== word) return
      view.dispatch(view.state.tr.insertText(spelling, from, to))
      view.focus()
    }
  })
  return true
}

/**
 * Story names in the spellchecker, the renderer half (F-3.14): a word one or two letters from a
 * known entity or tag name gets a quiet underline, and its right-click menu offers the known
 * spelling and `Not a name`. The underline is a decoration, never part of the document; it is
 * rebuilt when the document or the caret changes and when the names or the dictionary do (a `refresh`
 * transaction with no document change, so nothing autosaves and nothing enters the undo
 * history). The span carries `spellcheck="false"`, so the browser's own red underline does not
 * sit under it and main's spelling menu never fires for it. All of it is local string work: no
 * AI, no request, whatever the dial says.
 */
export const NameCheck = Extension.create({
  name: 'nameCheck',

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: NAME_CHECK_KEY,
        state: {
          init: (_config, state) => decorate(state),
          apply: (tr, value) =>
            tr.docChanged || tr.selectionSet || tr.getMeta(NAME_CHECK_KEY) === REFRESH
              ? decorate(tr)
              : value
        },
        props: {
          decorations(state) {
            return NAME_CHECK_KEY.getState(state) ?? DecorationSet.empty
          },
          handleDOMEvents: {
            contextmenu: (view, event) => openMenu(view, event)
          }
        },
        view(view) {
          // Several editors share one index: the first to hear of a change rebuilds it, so the
          // others compare against what they last drew instead.
          let drawn = currentIndex()
          const onChange = (): void => {
            if (view.isDestroyed) return
            const now = currentIndex()
            if (now === drawn) return
            drawn = now
            view.dispatch(
              view.state.tr.setMeta(NAME_CHECK_KEY, REFRESH).setMeta('addToHistory', false)
            )
          }
          const offs = [
            useEntityStore.subscribe(onChange),
            useTagStore.subscribe(onChange),
            useDictionaryStore.subscribe(onChange)
          ]
          return {
            destroy() {
              for (const off of offs) off()
            }
          }
        }
      })
    ]
  }
})
