import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { AI_FILED_ATTR, AiFiled } from '@shared/memory/pageMarks'

/**
 * The "Filed from" mark of a Pinned paragraph filed from a Research page (F-16.9): a small,
 * non-editable label at the end of every paragraph that carries an `aiFiled` mark, naming the
 * page and its paragraph ("Filed from “Bestiary” ¶4"), with the quote on hover. A decoration, so
 * nothing is stored and it goes the moment the author's edit clears the mark (`clearAiMarks`).
 */

export interface FiledFromOptions {
  /** The title of the Research page a mark points at, or null when it is gone. */
  titleOf: (docId: string) => string | null
}

/** The label of one filed paragraph. */
export function filedFromLabel(filed: AiFiled, title: string | null): string {
  return title === null
    ? 'Filed from a Research page that is gone'
    : `Filed from “${title}” ¶${filed.para + 1}`
}

const KEY = new PluginKey('filedFrom')

export const FiledFromMarks = Extension.create<FiledFromOptions>({
  name: 'filedFromMarks',

  addOptions() {
    return { titleOf: () => null }
  },

  addProseMirrorPlugins() {
    const { titleOf } = this.options
    return [
      new Plugin({
        key: KEY,
        props: {
          decorations: (state) => {
            const widgets: Decoration[] = []
            state.doc.descendants((node, pos) => {
              if (!node.isTextblock) return true
              const parsed = AiFiled.safeParse(node.attrs[AI_FILED_ATTR])
              if (!parsed.success) return false
              const label = filedFromLabel(parsed.data, titleOf(parsed.data.doc))
              widgets.push(
                Decoration.widget(
                  pos + node.nodeSize - 1,
                  () => {
                    const span = document.createElement('span')
                    span.className = 'ms-filed-from'
                    span.contentEditable = 'false'
                    span.dataset.testid = 'filed-from'
                    span.textContent = label
                    span.title = `“${parsed.data.quote}”`
                    return span
                  },
                  { side: 1, ignoreSelection: true, key: `filed:${label}:${parsed.data.quote}` }
                )
              )
              return false
            })
            return DecorationSet.create(state.doc, widgets)
          }
        }
      })
    ]
  }
})
