import {
  canInsertNode,
  Extension,
  getSchema,
  Node,
  type Editor,
  type Extensions
} from '@tiptap/core'
import TextAlign from '@tiptap/extension-text-align'
import { DOMSerializer, type Schema } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import { AiOrigin } from './aiOrigin'
import { FindReplace } from './findReplace'
import { GhostText } from './ghostText'
import { InlineTag } from './InlineTag'
import { NameCheck } from './nameCheck'
import { OriginParagraph } from './originParagraph'
import { FiledFromMarks } from './filedFrom'
import { PageHeadingMarks, PageParagraph } from './pageParagraph'
import { RewriteTarget } from './rewriteTarget'
import { SmartTypography } from './smartTypography'
import { TagRange } from './TagRange'
import { TrackedChanges } from './trackedChanges'
import { Typewriter } from './typewriter'

export interface EditorSchemaOptions {
  /** The scene-break text from the editor settings (F-3.6); the scene-break node renders it. */
  sceneBreak: string
  /** Runs on Ctrl/Cmd+S (F-3.2). */
  onSave: () => void
  /**
   * Runs on an Escape nothing closer claimed (F-6.1): ghost text and the `#` popup see the key
   * first. Answers whether it was used. ProseMirror prevents default on every Escape in a
   * focused editor, so a document-level listener cannot tell a bare Escape from a claimed one;
   * this is how the editor hands it on.
   */
  onEscape?: () => boolean
  /**
   * The manuscript document the editor shows (F-4.6): adds the inline tag token and its `#`
   * suggestion, which links picked tags to this node, the ghost-text decoration (F-5.3), the
   * AI-origin mark its accepted text carries (F-14.6), the rewrite target highlight (F-14.10),
   * the near-name underline (F-3.14), find and replace in document (F-3.10), and the tag range
   * mark (F-4.8). Left out for notes, which never get tags, suggestions, or the find bar.
   */
  inlineTagNodeId?: string
  /** Runs on Mod+Alt+T over a selection in a manuscript document (F-4.8): open the range tag picker. */
  onTagSelection?: (editor: Editor) => void
  /**
   * Story memory v2 (F-16.4): the inline tag token and the tag range mark stay in the schema, so
   * stored documents load unchanged, but they are inert: no `#` suggestion, no bank colours, no
   * range highlight or shortcut. The schema itself is the same either way.
   */
  inertTags?: boolean
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

export interface EscapeShortcutOptions {
  /** Runs on an otherwise unclaimed Escape; null (unconfigured) leaves the key to ProseMirror. */
  onEscape: (() => boolean) | null
}

/**
 * Escape inside the editor, after every other binding (F-6.1): the priority puts this keymap
 * last, so ghost text (`clearGhost`) and the `#` suggestion popup keep first refusal and only a
 * bare Escape reaches the callback.
 */
export const EscapeShortcut = Extension.create<EscapeShortcutOptions>({
  name: 'escapeShortcut',
  priority: 50,

  addOptions() {
    return { onEscape: null }
  },

  addKeyboardShortcuts() {
    return {
      Escape: () => this.options.onEscape?.() ?? false
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

  /** Copied as plain text (F-3.13): the break on its own line with a blank line either side. */
  renderText() {
    return `\n${this.options.text}\n`
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

export { OriginParagraph } from './originParagraph'

/**
 * The one owner of the editor schema (F-3.1): StarterKit trimmed to what the spec lists (marks,
 * headings 1–3, block quote, hard break, undo/redo, cursors) plus the paragraph that keeps its
 * import provenance (F-12.2), text alignment on headings and paragraphs, the scene-break block, the Ctrl+S save shortcut (F-3.2), and, for a manuscript
 * document, the inline tag token with its `#` suggestion (F-4.6), the AI-origin mark (F-14.6,
 * wherever ghost text can insert), the ghost-text decoration (F-5.3, always in the schema
 * so toggling VibeWrite never rebuilds the editor), the rewrite target (F-14.10), find and
 * replace in document (F-3.10), the tag range mark (F-4.8), the tracked changes of an edit pass
 * (F-14.15), and the
 * Escape hand-off (F-6.1) when the caller wants one. Lists, links, code blocks, horizontal rules, and the trailing node are off
 * so the document model stays what the compile views (F-3.12) and the AI post-processors
 * expect.
 */
/**
 * What `useEditor` passes as `coreExtensionOptions` (F-3.13): plain-text copies join paragraphs
 * with one newline, since the editor shows paragraphs by spacing and indent rather than by blank
 * lines, and a `\n\n` join (Tiptap's default) pastes as a blank line between every paragraph in
 * a plain-text target. The HTML clipboard flavour is untouched, so rich targets still receive
 * paragraphs.
 */
/**
 * The rich-text clipboard flavour (F-3.13): the default HTML, with every copied paragraph set to
 * `margin: 0`. Word, Google Docs, and mail clients give a bare `<p>` their own space after it,
 * which reads as a blank line between paragraphs once pasted; the editor itself shows spacing and
 * indent from its settings, never an empty line. Headings and scene breaks keep their spacing.
 */
export function clipboardSerializer(schema: Schema): DOMSerializer {
  const base = DOMSerializer.fromSchema(schema)
  const serializer = new DOMSerializer(base.nodes, base.marks)
  const serialize = serializer.serializeFragment.bind(serializer)
  serializer.serializeFragment = (fragment, options, target) => {
    const dom = serialize(fragment, options, target)
    if (dom instanceof DocumentFragment || dom instanceof HTMLElement) {
      for (const p of dom.querySelectorAll('p')) {
        p.style.marginTop = '0'
        p.style.marginBottom = '0'
      }
    }
    return dom
  }
  return serializer
}

const ClipboardParagraphs = Extension.create({
  name: 'clipboardParagraphs',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('clipboardParagraphs'),
        props: { clipboardSerializer: clipboardSerializer(this.editor.schema) }
      })
    ]
  }
})

export const EDITOR_CORE_OPTIONS = {
  clipboardTextSerializer: { blockSeparator: '\n' }
} as const

/** The schema's shared core (F-3.1): StarterKit trimmed, `paragraph` in place of its own, alignment, breaks, save. */
function coreExtensions(
  paragraph: typeof OriginParagraph,
  sceneBreak: string,
  onSave: () => void
): Extensions {
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
      // F-12.2: `OriginParagraph` takes its place, so an imported paragraph keeps `data-origin`.
      paragraph: false,
      // Off: it appends an empty paragraph after a trailing heading or quote, which the mapped
      // select-all selection then spans, so `isActive` reports a freshly applied heading as
      // inactive. The scene-break command opens its own paragraph at the end of the document.
      trailingNode: false
    }),
    paragraph,
    TextAlign.configure({ types: ['heading', 'paragraph'], alignments: [...ALIGNMENTS] }),
    SceneBreak.configure({ text: sceneBreak }),
    SaveShortcut.configure({ onSave }),
    ClipboardParagraphs,
    SmartTypography
  ]
}

