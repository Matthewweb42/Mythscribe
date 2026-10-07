import { Extension } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { locateAll, type TextRange } from './locateText'

/**
 * Tracked changes (F-14.15): the pending changes of an edit pass shown inline in the scene. The
 * passage a change replaces is struck through and its replacement follows it in colour, with an
 * Accept and a Reject button; nothing in the document changes until the author accepts. The
 * changes are found again by their quoted text on every document change (one scan), so a change
 * the author's own edits orphaned is reported stale once and never misapplied. The extension
 * only draws and reports: the edit-pass store applies, settles, and feeds the list.
 */

/** One change as the editor draws it. */
export interface TrackedChange {
  id: string
  original: string
  /** '' cuts the passage. */
  replacement: string
  rationale: string
  flagged: boolean
}

export type TrackedChangeAction = 'accept' | 'reject'

export interface TrackedChangesStorage {
  /** The author pressed Accept or Reject on a change; set by the edit-pass hook. */
  onAction: ((id: string, action: TrackedChangeAction) => void) | null
  /** These changes' passages are no longer in the document; each id is reported once. */
  onStale: ((ids: string[]) => void) | null
}

interface LocatedChange {
  change: TrackedChange
  range: TextRange
}

interface TrackedState {
  changes: TrackedChange[]
  located: LocatedChange[]
  /** Ids whose passage is gone, as of the latest document. */
  stale: string[]
  /** The change the author jumped to; drawn highlighted. */
  focusId: string | null
  decorations: DecorationSet
}

type TrackedMeta = { type: 'set'; changes: TrackedChange[] } | { type: 'focus'; id: string | null }

export const TRACKED_CHANGES_KEY = new PluginKey<TrackedState>('trackedChanges')
/** The class on a struck passage and on a replacement; the stylesheet colours them and the e2e reads them. */
export const TRACKED_DEL_CLASS = 'tracked-del'
export const TRACKED_INS_CLASS = 'tracked-ins'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    trackedChanges: {
      /** Replace the changes shown; an empty list clears them. */
      setTrackedChanges: (changes: TrackedChange[]) => ReturnType
      /** Highlight one change (a jump from the report), or none. */
      focusTrackedChange: (id: string | null) => ReturnType
    }
  }

  interface Storage {
    /** Present only for editors built with the tracked-changes extension (manuscript documents). */
    trackedChanges?: TrackedChangesStorage
  }
}

/** Where each change sits now, and the ones whose passage is gone. Overlapping changes keep the first. */
function locate(
  doc: PmNode,
  changes: readonly TrackedChange[]
): { located: LocatedChange[]; stale: string[] } {
  const ranges = locateAll(
    doc,
    changes.map((change) => change.original)
  )
  const located: LocatedChange[] = []
  const stale: string[] = []
  changes.forEach((change, i) => {
    const range = ranges[i] ?? null
    if (range === null) {
      stale.push(change.id)
      return
    }
    if (located.some((other) => range.from < other.range.to && other.range.from < range.to)) return
    located.push({ change, range })
  })
  located.sort((a, b) => a.range.from - b.range.from)
  return { located, stale }
}

function button(label: string, title: string, action: TrackedChangeAction): HTMLButtonElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = `tracked-${action}`
  el.textContent = label
  el.title = title
  el.setAttribute('aria-label', title)
  el.dataset.trackedAction = action
  return el
}

function renderWidget(
  change: TrackedChange,
  onAction: (id: string, action: TrackedChangeAction) => void
): HTMLElement {
  const wrap = document.createElement('span')
  wrap.className = 'tracked-change'
  wrap.contentEditable = 'false'
  wrap.dataset.changeId = change.id
  if (change.replacement !== '') {
    const ins = document.createElement('span')
    ins.className = TRACKED_INS_CLASS
    ins.textContent = change.replacement
    wrap.append(ins)
  }
  const why = change.rationale ? `: ${change.rationale}` : ''
  const accept = button('✓', `Accept change${why}`, 'accept')
  const reject = button('✕', 'Reject change', 'reject')
  for (const el of [accept, reject]) {
    el.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      onAction(change.id, el.dataset.trackedAction === 'accept' ? 'accept' : 'reject')
    })
  }
  wrap.append(accept, reject)
  if (change.flagged) wrap.classList.add('tracked-flagged')
  return wrap
}

