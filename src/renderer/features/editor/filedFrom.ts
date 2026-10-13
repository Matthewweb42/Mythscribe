import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { AI_FILED_ATTR, AI_WRITTEN_ATTR, AiFiled, AiWritten } from '@shared/memory/pageMarks'
import { shortDate } from '@renderer/features/memory/memoryView'

/**
 * The "Filed from" mark of a Pinned paragraph filed from a Research page (F-16.9): a small,
 * non-editable label at the end of every paragraph that carries an `aiFiled` mark, naming the
 * page and its paragraph ("Filed from “Bestiary” ¶4"), with the quote on hover. A decoration, so
 * nothing is stored and it goes the moment the author's edit clears the mark (`clearAiMarks`).
 * F-16.26: a Pinned or Ideas line Ms Scribe put on the sheet from the chat (`aiWritten`) carries
 * "Written from the chat, 13 Oct" the same way, until the author edits its words.
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

/** The label of one line written from the chat: "Written from the chat, 13 Oct". */
export function writtenLabel(written: AiWritten): string {
  const day = new Date(`${written.date}T12:00:00`)
  return Number.isNaN(day.getTime())
    ? 'Written from the chat'
    : `Written from the chat, ${shortDate(day)}`
}

/** A label widget at the end of a marked paragraph. */
function labelWidget(pos: number, label: string, title: string | null, testId: string): Decoration {
  return Decoration.widget(
    pos,
    () => {
      const span = document.createElement('span')
      span.className = 'ms-filed-from'
      span.contentEditable = 'false'
      span.dataset.testid = testId
      span.textContent = label
      if (title !== null) span.title = title
      return span
    },
    { side: 1, ignoreSelection: true, key: `${testId}:${label}:${title ?? ''}` }
  )
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
              const end = pos + node.nodeSize - 1
              const filed = AiFiled.safeParse(node.attrs[AI_FILED_ATTR])
              if (filed.success) {
                const label = filedFromLabel(filed.data, titleOf(filed.data.doc))
                widgets.push(labelWidget(end, label, `“${filed.data.quote}”`, 'filed-from'))
                return false
              }
              const written = AiWritten.safeParse(node.attrs[AI_WRITTEN_ATTR])
              if (written.success) {
                widgets.push(
                  labelWidget(end, writtenLabel(written.data), null, 'written-from-chat')
                )
              }
              return false
            })
            return DecorationSet.create(state.doc, widgets)
          }
        }
      })
    ]
  }
})