export function buildExtensions({
  sceneBreak,
  onSave,
  onEscape,
  inlineTagNodeId,
  onTagSelection,
  inertTags = false
}: EditorSchemaOptions): Extensions {
  const extensions: Extensions = coreExtensions(OriginParagraph, sceneBreak, onSave)
  if (inlineTagNodeId !== undefined) {
    extensions.push(
      InlineTag.configure({ nodeId: inlineTagNodeId, inert: inertTags }),
      AiOrigin,
      GhostText,
      RewriteTarget,
      Typewriter,
      NameCheck,
      FindReplace,
      TagRange.configure({ onTagSelection: onTagSelection ?? null, inert: inertTags }),
      TrackedChanges
    )
  }
  if (onEscape) extensions.push(EscapeShortcut.configure({ onEscape }))
  return extensions
}

/** What a page editor (`PageEditor`) passes for its schema. */
export interface PageSchemaOptions {
  /** What a scene break on the page shows; pages are not the manuscript, so it is fixed. */
  sceneBreak: string
  /** Runs on Ctrl/Cmd+S. */
  onSave: () => void
  /** F-16.9: the title of a Research page, for a filed paragraph's "Filed from" label. */
  filedTitle?: (docId: string) => string | null
}

/**
 * The page schema (F-16.6, F-16.8; plan P1 §2.3): the schema of the pages story memory v2 keeps
 * beside the manuscript (Research documents; a record's Pinned and Ideas from slice 3). The
 * manuscript's core with `PageParagraph` (Not canon, `aiFiled`, `aiWritten`, and the
 * `clearAiMarks` plugin) in place of `OriginParagraph`, and none of the manuscript's own tools
 * (tags, ghost text, rewrite, find, tracked changes). A separate builder, so no manuscript
 * document ever gains the page's attributes.
 */
export function buildPageExtensions({
  sceneBreak,
  onSave,
  filedTitle
}: PageSchemaOptions): Extensions {
  const extensions = [...coreExtensions(PageParagraph, sceneBreak, onSave), PageHeadingMarks]
  if (filedTitle !== undefined) extensions.push(FiledFromMarks.configure({ titleOf: filedTitle }))
  return extensions
}

/**
 * The manuscript editor's schema without an editor (F-3.12), for rendering stored documents
 * read-only (the compiled preview). Built from the same `buildExtensions` a manuscript document
 * uses, so every node and mark a stored document can hold (the inline tag token, the AI-origin
 * mark, the provenance paragraph) parses. `getSchema` only reads the node and mark specs: no
 * plugin is instantiated, so the save callback and the tag node id are never used.
 */
export function manuscriptSchema(sceneBreak: string): Schema {
  return getSchema(buildExtensions({ sceneBreak, onSave: () => undefined, inlineTagNodeId: '' }))
}

/** The page schema without an editor (F-16.8), for checking stored pages (`storedContent.test.ts`). */
export function pageSchema(sceneBreak: string): Schema {
  return getSchema(buildPageExtensions({ sceneBreak, onSave: () => undefined }))
}
