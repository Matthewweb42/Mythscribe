import { mergeAttributes, Node } from '@tiptap/core'
import type { Attrs } from '@tiptap/pm/model'
import { PluginKey } from '@tiptap/pm/state'
import { ReactRenderer } from '@tiptap/react'
import { Suggestion, type SuggestionProps } from '@tiptap/suggestion'
import { INLINE_TAG_NODE_TYPE } from '@shared/inlineTags'
import type { Tag } from '@shared/ipc/contract'
import { toTagName } from '@shared/tags'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useDocumentTagStore } from '@renderer/features/tags/documentTagStore'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { describeError } from '@renderer/lib/errors'
import {
  InlineTagSuggestList,
  type InlineTagSuggestListHandle,
  type InlineTagSuggestListProps
} from './InlineTagSuggestList'

export interface InlineTagOptions {
  /** The document the tokens link tags to (F-4.4); null leaves the `#` suggestion out (notes). */
  nodeId: string | null
}

/** What a token stores: the tag's id and its name at insertion time (the label if the tag is deleted). */
export interface InlineTagAttrs {
  id: string
  name: string
}

/** One row of the `#` popup: a bank tag, or the offer to create one from the typed text. */
export type SuggestItem = { kind: 'tag'; tag: Tag } | { kind: 'create'; name: string }

/** The DOM attribute every token carries; the right-click handler and the resync pass select on it. */
export const INLINE_TAG_SELECTOR = '[data-inline-tag]'

/**
 * The rows for a query (F-4.6): the bank tags whose name contains the typed text
 * (case-insensitive, like the tag bar's picker), then a "Create" row for the kebab-cased text
 * unless it is empty or a tag of exactly that name already exists (main would refuse it).
 */
export function suggestItems(tags: Tag[], query: string): SuggestItem[] {
  const needle = query.toLowerCase()
  const items: SuggestItem[] = tags
    .filter((tag) => tag.name.toLowerCase().includes(needle))
    .map((tag) => ({ kind: 'tag', tag }))
  const name = toTagName(query)
  if (name.length > 0 && !tags.some((tag) => tag.name === name))
    items.push({ kind: 'create', name })
  return items
}

/** The stored attrs of a token node, guarded: ProseMirror types `attrs` loosely. */
function readAttrs(attrs: Attrs): InlineTagAttrs {
  const id: unknown = attrs.id
  const name: unknown = attrs.name
  return { id: typeof id === 'string' ? id : '', name: typeof name === 'string' ? name : '' }
}

/**
 * Paints the bank's current name and color onto every token in `dom` (F-4.6): the resync pass
 * that stands in for a node view. A rename or recolor in the Tags tab lands here at once; a
 * token whose tag was deleted falls back to the name it stored and loses its color. Tokens are
 * atoms, so ProseMirror ignores these mutations inside them.
 */
export function resyncInlineTags(dom: HTMLElement, byId: Record<string, Tag>): void {
  for (const span of dom.querySelectorAll<HTMLElement>(INLINE_TAG_SELECTOR)) {
    const tag = byId[span.dataset.id ?? '']
    const label = `#${tag?.name ?? span.dataset.name ?? ''}`
    if (span.textContent !== label) span.textContent = label
    if (tag) span.style.setProperty('--tag-color', tag.color)
    else span.style.removeProperty('--tag-color')
  }
}

/** The `#` suggestion plugin's key: present in a manuscript editor's state, absent in notes. */
export const INLINE_TAG_SUGGESTION_KEY = new PluginKey('inlineTagSuggestion')

/**
 * The inline tag token (F-4.6): an inline atom holding a tag's id and insertion-time name,
 * rendered as a `<span data-inline-tag>` with the bank's live name and color (the resync pass
 * keeps it current afterwards). Atomic, so Backspace removes the whole token; selectable, not
 * draggable; no marks, so it never inherits bold or italic from the text around it. The `#`
 * suggestion is a ProseMirror plugin on the same node, present only with a `nodeId`: it lists
 * the bank through `suggestItems`, inserts the token plus one unmarked space, and links the tag
 * to the document (F-4.4). Copy and paste keep tokens through `parseHTML`.
 */
