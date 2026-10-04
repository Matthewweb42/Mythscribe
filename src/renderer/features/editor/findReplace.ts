import { Extension } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction
} from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import {
  compileFind,
  expandReplacement,
  type FindGroups,
  type FindMatch,
  type FindOptions
} from '@shared/findInDocument'

/** One occurrence in the document, as positions; regex matches carry their captures. */
export interface DocMatch {
  from: number
  to: number
  groups?: FindGroups
}

/**
 * What find in document (F-3.10) holds for one editor: the options it was given (null while the
 * find bar is closed), every match in reading order, which one is current (-1 for none), and why
 * the options cannot match (an invalid pattern), with the decorations drawn from them.
 */
export interface FindState {
  options: FindOptions | null
  matches: DocMatch[]
  current: number
  error: string | null
  decorations: DecorationSet
}

type FindMeta =
  | { type: 'set'; options: FindOptions | null; anchor: number }
  | { type: 'current'; index: number }
  /** The document changed under our own replace: current is the first match from `pos` on. */
  | { type: 'after'; pos: number }

export const FIND_REPLACE_KEY = new PluginKey<FindState>('findReplace')

/** Every match carries this class; the stylesheet tints it and the e2e test counts it. */
export const FIND_MATCH_CLASS = 'find-match'
/** The current match carries this one as well. */
export const FIND_MATCH_CURRENT_CLASS = 'find-match-current'

const EMPTY: FindState = {
  options: null,
  matches: [],
  current: -1,
  error: null,
  decorations: DecorationSet.empty
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    findReplace: {
      /**
       * Look for `options` in the document (null clears the search and its highlights); current
       * becomes the first match at or after `anchor` (the selection's start by default), wrapping
       * to the first. Never changes the selection or the document.
       */
      setFind: (options: FindOptions | null, anchor?: number) => ReturnType
      /** Move current one match forward or back, wrapping, and select it; false with no match. */
      findStep: (direction: 1 | -1) => ReturnType
      /**
       * Replace the current match (regex mode expands `$1` and the like) and make the match after
       * it current; an empty replacement deletes. False with no current match.
       */
      replaceMatch: (replacement: string) => ReturnType
      /** Replace every match in one transaction, so it undoes as one step; false with none. */
      replaceAllMatches: (replacement: string) => ReturnType
    }
  }
}

/** The editor's find state; the empty state before the extension saw any options. */
export function findStateOf(state: EditorState): FindState {
  return FIND_REPLACE_KEY.getState(state) ?? EMPTY
}

/**
 * Every match of `find` in the document. A run is the adjacent text nodes of one textblock, as in
 * project-wide replace (F-10.2): a block boundary, a hard break, or an inline tag token ends it,
 * so a match never spans one.
 */
function matchesIn(doc: PmNode, find: (text: string) => FindMatch[]): DocMatch[] {
  const matches: DocMatch[] = []
  const flush = (text: string, start: number): void => {
    if (text === '') return
    for (const match of find(text)) {
      matches.push({ from: start + match.from, to: start + match.to, groups: match.groups })
    }
  }
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    let text = ''
    let start = -1
    node.forEach((child, offset) => {
      const at = pos + 1 + offset
      if (child.isText) {
        if (start === -1) start = at
        text += child.text ?? ''
      } else {
        flush(text, start)
        text = ''
        start = -1
      }
    })
    flush(text, start)
    return false
  })
  return matches
}

function decorate(doc: PmNode, matches: readonly DocMatch[], current: number): DecorationSet {
  if (matches.length === 0) return DecorationSet.empty
  return DecorationSet.create(
    doc,
    matches.map((match, index) =>
      Decoration.inline(match.from, match.to, {
        class:
          index === current ? `${FIND_MATCH_CLASS} ${FIND_MATCH_CURRENT_CLASS}` : FIND_MATCH_CLASS
      })
    )
  )
}

/** The first match starting at or after `pos`, wrapping to the first; -1 with none. */
function firstFrom(matches: readonly DocMatch[], pos: number): number {
  if (matches.length === 0) return -1
  const index = matches.findIndex((match) => match.from >= pos)
  return index === -1 ? 0 : index
}

