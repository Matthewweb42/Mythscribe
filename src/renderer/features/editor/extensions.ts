import { canInsertNode, Extension, Node, type Extensions } from '@tiptap/core'
import TextAlign from '@tiptap/extension-text-align'
import { TextSelection } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'

export interface EditorSchemaOptions {
  /** The scene-break text from the editor settings (F-3.6); the scene-break node renders it. */
  sceneBreak: string
  /** Runs on Ctrl/Cmd+S (F-3.2). */
  onSave: () => void
}

export interface SaveShortcutOptions {
  /** Runs on Ctrl/Cmd+S; null (unconfigured) still swallows the key. */
  onSave: (() => void) | null
}

/** Ctrl/Cmd+S inside the editor saves now (F-3.2) instead of reaching the browser's save-page handler. */
export const SaveShortcut = Extension.create<SaveShortcutOptions>({
  name: 'saveShortcut',

  addOptions() {
    return { onSave: null }
  },

  addKeyboardShortcuts() {
    return {
      'Mod-s': () => {
        this.options.onSave?.()
        return true
      }
    }
  }
})

/** The heading levels the editor offers (F-3.1); the toolbar and the schema share this list. */
export const HEADING_LEVELS = [1, 2, 3] as const
export type HeadingLevel = (typeof HEADING_LEVELS)[number]

/** Paragraph alignments (F-3.1), in toolbar order. */
export const ALIGNMENTS = ['left', 'center', 'right', 'justify'] as const
export type Alignment = (typeof ALIGNMENTS)[number]

export interface SceneBreakOptions {
  /** What the break shows; the document stores only the node, so F-3.6 can restyle every break at once. */
  text: string
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    sceneBreak: {
      /** Insert a scene break at the selection and put the caret in the paragraph after it. */
      insertSceneBreak: () => ReturnType
    }
  }
}

/**
 * The scene-break block (F-3.1): an atom with no content of its own that renders the configured
 * text (F-3.6). Selectable so Backspace/Delete and arrow keys treat it like one character.
 */
export const SceneBreak = Node.create<SceneBreakOptions>({
  name: 'sceneBreak',
  group: 'block',
  atom: true,
  selectable: true,

  addOptions() {
    return { text: '* * *' }
  },

  parseHTML() {
    return [{ tag: 'div[data-scene-break]' }]
  },

  renderHTML() {
    return ['div', { 'data-scene-break': '', class: 'scene-break' }, this.options.text]
  },

  addCommands() {
    return {
      insertSceneBreak:
        () =>
        ({ chain, state }) => {
          const type = state.schema.nodes[this.name]
          if (!type || !canInsertNode(state, type)) return false
          return chain()
            .insertContent({ type: this.name })
            .command(({ tr, dispatch }) => {
              if (dispatch) {
                const { $to } = tr.selection
                if ($to.nodeAfter?.isTextblock) {
                  tr.setSelection(TextSelection.create(tr.doc, $to.pos + 1))
                } else if (!$to.nodeAfter) {
                  // At the end of the document: open a paragraph so the author can keep typing.
                  const paragraph = tr.doc.type.contentMatch.defaultType?.create()
                  if (paragraph) {
                    const posAfter = $to.end()
                    tr.insert(posAfter, paragraph)
                    tr.setSelection(TextSelection.create(tr.doc, posAfter + 1))
                  }
                }
                tr.scrollIntoView()
              }
              return true
            })
            .run()
        }
    }
  }
})

/**
 * The one owner of the editor schema (F-3.1): StarterKit trimmed to what the spec lists (marks,
 * headings 1–3, block quote, hard break, undo/redo, cursors) plus text alignment on headings and
 * paragraphs, the scene-break block, and the Ctrl+S save shortcut (F-3.2). Lists, links, code
 * blocks, horizontal rules, and the trailing node are off so the document model stays what the
 * compile views (F-3.12) and the AI post-processors expect.
 */
export function buildExtensions({ sceneBreak, onSave }: EditorSchemaOptions): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [...HEADING_LEVELS] },
      link: false,
      codeBlock: false,
      bulletList: false,
      orderedList: false,
      listItem: false,
      listKeymap: false,
      horizontalRule: false,
      // Off: it appends an empty paragraph after a trailing heading or quote, which the mapped
      // select-all selection then spans, so `isActive` reports a freshly applied heading as
      // inactive. The scene-break command opens its own paragraph at the end of the document.
      trailingNode: false
    }),
    TextAlign.configure({ types: ['heading', 'paragraph'], alignments: [...ALIGNMENTS] }),
    SceneBreak.configure({ text: sceneBreak }),
    SaveShortcut.configure({ onSave })
  ]
}
