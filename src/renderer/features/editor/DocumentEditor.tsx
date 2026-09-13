import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Editor } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import { INLINE_TAG_NODE_TYPE } from '@shared/inlineTags'
import type { NovelFormat } from '@shared/ipc/contract'
import { EMPTY_DOC, type TiptapNodeT } from '@shared/tiptap'
import { countWords } from '@shared/wordCount'
import { ContextMenu } from '@renderer/features/manuscript/ContextMenu'
import type { MenuItem } from '@renderer/features/manuscript/contextMenuItems'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { describeError } from '@renderer/lib/errors'
import { COLUMN, editorStyle } from './column'
import { useDocumentStore } from './documentStore'
import { buildExtensions } from './extensions'
import { useGhostTextController } from './ghostTextController'
import { INLINE_TAG_SELECTOR, resyncInlineTags } from './InlineTag'
import { NotesToggleButton } from './NotesPanel'
import { useEditorSettings } from './settingsStore'
import { StatusBar } from './StatusBar'
import { TagBar } from './TagBar'
import { Toolbar } from './Toolbar'
import { VibeWriteToggle } from './VibeWriteToggle'

export interface DocumentEditorProps {
  id: string
  format: NovelFormat
  /**
   * Own toolbar, scroll container, and status bar (the single-document pane, F-3.1, F-3.3), or
   * bare content for a region in a stack whose toolbar, scrolling, and status belong to the
   * stack (F-3.8).
   */
  toolbar?: boolean
  /** Fires when the editor gains focus, so a stack can point its shared toolbar at this region. */
  onFocus?: (editor: Editor) => void
}

/**
 * The writing surface for one document: loads it through `useDocumentStore` on mount (and again
 * when `id` changes) and unloads it on unmount, which saves any pending edit under its own id.
 * Every document gets its own editor instance, created with the loaded content, so the undo
 * history holds only the author's edits to that document: loading never lands on the stack and
 * undo can never walk into another document. While the load is in flight a read-only, empty
 * editor keeps the layout and the toolbar is disabled. Every edit goes to the store, which
 * autosaves it (F-3.2); Ctrl+S saves everything pending at once.
 */
export function DocumentEditor({
  id,
  format,
  toolbar = true,
  onFocus
}: DocumentEditorProps): React.JSX.Element {
  const content = useDocumentStore((s) => s.docs[id]?.content ?? null)
  const load = useDocumentStore((s) => s.load)
  const unload = useDocumentStore((s) => s.unload)

  useEffect(() => {
    load(id).catch((err: unknown) => toast.error(describeError(err)))
    return () => unload(id)
  }, [id, load, unload])

  return (
    <RegionEditor
      key={`${id}:${content === null ? 'loading' : 'ready'}`}
      id={id}
      content={content}
      format={format}
      toolbar={toolbar}
      onFocus={onFocus}
    />
  )
}

/** A right-click on an inline tag token (F-4.6): where the menu opens, the node's position, and its tag. */
interface TokenMenu {
  x: number
  y: number
  pos: number
  tagId: string
}

const TOKEN_MENU_ITEMS: MenuItem[] = [
  { id: 'remove', label: 'Remove' },
  { id: 'open-in-tag-manager', label: 'Open in Tag Manager' }
]

/**
 * One editor instance for one loaded document; `content === null` is the read-only loading
 * state. The formatting settings (F-3.6) apply live: five of them are custom properties on the
 * pane (no remount); the scene-break text is an extension option, so changing it rebuilds the
 * editor instance. `content` is the store's latest text (every edit lands there), and
 * `useEditor` reads it only when it constructs an instance, so the rebuild starts from the
 * author's unsaved typing and a keystroke never resets the editor. Inline tag tokens (F-4.6)
 * are repainted from the bank whenever it changes (the resync pass; the `#` suggestion lives in
 * the extension), and a right-click on one opens the Remove / Open in Tag Manager menu. Remove
 * deletes the token only: links are the author's explicit choice and stay. VibeWrite (F-5.3)
 * runs only in the single-document view: the controller arms itself there and the toggle sits
 * in the toolbar's right slot, so a stacked region never shows ghost text.
 */