function decorate(
  doc: PmNode,
  located: readonly LocatedChange[],
  focusId: string | null,
  onAction: (id: string, action: TrackedChangeAction) => void
): DecorationSet {
  if (located.length === 0) return DecorationSet.empty
  const decorations: Decoration[] = []
  for (const { change, range } of located) {
    const focus = change.id === focusId ? ' tracked-focus' : ''
    decorations.push(
      Decoration.inline(range.from, range.to, {
        class: `${TRACKED_DEL_CLASS}${focus}`,
        'data-change-id': change.id
      }),
      Decoration.widget(range.to, () => renderWidget(change, onAction), {
        side: 1,
        ignoreSelection: true,
        stopEvent: () => true,
        key: `${change.id}:${change.replacement}`
      })
    )
  }
  return DecorationSet.create(doc, decorations)
}

/** The changes drawn now and where (for the bar's Accept all and for tests). */
export function trackedChangesOf(
  state: EditorState
): { change: TrackedChange; range: TextRange }[] {
  return TRACKED_CHANGES_KEY.getState(state)?.located ?? []
}

export const TrackedChanges = Extension.create<Record<string, never>, TrackedChangesStorage>({
  name: 'trackedChanges',

  addStorage() {
    return { onAction: null, onStale: null }
  },

  addCommands() {
    return {
      setTrackedChanges:
        (changes) =>
        ({ tr, dispatch }) => {
          if (dispatch)
            tr.setMeta(TRACKED_CHANGES_KEY, { type: 'set', changes } satisfies TrackedMeta)
          return true
        },
      focusTrackedChange:
        (id) =>
        ({ tr, dispatch }) => {
          if (dispatch) tr.setMeta(TRACKED_CHANGES_KEY, { type: 'focus', id } satisfies TrackedMeta)
          return true
        }
    }
  },

  addProseMirrorPlugins() {
    const storage = this.storage
    const onAction = (id: string, action: TrackedChangeAction): void => {
      storage.onAction?.(id, action)
    }
    const empty: TrackedState = {
      changes: [],
      located: [],
      stale: [],
      focusId: null,
      decorations: DecorationSet.empty
    }
    const build = (doc: PmNode, changes: TrackedChange[], focusId: string | null): TrackedState => {
      const { located, stale } = locate(doc, changes)
      return {
        changes,
        located,
        stale,
        focusId,
        decorations: decorate(doc, located, focusId, onAction)
      }
    }
    return [
      new Plugin<TrackedState>({
        key: TRACKED_CHANGES_KEY,
        state: {
          init: () => empty,
          apply(tr: Transaction, prev: TrackedState): TrackedState {
            const meta = tr.getMeta(TRACKED_CHANGES_KEY) as TrackedMeta | undefined
            if (meta?.type === 'set') return build(tr.doc, meta.changes, prev.focusId)
            if (meta?.type === 'focus') {
              return {
                ...prev,
                focusId: meta.id,
                decorations: decorate(tr.doc, prev.located, meta.id, onAction)
              }
            }
            // Unmarked documents pay nothing per keystroke; with changes, one scan finds them again.
            if (!tr.docChanged || prev.changes.length === 0) return prev
            return build(tr.doc, prev.changes, prev.focusId)
          }
        },
        props: {
          decorations: (state) => TRACKED_CHANGES_KEY.getState(state)?.decorations ?? null
        },
        view: () => {
          const reported = new Set<string>()
          return {
            update(view) {
              const stale = TRACKED_CHANGES_KEY.getState(view.state)?.stale ?? []
              const fresh = stale.filter((id) => !reported.has(id))
              if (fresh.length === 0) return
              for (const id of fresh) reported.add(id)
              storage.onStale?.(fresh)
            }
          }
        }
      })
    ]
  }
})