/** The state for `options` over `doc`, current at the first match from `pos` on. */
function search(doc: PmNode, options: FindOptions | null, pos: number): FindState {
  if (options === null) return EMPTY
  const compiled = compileFind(options)
  if (!compiled.ok) {
    return {
      options,
      matches: [],
      current: -1,
      error: compiled.error,
      decorations: DecorationSet.empty
    }
  }
  const matches = matchesIn(doc, compiled.find)
  const current = firstFrom(matches, pos)
  return { options, matches, current, error: null, decorations: decorate(doc, matches, current) }
}

function withCurrent(doc: PmNode, value: FindState, current: number): FindState {
  if (current === value.current) return value
  return { ...value, current, decorations: decorate(doc, value.matches, current) }
}

/**
 * The next state for a transaction. Our own metadata wins; otherwise a document change while a
 * search is set recomputes the matches, and current becomes the first match at or after where
 * the old current started (mapped through the change), so editing elsewhere never jumps it.
 */
function apply(tr: Transaction, value: FindState): FindState {
  const meta = tr.getMeta(FIND_REPLACE_KEY) as FindMeta | undefined
  if (meta?.type === 'set') return search(tr.doc, meta.options, meta.anchor)
  if (meta?.type === 'current') return withCurrent(tr.doc, value, meta.index)
  if (meta?.type === 'after') return search(tr.doc, value.options, meta.pos)
  if (value.options === null || !tr.docChanged) return value
  const old = value.matches[value.current]
  const pos = old === undefined ? tr.selection.from : tr.mapping.map(old.from)
  return search(tr.doc, value.options, pos)
}

/** The text a match is replaced with under the current options. */
function replacementFor(state: FindState, match: DocMatch, replacement: string): string {
  return expandReplacement(replacement, match, state.options?.regex ?? false)
}

/** Replaces `[from, to)` with `text` (marks taken at `from`), or deletes it for empty text. */
function replaceRange(tr: Transaction, from: number, to: number, text: string): void {
  tr.setStoredMarks(null)
  if (text === '') tr.delete(from, to)
  else tr.insertText(text, from, to)
}

/**
 * Find and replace in the open document (F-3.10): the matches live in plugin state, drawn as
 * inline decorations and recomputed on every document change while a search is set. Replacing
 * goes through ordinary transactions, so the document store, autosave, word counts, and the
 * editor's undo treat it like typing; Replace all is one transaction and one undo step. The find
 * bar (`FindBar`) owns the options and calls these commands on the active editor.
 */
export const FindReplace = Extension.create({
  name: 'findReplace',

  addCommands() {
    return {
      setFind:
        (options, anchor) =>
        ({ state, tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(FIND_REPLACE_KEY, {
              type: 'set',
              options,
              anchor: anchor ?? state.selection.from
            } satisfies FindMeta)
          }
          return true
        },
      findStep:
        (direction) =>
        ({ state, tr, dispatch }) => {
          const { matches, current } = findStateOf(state)
          const count = matches.length
          if (count === 0) return false
          const index =
            current === -1
              ? direction === 1
                ? 0
                : count - 1
              : (current + direction + count) % count
          const match = matches[index]
          if (match === undefined) return false
          if (dispatch) {
            tr.setMeta(FIND_REPLACE_KEY, { type: 'current', index } satisfies FindMeta)
            tr.setSelection(TextSelection.create(tr.doc, match.from, match.to))
            tr.scrollIntoView()
          }
          return true
        },
      replaceMatch:
        (replacement) =>
        ({ state, tr, dispatch }) => {
          const find = findStateOf(state)
          const match = find.matches[find.current]
          if (match === undefined) return false
          if (dispatch) {
            const text = replacementFor(find, match, replacement)
            replaceRange(tr, match.from, match.to, text)
            const after = match.from + text.length
            tr.setSelection(TextSelection.create(tr.doc, after))
            tr.setMeta(FIND_REPLACE_KEY, { type: 'after', pos: after } satisfies FindMeta)
            tr.scrollIntoView()
          }
          return true
        },
      replaceAllMatches:
        (replacement) =>
        ({ state, tr, dispatch }) => {
          const find = findStateOf(state)
          if (find.matches.length === 0) return false
          if (dispatch) {
            // Last to first, so every earlier match keeps its positions.
            for (let index = find.matches.length - 1; index >= 0; index--) {
              const match = find.matches[index]
              if (match === undefined) continue
              replaceRange(tr, match.from, match.to, replacementFor(find, match, replacement))
            }
          }
          return true
        }
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: FIND_REPLACE_KEY,
        state: { init: () => EMPTY, apply },
        props: {
          decorations: (state) => findStateOf(state).decorations
        }
      })
    ]
  }
})
