import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

/**
 * Typewriter scrolling (F-3.9, F-6.7): while enabled, every transaction that changes the
 * document scrolls the editor's scroll container so the caret sits at its vertical middle.
 * Clicks and pure caret moves never scroll: the author is reading, not typing. The flag lives
 * in the extension's storage and is read at run time, so toggling the setting (or entering
 * focus mode, where it is on by default) never rebuilds the editor.
 */
export interface TypewriterStorage {
  enabled: boolean
}

/** What the plugin needs from a scroll container; a real element or a test double. */
export interface ScrollTarget {
  scrollTop: number
  getBoundingClientRect(): { top: number; height: number }
}

export interface TypewriterOptions {
  /** Where to scroll; defaults to the nearest ancestor of the editor with `overflow-y: auto | scroll`. */
  scroller: (view: EditorView) => ScrollTarget | null
}

/** Caret offsets from the middle within this band are left alone, so the page never jitters. */
export const TYPEWRITER_DEAD_ZONE_PX = 8

/** How far to scroll so a caret at `caretTop` sits at the scroller's middle; 0 inside the dead zone. */
export function centerDelta(caretTop: number, scroller: { top: number; height: number }): number {
  const delta = caretTop - (scroller.top + scroller.height / 2)
  return Math.abs(delta) <= TYPEWRITER_DEAD_ZONE_PX ? 0 : delta
}

/** The nearest ancestor that scrolls vertically, or null when the editor is not inside one. */
export function findScroller(start: Element): HTMLElement | null {
  for (let el = start.parentElement; el; el = el.parentElement) {
    const overflowY = getComputedStyle(el).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return el
  }
  return null
}

export const TYPEWRITER_KEY = new PluginKey('typewriter')

export const Typewriter = Extension.create<TypewriterOptions, TypewriterStorage>({
  name: 'typewriter',

  addOptions() {
    return { scroller: (view) => findScroller(view.dom) }
  },

  addStorage() {
    return { enabled: false }
  },

  addCommands() {
    return {
      /** Turns typewriter scrolling on or off; no transaction, the flag is read on the next change. */
      setTypewriter:
        (enabled: boolean) =>
        ({ editor }) => {
          const storage = editor.storage.typewriter
          if (!storage) return false
          storage.enabled = enabled
          return true
        }
    }
  },

  addProseMirrorPlugins() {
    const storage = this.storage
    const { scroller } = this.options
    return [
      new Plugin({
        key: TYPEWRITER_KEY,
        view: () => ({
          update(view, prevState) {
            if (!storage.enabled) return
            // A transaction that leaves the document alone keeps the same doc object.
            if (view.state.doc === prevState.doc) return
            const target = scroller(view)
            if (!target) return
            const caret = view.coordsAtPos(view.state.selection.head)
            const delta = centerDelta(caret.top, target.getBoundingClientRect())
            if (delta !== 0) target.scrollTop += delta
          }
        })
      })
    ]
  }
})

declare module '@tiptap/core' {
  interface Storage {
    typewriter?: TypewriterStorage
  }
  interface Commands<ReturnType> {
    typewriter: {
      setTypewriter: (enabled: boolean) => ReturnType
    }
  }
}