function RegionEditor({
  id,
  content,
  format,
  toolbar,
  onFocus
}: {
  id: string
  content: TiptapNodeT | null
  format: NovelFormat
  toolbar: boolean
  onFocus: ((editor: Editor) => void) | undefined
}): React.JSX.Element {
  const edit = useDocumentStore((s) => s.edit)
  const settings = useEditorSettings(format)
  const { sceneBreak } = settings
  const extensions = useMemo(
    () =>
      buildExtensions({
        sceneBreak,
        onSave: () => void useDocumentStore.getState().saveNow(),
        inlineTagNodeId: id
      }),
    [sceneBreak, id]
  )
  const ready = content !== null
  const tagsById = useTagStore((s) => s.byId)
  const [menu, setMenu] = useState<TokenMenu | null>(null)

  const editor = useEditor(
    {
      extensions,
      content: content ?? EMPTY_DOC,
      editable: ready,
      editorProps: {
        attributes: {
          class: toolbar ? 'ms-editor' : 'ms-editor ms-editor-region',
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': 'Document'
        }
      },
      onUpdate: ({ editor }) => edit(id, editor.getJSON()),
      // `useEditor` reads the latest `onFocus` on every call, so a changed callback is honoured.
      onFocus: ({ editor }) => onFocus?.(editor)
    },
    [extensions]
  )

  useEffect(() => {
    resyncInlineTags(editor.view.dom, tagsById)
  }, [editor, tagsById])

  const { error: ghostError } = useGhostTextController({
    editor,
    nodeId: id,
    active: toolbar && ready
  })

  useEffect(() => {
    const dom = editor.view.dom
    const onContextMenu = (event: MouseEvent): void => {
      const token =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>(INLINE_TAG_SELECTOR)
          : null
      if (!token) return
      event.preventDefault()
      setMenu({
        x: event.clientX,
        y: event.clientY,
        pos: editor.view.posAtDOM(token, 0),
        tagId: token.dataset.id ?? ''
      })
    }
    dom.addEventListener('contextmenu', onContextMenu)
    return () => dom.removeEventListener('contextmenu', onContextMenu)
  }, [editor])

  const onMenuSelect = (itemId: string): void => {
    if (!menu) return
    setMenu(null)
    if (itemId === 'remove') {
      const node = editor.state.doc.nodeAt(menu.pos)
      if (node?.type.name !== INLINE_TAG_NODE_TYPE) return
      editor
        .chain()
        .focus()
        .deleteRange({ from: menu.pos, to: menu.pos + node.nodeSize })
        .run()
    } else if (itemId === 'open-in-tag-manager') {
      const layout = useLayoutStore.getState()
      if (!layout.layout.sidebar.open) layout.toggle('sidebar')
      layout.setSidebarTab('tags')
      useTagStore.getState().requestSelection(menu.tagId)
    }
  }

  const tokenMenu = menu ? (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      items={TOKEN_MENU_ITEMS}
      onSelect={onMenuSelect}
      onClose={() => setMenu(null)}
    />
  ) : null

  if (!toolbar)
    return (
      <>
        <EditorContent editor={editor} className={`${COLUMN} py-6`} />
        {tokenMenu}
      </>
    )
  // The column and the surface inside it are flex items, so an empty document still fills the
  // scroll container (click anywhere to write) without a viewport-relative minimum height.
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" style={editorStyle(settings)}>
      <Toolbar
        editor={ready ? editor : null}
        right={
          <>
            <VibeWriteToggle error={ghostError} />
            <NotesToggleButton />
          </>
        }
      />
      <TagBar id={id} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <EditorContent editor={editor} className={`${COLUMN} flex flex-1 flex-col py-6`} />
      </div>
      <DocumentStatusBar id={id} editor={ready ? editor : null} />
      {tokenMenu}
    </div>
  )
}

/**
 * The status bar of a single document (F-3.3): counts the editor's current content live, with
 * the same `countWords` main caches on save, so the figure never waits for the autosave. While
 * the document is still loading the tree's saved count stands in. The session delta is measured
 * from the tree's baseline, so a document created this session counts as all new.
 */
function DocumentStatusBar({
  id,
  editor
}: {
  id: string
  editor: Editor | null
}): React.JSX.Element {
  const saved = useTreeStore((s) => s.wordCountRollup[id] ?? 0)
  const baseline = useTreeStore((s) => s.sessionBaseline[id] ?? 0)
  const live = useLiveWordCount(editor)
  const words = live ?? saved
  return <StatusBar words={words} delta={words - baseline} />
}

/**
 * The editor's word count, recounted only when the document changes: the snapshot is cached by
 * the ProseMirror document's identity, which selection-only transactions leave untouched, so a
 * long scene is never re-serialized on a caret move. Null without an editor.
 */
function useLiveWordCount(editor: Editor | null): number | null {
  const cache = useRef<{ doc: unknown; count: number } | null>(null)
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!editor) return () => undefined
      editor.on('update', notify)
      return () => {
        editor.off('update', notify)
      }
    },
    [editor]
  )
  const getSnapshot = useCallback(() => {
    if (!editor) return null
    const doc: unknown = editor.state.doc
    const hit = cache.current
    if (hit !== null && hit.doc === doc) return hit.count
    const fresh = { doc, count: countWords(editor.getJSON()) }
    cache.current = fresh
    return fresh.count
  }, [editor])
  return useSyncExternalStore(subscribe, getSnapshot)
}