export const InlineTag = Node.create<InlineTagOptions>({
  name: INLINE_TAG_NODE_TYPE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  marks: '',

  addOptions() {
    return { nodeId: null }
  },

  addAttributes() {
    return {
      id: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-id') ?? '',
        renderHTML: (attributes) => ({ 'data-id': readAttrs(attributes).id })
      },
      name: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-name') ?? '',
        renderHTML: (attributes) => ({ 'data-name': readAttrs(attributes).name })
      }
    }
  },

  parseHTML() {
    return [{ tag: `span${INLINE_TAG_SELECTOR}` }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const { id, name } = readAttrs(node.attrs)
    const tag = useTagStore.getState().byId[id]
    const attrs: Record<string, string> = { 'data-inline-tag': '', class: 'inline-tag' }
    if (tag) attrs.style = `--tag-color: ${tag.color}`
    return ['span', mergeAttributes(HTMLAttributes, attrs), `#${tag?.name ?? name}`]
  },

  addProseMirrorPlugins() {
    const { nodeId } = this.options
    if (nodeId === null) return []
    const type = this.name
    return [
      Suggestion<SuggestItem, InlineTagAttrs>({
        pluginKey: INLINE_TAG_SUGGESTION_KEY,
        editor: this.editor,
        char: '#',
        allowSpaces: false,
        items: ({ query }) => {
          const bank = useTagStore.getState()
          return suggestItems(
            bank.ids.flatMap((id) => bank.byId[id] ?? []),
            query
          )
        },
        command: ({ editor, range, props }) => {
          // The token brings its own space; swallow one already sitting after the caret.
          const after = editor.state.selection.$to.nodeAfter
          const to = after?.text?.startsWith(' ') ? range.to + 1 : range.to
          editor
            .chain()
            .focus()
            .insertContentAt({ from: range.from, to }, [
              { type, attrs: { id: props.id, name: props.name } },
              { type: 'text', text: ' ' }
            ])
            .run()
          useDocumentTagStore
            .getState()
            .add(nodeId, props.id)
            .catch((err: unknown) => toast.error(describeError(err)))
        },
        render: createSuggestionRenderer
      })
    ]
  }
})

type Renderer = ReactRenderer<InlineTagSuggestListHandle, InlineTagSuggestListProps>

/** The popup's props from the plugin's: only what the list needs, so unchanged props skip a render. */
function listProps(props: SuggestionProps<SuggestItem, InlineTagAttrs>): InlineTagSuggestListProps {
  return { items: props.items, loading: props.loading, command: props.command }
}

/**
 * Mounts the popup through `ReactRenderer` and the plugin's managed `mount`, which anchors it to
 * the caret and follows scrolling and resizing; the plugin itself handles Escape (an exit that
 * stays dismissed until the text changes) and clicks outside, and hands every other key here.
 */
function createSuggestionRenderer(): {
  onStart: (props: SuggestionProps<SuggestItem, InlineTagAttrs>) => void
  onUpdate: (props: SuggestionProps<SuggestItem, InlineTagAttrs>) => void
  onKeyDown: (props: { event: KeyboardEvent }) => boolean
  onExit: () => void
} {
  let component: Renderer | null = null
  let unmount: (() => void) | null = null
  return {
    onStart: (props) => {
      component = new ReactRenderer(InlineTagSuggestList, {
        props: listProps(props),
        editor: props.editor
      })
      unmount = props.mount(component.element)
    },
    onUpdate: (props) => component?.updateProps(listProps(props)),
    onKeyDown: ({ event }) => component?.ref?.onKeyDown(event) ?? false,
    onExit: () => {
      unmount?.()
      component?.destroy()
      unmount = null
      component = null
    }
  }
}
