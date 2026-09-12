import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { Editor } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import type { NovelFormat } from '@shared/ipc/contract'
import { EMPTY_DOC, type TiptapNodeT } from '@shared/tiptap'
import { countWords } from '@shared/wordCount'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { COLUMN, editorStyle } from './column'
import { useDocumentStore } from './documentStore'
import { EditorSettingsPanel } from './EditorSettingsPanel'
import { buildExtensions } from './extensions'
import { NotesToggleButton } from './NotesPanel'
import { useEditorSettings } from './settingsStore'
import { StatusBar } from './StatusBar'
import { Toolbar } from './Toolbar'

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

/**
 * One editor instance for one loaded document; `content === null` is the read-only loading
 * state. The formatting settings (F-3.6) apply live: five of them are custom properties on the
 * pane (no remount); the scene-break text is an extension option, so changing it rebuilds the
 * editor instance. `content` is the store's latest text (every edit lands there), and
 * `useEditor` reads it only when it constructs an instance, so the rebuild starts from the
 * author's unsaved typing and a keystroke never resets the editor.
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
    () => buildExtensions({ sceneBreak, onSave: () => void useDocumentStore.getState().saveNow() }),
    [sceneBreak]
  )
  const ready = content !== null

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

  const body = <EditorContent editor={editor} className={`${COLUMN} py-6`} />
  if (!toolbar) return body
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" style={editorStyle(settings)}>
      <Toolbar
        editor={ready ? editor : null}
        right={
          <>
            <NotesToggleButton />
            <EditorSettingsPanel format={format} />
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
      <DocumentStatusBar id={id} editor={ready ? editor : null} />
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
